'use strict';

// Location-aware purchase flow for Mahan Cloud.
// This preload is intentionally registered before mahan-patch.js. It handles
// location/plan/buy callbacks first, so the legacy single catalog cache cannot
// leak a plan from one Hetzner region into another region.
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const Database = require('./db');
const { CoreApi, CoreApiError } = require('./core-api');

const db = new Database(config.dbPath);
const api = new CoreApi(config.upstream);
const cache = new Map();
const CACHE_MS = 5 * 60_000;

const locationLabels = {
  nbg1: '🇩🇪 آلمان • نورنبرگ',
  fsn1: '🇩🇪 آلمان • فالکن‌اشتاین',
  hel1: '🇫🇮 فنلاند • هلسینکی',
  ash: '🇺🇸 آمریکا • اشبرن',
  hil: '🇺🇸 آمریکا • هیلزبورو',
  sin: '🇸🇬 سنگاپور'
};

function money(value) {
  return `${Math.round(Number(value || 0)).toLocaleString('fa-IR')} ${config.currencyLabel}`;
}
function durationFa(value) { return value === 'hourly' ? 'ساعتی' : 'ماهانه'; }
function cycleMs(value) { return value === 'hourly' ? 3600_000 : 30 * 24 * 3600_000; }
function locLabel(value) { return locationLabels[value] || String(value || '').toUpperCase(); }
function specs(plan, compact = false) {
  const values = [];
  if (plan?.cores) values.push(compact ? `${plan.cores}C` : `${plan.cores} vCPU`);
  if (plan?.memory) values.push(compact ? `${plan.memory}G` : `${plan.memory}GB RAM`);
  if (plan?.disk) values.push(compact ? `${plan.disk}G` : `${plan.disk}GB Disk`);
  return values.join(compact ? '/' : ' • ') || String(plan?.label || plan?.id || '—');
}
function upstreamPrice(plan, duration) {
  return Number(duration === 'hourly'
    ? (plan?.amount_hourly ?? plan?.hourly_price_toman ?? plan?.price)
    : (plan?.amount_monthly ?? plan?.monthly_toman ?? plan?.monthly_price_toman));
}
function legacyHourly(base) {
  const raw = Number(base || 0) * (1 + config.catalog.markupPercent / 100) + config.catalog.markupFixed;
  return Math.ceil(raw / config.catalog.roundTo) * config.catalog.roundTo;
}
function friendlyError(error) {
  if (!(error instanceof CoreApiError)) return 'خطای داخلی رخ داد. دوباره تلاش کنید.';
  if (error.code === 'UNSUPPORTED_LOCATION' || /unsupported location for server type/i.test(String(error.message || ''))) {
    return 'این پلن در لوکیشن انتخابی قابل ارائه نیست. لطفاً پلن دیگری انتخاب کنید.';
  }
  if (error.code === 'HETZNER_PLACEMENT_UNAVAILABLE') return 'این پلن در لوکیشن انتخابی موقتاً ظرفیت ندارد.';
  if (error.code === 'NOT_ALLOWED') return 'این لوکیشن یا پلن برای حساب فروشگاه فعال نیست.';
  if (error.code === 'INSUFFICIENT_WALLET') return 'موجودی حساب تأمین‌کننده کافی نیست؛ مدیریت مطلع شد.';
  return error.message || 'عملیات انجام نشد.';
}

async function setting(key, fallback = '') {
  const row = await db.get('SELECT value FROM app_settings WHERE key=?', [key]).catch(() => null);
  return row ? row.value : fallback;
}
async function override(planId, duration) {
  const row = await db.get(
    'SELECT final_price FROM price_overrides WHERE plan_id=? AND duration=?',
    [String(planId).toLowerCase(), duration]
  ).catch(() => null);
  return row ? Number(row.final_price) : null;
}
async function finalPrice(plan, duration) {
  const custom = await override(plan.id, duration);
  if (custom > 0) return custom;
  const base = upstreamPrice(plan, duration);
  if (duration === 'monthly') return Math.round(base + Number(await setting('monthly_markup', '450000')));
  return Math.round(legacyHourly(base) + Number(await setting('hourly_extra', '500')));
}

async function plansFor(location, force = false) {
  const key = String(location || '').trim().toLowerCase();
  if (!key) return [];
  const current = cache.get(key);
  if (!force && current && Date.now() - current.at < CACHE_MS) return current.plans;

  const response = await api.prices(key);
  let list = Array.isArray(response?.plans)
    ? response.plans.filter(plan => plan && plan.available !== false)
    : [];
  if (config.catalog.allowedPlans.size) {
    list = list.filter(plan => config.catalog.allowedPlans.has(String(plan.id || '').toLowerCase()));
  }
  list = list.slice(0, config.catalog.maxVisiblePlans);
  cache.set(key, { at: Date.now(), plans: list });
  return list;
}
async function findPlan(location, planId, force = false) {
  const id = String(planId || '').toLowerCase();
  let plan = (await plansFor(location, force)).find(item => String(item.id || '').toLowerCase() === id);
  if (!plan && !force) {
    plan = (await plansFor(location, true)).find(item => String(item.id || '').toLowerCase() === id);
  }
  return plan || null;
}

async function editOrSend(bot, q, text, keyboard) {
  const options = { reply_markup: { inline_keyboard: keyboard } };
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;
  const edited = await bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    ...options
  }).then(() => true).catch(() => false);
  if (!edited) await bot.sendMessage(chatId, text, options);
}

async function showPlans(bot, q, duration, location) {
  const validDuration = ['hourly', 'monthly'].includes(duration) ? duration : 'monthly';
  const validLocation = String(location || '').trim().toLowerCase();
  const list = (await plansFor(validLocation)).filter(plan => upstreamPrice(plan, validDuration) > 0);

  if (!list.length) {
    await bot.answerCallbackQuery(q.id).catch(() => {});
    return editOrSend(
      bot,
      q,
      `📍 ${locLabel(validLocation)}\n\nدر حال حاضر پلن قابل ارائه‌ای برای این لوکیشن پیدا نشد. لطفاً لوکیشن دیگری را انتخاب کنید.`,
      [[{ text: '↩️ انتخاب لوکیشن', callback_data: `plans:${validDuration}:0` }], [{ text: '🏠 منوی اصلی', callback_data: 'home' }]]
    );
  }

  const rows = [];
  for (const plan of list) {
    rows.push([{
      text: `${String(plan.id).toUpperCase()} • ${specs(plan, true)} • ${money(await finalPrice(plan, validDuration))}`,
      callback_data: `mxplan:${validDuration}:${validLocation}:${plan.id}`
    }]);
  }
  rows.push([
    { text: validDuration === 'monthly' ? '✅ ماهانه' : 'ماهانه', callback_data: `mxloc:monthly:${validLocation}` },
    { text: validDuration === 'hourly' ? '✅ ساعتی' : 'ساعتی', callback_data: `mxloc:hourly:${validLocation}` }
  ]);
  rows.push([{ text: `📍 ${locLabel(validLocation)}`, callback_data: `locations:${validDuration}:0` }]);
  rows.push([{ text: '🏠 منوی اصلی', callback_data: 'home' }]);

  await bot.answerCallbackQuery(q.id).catch(() => {});
  return editOrSend(
    bot,
    q,
    `🛒 انتخاب پلن\n\n📍 ${locLabel(validLocation)}\nنوع پرداخت: ${durationFa(validDuration)}\nفقط پلن‌های قابل ساخت در همین لوکیشن نمایش داده می‌شوند.`,
    rows
  );
}

async function showPlan(bot, q, duration, location, planId) {
  const validDuration = ['hourly', 'monthly'].includes(duration) ? duration : 'monthly';
  const validLocation = String(location || '').trim().toLowerCase();
  const plan = await findPlan(validLocation, planId);
  await bot.answerCallbackQuery(q.id).catch(() => {});
  if (!plan || !(upstreamPrice(plan, validDuration) > 0)) {
    cache.delete(validLocation);
    return bot.sendMessage(
      q.message.chat.id,
      `⚠️ این پلن در ${locLabel(validLocation)} قابل ارائه نیست. لطفاً از لیست پلن‌های همین لوکیشن انتخاب کنید.`,
      { reply_markup: { inline_keyboard: [[{ text: '↩️ مشاهده پلن‌های معتبر', callback_data: `mxloc:${validDuration}:${validLocation}` }]] } }
    );
  }

  const sale = await finalPrice(plan, validDuration);
  const text = `🧾 جزئیات سفارش\n\n${String(plan.id).toUpperCase()}\n⚙️ ${specs(plan)}\n🗓 دوره: ${durationFa(validDuration)}\n📍 لوکیشن: ${locLabel(validLocation)}\n💵 قیمت نهایی: ${money(sale)}\n💿 سیستم‌عامل: ${config.catalog.defaultImage}\n\nقبل از کسر موجودی، اعتبار پلن برای همین لوکیشن دوباره بررسی می‌شود.`;
  return editOrSend(bot, q, text, [
    [{ text: `✅ تأیید و پرداخت ${money(sale)}`, callback_data: `mxbuy:${validDuration}:${validLocation}:${plan.id}` }],
    [{ text: '↩️ بازگشت', callback_data: `mxloc:${validDuration}:${validLocation}` }]
  ]);
}

async function buy(bot, q, duration, location, planId) {
  const validDuration = ['hourly', 'monthly'].includes(duration) ? duration : 'monthly';
  const validLocation = String(location || '').trim().toLowerCase();
  const userId = String(q.from.id);
  const chatId = q.message.chat.id;

  // Reuse the location-scoped cache; POST /servers validates the exact location again before provisioning.
  const plan = await findPlan(validLocation, planId);
  if (!plan || !(upstreamPrice(plan, validDuration) > 0)) {
    cache.delete(validLocation);
    await bot.answerCallbackQuery(q.id, { text: 'این پلن در لوکیشن انتخابی قابل ارائه نیست.', show_alert: true }).catch(() => {});
    return bot.sendMessage(
      chatId,
      `⚠️ سفارش انجام نشد و هیچ مبلغی کسر نشد.\n\n${String(planId || '').toUpperCase()} در ${locLabel(validLocation)} قابل ارائه نیست. لطفاً پلن دیگری انتخاب کنید.`,
      { reply_markup: { inline_keyboard: [[{ text: '↩️ پلن‌های معتبر', callback_data: `mxloc:${validDuration}:${validLocation}` }]] } }
    );
  }

  const base = upstreamPrice(plan, validDuration);
  const sale = await finalPrice(plan, validDuration);
  if (!(base > 0 && sale > 0)) {
    await bot.answerCallbackQuery(q.id, { text: 'قیمت این پلن قابل محاسبه نیست.', show_alert: true }).catch(() => {});
    return;
  }

  if (!await db.debitIfEnough(userId, sale)) {
    await bot.answerCallbackQuery(q.id).catch(() => {});
    return bot.sendMessage(chatId, `❌ موجودی کافی نیست.\nمبلغ سفارش: ${money(sale)}`, {
      reply_markup: { inline_keyboard: [[{ text: '➕ شارژ حساب', callback_data: 'topup' }]] }
    });
  }

  await bot.answerCallbackQuery(q.id, { text: 'در حال ثبت سفارش…' }).catch(() => {});
  const statusMessage = await bot.sendMessage(chatId, '⏳ سفارش ثبت شد؛ در حال ایجاد سرور…');
  try {
    const result = await api.createServer({
      server_type: String(plan.id),
      duration: validDuration,
      image: config.catalog.defaultImage,
      location: validLocation,
      name: `c${userId}-${Date.now()}`
    });
    const server = result?.server || {};
    if (!server.id) throw new Error('upstream did not return server id');

    const next = new Date(Date.now() + cycleMs(validDuration)).toISOString();
    await db.run(
      `INSERT INTO servers(server_id,owner_id,plan_id,duration,sale_price,upstream_price,status,public_ip,location,next_billing_at,billing_state)\n       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [String(server.id), userId, String(plan.id), validDuration, sale, base, server.status || 'provisioning', server.public_ip || null, validLocation, next, 'active']
    );
    await bot.editMessageText(
      `✅ سفارش ثبت شد.\n\nشناسه: #${String(server.id).slice(-8)}\nپلن: ${String(plan.id).toUpperCase()} • ${specs(plan)}\n📍 ${locLabel(validLocation)}\nمبلغ: ${money(sale)}\nتمدید بعدی: ${new Date(next).toLocaleString('fa-IR')}\n\nبعد از آماده‌شدن IP و رمز ارسال می‌شود.`,
      { chat_id: chatId, message_id: statusMessage.message_id }
    );
  } catch (error) {
    await db.credit(userId, sale);
    const staleLocation = error instanceof CoreApiError && (
      error.code === 'UNSUPPORTED_LOCATION' ||
      /unsupported location for server type/i.test(String(error.message || ''))
    );
    if (staleLocation) cache.delete(validLocation);
    await bot.editMessageText(
      `❌ ساخت سرور انجام نشد و مبلغ کامل به کیف پول برگشت داده شد.\n\n${friendlyError(error)}${staleLocation ? '\n\nلیست این لوکیشن تازه‌سازی شد؛ لطفاً دوباره پلن را انتخاب کنید.' : ''}`,
      {
        chat_id: chatId,
        message_id: statusMessage.message_id,
        reply_markup: staleLocation ? { inline_keyboard: [[{ text: '🔄 پلن‌های معتبر این لوکیشن', callback_data: `mxloc:${validDuration}:${validLocation}` }]] } : undefined
      }
    );
  }
}

async function handle(bot, q) {
  const data = String(q?.data || '');
  let match;
  if ((match = data.match(/^mxloc:(hourly|monthly):([^:]+)$/))) {
    await showPlans(bot, q, match[1], match[2]);
    return true;
  }
  if ((match = data.match(/^mxplan:(hourly|monthly):([^:]+):(.+)$/))) {
    await showPlan(bot, q, match[1], match[2], match[3]);
    return true;
  }
  if ((match = data.match(/^mxbuy:(hourly|monthly):([^:]+):(.+)$/))) {
    await buy(bot, q, match[1], match[2], match[3]);
    return true;
  }
  return false;
}

const originalOn = TelegramBot.prototype.on;
TelegramBot.prototype.on = function mahanLocationCatalogOn(event, listener) {
  if (event !== 'callback_query') return originalOn.call(this, event, listener);
  const bot = this;
  return originalOn.call(this, event, async q => {
    try {
      if (await handle(bot, q)) return;
    } catch (error) {
      console.error('[mahan-location-catalog]', error);
      const text = friendlyError(error);
      await bot.answerCallbackQuery(q.id, { text, show_alert: true }).catch(() => {});
    }
    return listener(q);
  });
};
