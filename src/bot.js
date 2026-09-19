'use strict';

const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const Database = require('./db');
const { CoreApi, CoreApiError } = require('./core-api');

const bot = new TelegramBot(config.botToken, { polling: true });
const db = new Database(config.dbPath);
const api = new CoreApi(config.upstream);
const states = new Map();
let planCache = { at: 0, plans: [] };
let watcherRunning = false;

function isAdmin(id) { return config.adminIds.has(String(id)); }
function faDigitsToEn(value) {
  const map = { '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9', '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };
  return String(value || '').replace(/[۰-۹٠-٩]/g, c => map[c] || c);
}
function parseAmount(value) {
  const cleaned = faDigitsToEn(value).replace(/[,_\s،]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
function money(value) { return `${Math.round(Number(value || 0)).toLocaleString('fa-IR')} ${config.currencyLabel}`; }
function shortId(id) { return String(id).slice(-8); }
function safeText(value) { return String(value ?? '').replace(/[<>]/g, ''); }
function apiErrorText(error) {
  if (!(error instanceof CoreApiError)) return 'خطای داخلی رخ داد. لطفاً دوباره تلاش کنید.';
  switch (error.code) {
    case 'INSUFFICIENT_WALLET': return 'موجودی حساب تأمین‌کننده برای ساخت سرور کافی نیست. لطفاً با پشتیبانی تماس بگیرید.';
    case 'SERVER_LIMIT_REACHED': return 'ظرفیت ساخت سرور این فروشگاه فعلاً تکمیل است. لطفاً با پشتیبانی تماس بگیرید.';
    case 'INVALID_PLAN': return 'این پلن دیگر قابل سفارش نیست. لیست پلن‌ها را دوباره باز کنید.';
    case 'HETZNER_PLACEMENT_UNAVAILABLE': return 'ظرفیت این پلن در لوکیشن انتخابی موقتاً موجود نیست.';
    case 'NETWORK_ERROR': return 'ارتباط با سرویس اصلی برقرار نشد. چند لحظه دیگر دوباره تلاش کنید.';
    default: return error.message || 'انجام عملیات ممکن نشد.';
  }
}
function mainKeyboard() {
  return { inline_keyboard: [
    [{ text: '🛒 خرید سرور', callback_data: `plans:${config.catalog.defaultDuration}:0` }],
    [{ text: '🖥 سرورهای من', callback_data: 'myservers' }, { text: '💳 کیف پول', callback_data: 'wallet' }],
    [{ text: '➕ شارژ حساب', callback_data: 'topup' }, { text: '💬 پشتیبانی', callback_data: 'support' }]
  ] };
}
async function sendHome(chatId, user) {
  const current = user || await db.getUser(chatId);
  const balance = current?.balance || 0;
  await bot.sendMessage(chatId, `☁️ ${config.brandName}\n\nاز منوی زیر سرویس موردنظر را انتخاب کنید.\n💳 موجودی شما: ${money(balance)}`, { reply_markup: mainKeyboard() });
}
function applyMarkup(base) {
  const raw = Number(base || 0) * (1 + config.catalog.markupPercent / 100) + config.catalog.markupFixed;
  return Math.ceil(raw / config.catalog.roundTo) * config.catalog.roundTo;
}
function upstreamPlanPrice(plan, duration) {
  return Number(duration === 'hourly'
    ? (plan.amount_hourly ?? plan.hourly_price_toman ?? plan.price)
    : (plan.amount_monthly ?? plan.monthly_toman ?? plan.monthly_price_toman));
}
async function getPlans(force = false) {
  if (!force && planCache.plans.length && Date.now() - planCache.at < 60000) return planCache.plans;
  const out = await api.prices();
  let plans = Array.isArray(out.plans) ? out.plans.filter(p => p && p.available !== false) : [];
  if (config.catalog.allowedPlans.size) plans = plans.filter(p => config.catalog.allowedPlans.has(String(p.id || '').toLowerCase()));
  plans = plans.slice(0, config.catalog.maxVisiblePlans);
  planCache = { at: Date.now(), plans };
  return plans;
}
async function findPlan(planId) {
  const plans = await getPlans();
  let plan = plans.find(p => String(p.id) === String(planId));
  if (!plan) {
    const fresh = await getPlans(true);
    plan = fresh.find(p => String(p.id) === String(planId));
  }
  return plan || null;
}
function planTitle(plan) {
  if (plan.cores || plan.memory || plan.disk) return `${String(plan.id).toUpperCase()} • ${plan.cores || '?'} vCPU • ${plan.memory || '?'}GB RAM • ${plan.disk || '?'}GB`;
  return safeText(plan.label || plan.id);
}
async function showPlans(chatId, duration = 'monthly', page = 0, messageId = null) {
  const plans = await getPlans();
  const valid = ['hourly', 'monthly'].includes(duration) ? duration : config.catalog.defaultDuration;
  const priced = plans.filter(p => Number.isFinite(upstreamPlanPrice(p, valid)) && upstreamPlanPrice(p, valid) > 0);
  const perPage = 6;
  const pages = Math.max(1, Math.ceil(priced.length / perPage));
  const current = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  const slice = priced.slice(current * perPage, current * perPage + perPage);
  const keyboard = slice.map(plan => [{ text: `${String(plan.id).toUpperCase()} — ${money(applyMarkup(upstreamPlanPrice(plan, valid)))}`, callback_data: `plan:${valid}:${plan.id}` }]);
  keyboard.push([
    { text: valid === 'monthly' ? '✅ ماهانه' : 'ماهانه', callback_data: `plans:monthly:${current}` },
    { text: valid === 'hourly' ? '✅ ساعتی' : 'ساعتی', callback_data: `plans:hourly:${current}` }
  ]);
  if (pages > 1) keyboard.push([
    { text: '◀️', callback_data: `plans:${valid}:${Math.max(0, current - 1)}` },
    { text: `${current + 1}/${pages}`, callback_data: 'noop' },
    { text: '▶️', callback_data: `plans:${valid}:${Math.min(pages - 1, current + 1)}` }
  ]);
  keyboard.push([{ text: '🏠 منوی اصلی', callback_data: 'home' }]);
  const text = `🛒 انتخاب پلن\n\nنوع پرداخت: ${valid === 'monthly' ? 'ماهانه' : 'ساعتی'}\nقیمت نهایی هر پلن روی دکمه نمایش داده شده است.`;
  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } }).catch(async () => {
      await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
    });
  } else {
    await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}
async function showPlan(chatId, duration, planId, messageId) {
  const plan = await findPlan(planId);
  if (!plan) return bot.sendMessage(chatId, 'این پلن دیگر موجود نیست. لطفاً لیست پلن‌ها را تازه کنید.');
  const base = upstreamPlanPrice(plan, duration);
  const sale = applyMarkup(base);
  const text = `🧾 جزئیات سفارش\n\n${planTitle(plan)}\n🗓 دوره: ${duration === 'monthly' ? 'ماهانه' : 'ساعتی'}\n💵 قیمت: ${money(sale)}\n💿 سیستم‌عامل: ${config.catalog.defaultImage}\n📍 لوکیشن: ${config.catalog.defaultLocation}\n\nبعد از تأیید، مبلغ از کیف پول شما کسر و ساخت سرور شروع می‌شود.`;
  const keyboard = { inline_keyboard: [
    [{ text: `✅ تأیید و پرداخت ${money(sale)}`, callback_data: `buy:${duration}:${plan.id}` }],
    [{ text: '↩️ بازگشت', callback_data: `plans:${duration}:0` }]
  ] };
  if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: keyboard }).catch(() => bot.sendMessage(chatId, text, { reply_markup: keyboard }));
  else await bot.sendMessage(chatId, text, { reply_markup: keyboard });
}
async function purchaseServer(query, duration, planId) {
  const userId = String(query.from.id);
  const chatId = query.message.chat.id;
  const plan = await findPlan(planId);
  if (!plan) return bot.sendMessage(chatId, 'پلن انتخاب‌شده دیگر موجود نیست.');
  const base = upstreamPlanPrice(plan, duration);
  if (!Number.isFinite(base) || base <= 0) return bot.sendMessage(chatId, 'قیمت این پلن در حال حاضر قابل محاسبه نیست.');
  const sale = applyMarkup(base);
  const debited = await db.debitIfEnough(userId, sale);
  if (!debited) {
    return bot.sendMessage(chatId, `❌ موجودی کافی نیست.\nمبلغ سفارش: ${money(sale)}`, { reply_markup: { inline_keyboard: [[{ text: '➕ شارژ حساب', callback_data: 'topup' }]] } });
  }
  await bot.answerCallbackQuery(query.id, { text: 'در حال ثبت سفارش…' }).catch(() => {});
  const processing = await bot.sendMessage(chatId, '⏳ سفارش ثبت شد؛ در حال ایجاد سرور…');
  try {
    const result = await api.createServer({
      server_type: String(plan.id),
      duration,
      image: config.catalog.defaultImage,
      location: config.catalog.defaultLocation,
      name: `c${userId}-${Date.now()}`
    });
    const server = result.server || {};
    if (!server.id) throw new Error('upstream did not return server id');
    await db.addServer({
      serverId: server.id,
      ownerId: userId,
      planId: String(plan.id),
      duration,
      salePrice: sale,
      upstreamPrice: base,
      status: server.status || 'provisioning',
      publicIp: server.public_ip || null
    });
    await bot.editMessageText(`✅ سفارش با موفقیت ثبت شد.\n\nشناسه: #${shortId(server.id)}\nپلن: ${String(plan.id).toUpperCase()}\nمبلغ: ${money(sale)}\n\nبه محض آماده شدن، IP و رمز root همینجا ارسال می‌شود.`, { chat_id: chatId, message_id: processing.message_id });
  } catch (error) {
    await db.credit(userId, sale);
    await bot.editMessageText(`❌ ساخت سرور انجام نشد و مبلغ به کیف پول شما برگشت.\n\n${apiErrorText(error)}`, { chat_id: chatId, message_id: processing.message_id });
  }
}
async function showWallet(chatId, userId) {
  const user = await db.getUser(userId);
  await bot.sendMessage(chatId, `💳 کیف پول\n\nموجودی: ${money(user?.balance || 0)}`, { reply_markup: { inline_keyboard: [[{ text: '➕ شارژ حساب', callback_data: 'topup' }], [{ text: '🏠 منوی اصلی', callback_data: 'home' }]] } });
}
async function startTopup(chatId, userId) {
  states.set(String(userId), { type: 'topup_amount' });
  const cardLines = [];
  if (config.payment.card) cardLines.push(`💳 کارت: ${config.payment.card}`);
  if (config.payment.cardHolder) cardLines.push(`👤 به نام: ${config.payment.cardHolder}`);
  await bot.sendMessage(chatId, `➕ شارژ حساب\n\nحداقل مبلغ: ${money(config.payment.minTopup)}\n${cardLines.join('\n')}\n\nمبلغ موردنظر را به تومان ارسال کنید.\nبرای لغو: /cancel`);
}
async function notifyAdminsTopup(request, user) {
  for (const adminId of config.adminIds) {
    if (request.receipt_chat_id && request.receipt_message_id) {
      await bot.forwardMessage(adminId, request.receipt_chat_id, request.receipt_message_id).catch(() => {});
    }
    const name = user?.username ? `@${user.username}` : (user?.first_name || request.telegram_id);
    await bot.sendMessage(adminId, `💰 درخواست شارژ #${request.id}\nکاربر: ${name}\nID: ${request.telegram_id}\nمبلغ: ${money(request.amount)}`, { reply_markup: { inline_keyboard: [[
      { text: '✅ تأیید', callback_data: `topok:${request.id}` },
      { text: '❌ رد', callback_data: `topno:${request.id}` }
    ]] } }).catch(() => {});
  }
}
async function showMyServers(chatId, userId) {
  const servers = await db.listUserServers(userId);
  if (!servers.length) return bot.sendMessage(chatId, 'هنوز سروری ندارید.', { reply_markup: { inline_keyboard: [[{ text: '🛒 خرید سرور', callback_data: `plans:${config.catalog.defaultDuration}:0` }], [{ text: '🏠 منوی اصلی', callback_data: 'home' }]] } });
  const keyboard = servers.slice(0, 30).map(s => [{ text: `🖥 ${String(s.plan_id).toUpperCase()} • #${shortId(s.server_id)} • ${s.status}`, callback_data: `srv:${s.server_id}` }]);
  keyboard.push([{ text: '🏠 منوی اصلی', callback_data: 'home' }]);
  await bot.sendMessage(chatId, `🖥 سرورهای من\n\nتعداد: ${servers.length}`, { reply_markup: { inline_keyboard: keyboard } });
}
function serverProviderStatus(remote) {
  // The upstream purchase lifecycle is authoritative. It only becomes active
  // after the SSH/readiness and Iran IP-quality gate has passed. Falling back
  // to the raw provider status is only for legacy responses that do not expose
  // a lifecycle status.
  const lifecycleStatus = String(remote?.server?.status || '').trim().toLowerCase();
  if (lifecycleStatus) return lifecycleStatus;
  return String(remote?.provider?.status || '').trim().toLowerCase();
}
async function showServer(chatId, userId, serverId, messageId = null) {
  const local = await db.getOwnedServer(serverId, userId);
  if (!local) return bot.sendMessage(chatId, 'این سرور برای حساب شما پیدا نشد.');
  let remote = null;
  try { remote = await api.getServer(serverId); } catch (_) {}
  const providerStatus = serverProviderStatus(remote) || local.status;
  const ip = remote?.provider?.public_ip || local.public_ip || 'در حال دریافت';
  await db.updateServerState(serverId, { status: providerStatus, publicIp: ip === 'در حال دریافت' ? local.public_ip : ip }).catch(() => {});
  const text = `🖥 سرور #${shortId(serverId)}\n\nپلن: ${String(local.plan_id).toUpperCase()}\nوضعیت: ${providerStatus || 'نامشخص'}\nIP: ${ip}\nدوره: ${local.duration === 'monthly' ? 'ماهانه' : 'ساعتی'}\nقیمت خرید: ${money(local.sale_price)}`;
  const keyboard = { inline_keyboard: [
    [{ text: '▶️ روشن', callback_data: `srvon:${serverId}` }, { text: '⏹ خاموش', callback_data: `srvoff:${serverId}` }],
    [{ text: '🔑 تغییر رمز root', callback_data: `srvpass:${serverId}` }, { text: '📊 ترافیک', callback_data: `srvtraffic:${serverId}` }],
    [{ text: '🔄 بروزرسانی', callback_data: `srv:${serverId}` }],
    [{ text: '🗑 حذف سرور', callback_data: `srvdelq:${serverId}` }],
    [{ text: '↩️ سرورهای من', callback_data: 'myservers' }]
  ] };
  if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: keyboard }).catch(() => bot.sendMessage(chatId, text, { reply_markup: keyboard }));
  else await bot.sendMessage(chatId, text, { reply_markup: keyboard });
}
async function ownedServerOrReply(chatId, userId, serverId) {
  const server = await db.getOwnedServer(serverId, userId);
  if (!server) await bot.sendMessage(chatId, 'سرور پیدا نشد یا متعلق به این حساب نیست.');
  return server;
}
async function runServerAction(query, action, successText) {
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  const serverId = String(query.data.split(':')[1] || '');
  if (!await ownedServerOrReply(chatId, userId, serverId)) return;
  try {
    await action(serverId);
    await bot.answerCallbackQuery(query.id, { text: successText }).catch(() => {});
    await showServer(chatId, userId, serverId, query.message.message_id);
  } catch (error) {
    await bot.answerCallbackQuery(query.id, { text: apiErrorText(error), show_alert: true }).catch(() => {});
  }
}
async function showSupport(chatId) {
  const text = config.supportUsername ? `💬 پشتیبانی: @${config.supportUsername}` : '💬 برای پشتیبانی با مدیر فروشگاه در تماس باشید.';
  const keyboard = config.supportUsername ? { inline_keyboard: [[{ text: 'باز کردن پشتیبانی', url: `https://t.me/${config.supportUsername}` }], [{ text: '🏠 منوی اصلی', callback_data: 'home' }]] } : mainKeyboard();
  await bot.sendMessage(chatId, text, { reply_markup: keyboard });
}
async function showAdmin(chatId) {
  const stats = await db.stats();
  let upstreamBalance = 'نامشخص';
  try { upstreamBalance = money((await api.wallet())?.wallet?.balance || 0); } catch (_) {}
  await bot.sendMessage(chatId, `🛠 پنل مدیریت\n\n👥 کاربران: ${stats.users}\n🖥 سرورهای فعال محلی: ${stats.servers}\n⏳ شارژهای در انتظار: ${stats.pendingTopups}\n💳 مجموع مانده مشتریان: ${money(stats.localBalance)}\n☁️ موجودی حساب تأمین: ${upstreamBalance}`, { reply_markup: { inline_keyboard: [[{ text: '⏳ شارژهای در انتظار', callback_data: 'admintopups' }], [{ text: '🔌 تست API', callback_data: 'adminapi' }]] } });
}
async function showPendingTopups(chatId) {
  const rows = await db.pendingTopups(20);
  if (!rows.length) return bot.sendMessage(chatId, 'درخواست شارژ در انتظاری وجود ندارد.');
  for (const row of rows) {
    const name = row.username ? `@${row.username}` : (row.first_name || row.telegram_id);
    await bot.sendMessage(chatId, `#${row.id} • ${name}\n${money(row.amount)}`, { reply_markup: { inline_keyboard: [[{ text: '✅ تأیید', callback_data: `topok:${row.id}` }, { text: '❌ رد', callback_data: `topno:${row.id}` }]] } });
  }
}
async function handleTopupReview(query, status, id) {
  if (!isAdmin(query.from.id)) return bot.answerCallbackQuery(query.id, { text: 'دسترسی ندارید.', show_alert: true });
  const out = await db.reviewTopup(id, status, query.from.id);
  if (!out.changed) return bot.answerCallbackQuery(query.id, { text: 'این درخواست قبلاً بررسی شده است.', show_alert: true });
  const req = out.request;
  await bot.answerCallbackQuery(query.id, { text: status === 'approved' ? 'تأیید شد' : 'رد شد' }).catch(() => {});
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
  await bot.sendMessage(req.telegram_id, status === 'approved'
    ? `✅ شارژ حساب تأیید شد.\nمبلغ ${money(req.amount)} به کیف پول شما اضافه شد.`
    : `❌ درخواست شارژ #${req.id} رد شد. در صورت نیاز با پشتیبانی تماس بگیرید.`).catch(() => {});
}
async function handleReceiptMessage(msg, state) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  if (state.type === 'topup_amount') {
    const amount = parseAmount(msg.text);
    if (!amount || amount < config.payment.minTopup) return bot.sendMessage(chatId, `مبلغ معتبر وارد کنید. حداقل شارژ ${money(config.payment.minTopup)} است.`);
    states.set(userId, { type: 'topup_receipt', amount });
    const cardLines = [];
    if (config.payment.card) cardLines.push(`💳 ${config.payment.card}`);
    if (config.payment.cardHolder) cardLines.push(`👤 ${config.payment.cardHolder}`);
    return bot.sendMessage(chatId, `مبلغ: ${money(amount)}\n${cardLines.join('\n')}\n\n${config.payment.note}\n\nرسید را به‌صورت عکس یا فایل ارسال کنید.`);
  }
  if (state.type === 'topup_receipt') {
    const hasReceipt = Array.isArray(msg.photo) || !!msg.document;
    if (!hasReceipt) return bot.sendMessage(chatId, 'لطفاً تصویر یا فایل رسید را ارسال کنید.');
    const request = await db.createTopup(userId, state.amount, chatId, msg.message_id);
    states.delete(userId);
    const user = await db.getUser(userId);
    await bot.sendMessage(chatId, `✅ رسید ثبت شد.\nشماره درخواست: #${request.id}\nبعد از بررسی ادمین نتیجه همینجا اعلام می‌شود.`);
    await notifyAdminsTopup(request, user);
  }
}
async function provisioningWatcher() {
  if (watcherRunning) return;
  watcherRunning = true;
  try {
    const rows = await db.pendingProvisioning();
    for (const row of rows) {
      try {
        let remote = null;
        try { remote = await api.getServer(row.server_id); } catch (error) {
          if (error instanceof CoreApiError && error.code === 'SERVER_NOT_FOUND') {
            await db.markDeleted(row.server_id);
          }
          continue;
        }
        const status = serverProviderStatus(remote) || row.status;
        const ip = remote?.provider?.public_ip || row.public_ip || null;
        await db.updateServerState(row.server_id, { status, publicIp: ip });
        const ready = ['running', 'active'].includes(status);
        if (!ready) continue;
        let password = row.pending_password;
        if (!password) {
          try {
            const reset = await api.resetPassword(row.server_id);
            password = reset.root_password;
            if (!password) continue;
            await db.savePendingPassword(row.server_id, password);
          } catch (_) { continue; }
        }
        try {
          await bot.sendMessage(row.owner_id, `✅ سرور شما آماده است.\n\n🖥 پلن: ${String(row.plan_id).toUpperCase()}\n🌐 IP: ${ip || 'نامشخص'}\n👤 User: root\n🔑 Password: ${password}\n\nرمز را در جای امن نگه دارید. هر زمان لازم باشد می‌توانید از بخش «سرورهای من» رمز جدید بسازید.`);
          await db.markCredentialsDelivered(row.server_id);
        } catch (_) {}
      } catch (error) {
        console.error('[watcher:item]', row.server_id, error.message || error);
      }
    }
  } catch (error) {
    console.error('[watcher]', error.message || error);
  } finally {
    watcherRunning = false;
  }
}

bot.onText(/^\/start(?:\s.*)?$/, async msg => {
  const user = await db.touchUser(msg.from);
  states.delete(String(msg.from.id));
  await sendHome(msg.chat.id, user);
});
bot.onText(/^\/menu$/, async msg => {
  const user = await db.touchUser(msg.from);
  await sendHome(msg.chat.id, user);
});
bot.onText(/^\/cancel$/, async msg => {
  states.delete(String(msg.from.id));
  await bot.sendMessage(msg.chat.id, 'عملیات لغو شد.');
  await sendHome(msg.chat.id, await db.touchUser(msg.from));
});
bot.onText(/^\/admin$/, async msg => {
  if (!isAdmin(msg.from.id)) return;
  await db.touchUser(msg.from);
  await showAdmin(msg.chat.id);
});
bot.onText(/^\/credit\s+(\d+)\s+([\d۰-۹٠-٩,_،]+)$/i, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const target = String(match[1]);
  const amount = parseAmount(match[2]);
  if (!amount) return bot.sendMessage(msg.chat.id, 'مبلغ نامعتبر است.');
  const user = await db.getUser(target);
  if (!user) return bot.sendMessage(msg.chat.id, 'کاربر هنوز /start نزده است.');
  await db.credit(target, amount);
  await bot.sendMessage(msg.chat.id, `✅ ${money(amount)} به کیف پول ${target} اضافه شد.`);
  await bot.sendMessage(target, `✅ ${money(amount)} توسط مدیریت به کیف پول شما اضافه شد.`).catch(() => {});
});

bot.on('message', async msg => {
  if (!msg.from || msg.chat.type !== 'private') return;
  await db.touchUser(msg.from).catch(() => {});
  if (String(msg.text || '').startsWith('/')) return;
  const state = states.get(String(msg.from.id));
  if (state) await handleReceiptMessage(msg, state).catch(error => console.error('[state]', error));
});

bot.on('callback_query', async query => {
  const data = String(query.data || '');
  const userId = String(query.from.id);
  const chatId = query.message?.chat?.id;
  if (!chatId) return;
  await db.touchUser(query.from).catch(() => {});
  try {
    if (data === 'noop') return bot.answerCallbackQuery(query.id).catch(() => {});
    if (data === 'home') { await bot.answerCallbackQuery(query.id).catch(() => {}); return sendHome(chatId, await db.getUser(userId)); }
    if (data === 'wallet') { await bot.answerCallbackQuery(query.id).catch(() => {}); return showWallet(chatId, userId); }
    if (data === 'topup') { await bot.answerCallbackQuery(query.id).catch(() => {}); return startTopup(chatId, userId); }
    if (data === 'support') { await bot.answerCallbackQuery(query.id).catch(() => {}); return showSupport(chatId); }
    if (data === 'myservers') { await bot.answerCallbackQuery(query.id).catch(() => {}); return showMyServers(chatId, userId); }
    if (data.startsWith('plans:')) {
      const [, duration, page] = data.split(':');
      await bot.answerCallbackQuery(query.id).catch(() => {});
      return showPlans(chatId, duration, Number(page), query.message.message_id);
    }
    if (data.startsWith('plan:')) {
      const [, duration, planId] = data.split(':');
      await bot.answerCallbackQuery(query.id).catch(() => {});
      return showPlan(chatId, duration, planId, query.message.message_id);
    }
    if (data.startsWith('buy:')) {
      const [, duration, planId] = data.split(':');
      return purchaseServer(query, duration, planId);
    }
    if (data.startsWith('srv:')) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      return showServer(chatId, userId, data.slice(4), query.message.message_id);
    }
    if (data.startsWith('srvon:')) return runServerAction(query, id => api.powerOn(id), 'درخواست روشن‌کردن ارسال شد');
    if (data.startsWith('srvoff:')) return runServerAction(query, id => api.powerOff(id), 'درخواست خاموش‌کردن ارسال شد');
    if (data.startsWith('srvpass:')) {
      const serverId = data.slice('srvpass:'.length);
      if (!await ownedServerOrReply(chatId, userId, serverId)) return;
      await bot.answerCallbackQuery(query.id, { text: 'در حال ساخت رمز جدید…' }).catch(() => {});
      try {
        const out = await api.resetPassword(serverId);
        await bot.sendMessage(chatId, `🔑 رمز جدید root\n\nServer: #${shortId(serverId)}\nPassword: ${out.root_password}\n\nرمز قبلی دیگر معتبر نیست.`);
      } catch (error) { await bot.sendMessage(chatId, apiErrorText(error)); }
      return;
    }
    if (data.startsWith('srvtraffic:')) {
      const serverId = data.slice('srvtraffic:'.length);
      if (!await ownedServerOrReply(chatId, userId, serverId)) return;
      await bot.answerCallbackQuery(query.id).catch(() => {});
      try {
        const t = (await api.traffic(serverId)).traffic || {};
        const gb = n => `${(Number(n || 0) / 1024 / 1024 / 1024).toFixed(2)} GB`;
        await bot.sendMessage(chatId, `📊 ترافیک سرور #${shortId(serverId)}\n\nمصرف: ${gb(t.used_bytes)}\nسقف: ${gb(t.included_bytes)}\nباقی‌مانده: ${gb(t.remaining_bytes)}\nاضافه‌مصرف: ${gb(t.overage_bytes)}`);
      } catch (error) { await bot.sendMessage(chatId, apiErrorText(error)); }
      return;
    }
    if (data.startsWith('srvdelq:')) {
      const serverId = data.slice('srvdelq:'.length);
      if (!await ownedServerOrReply(chatId, userId, serverId)) return;
      await bot.answerCallbackQuery(query.id).catch(() => {});
      return bot.sendMessage(chatId, `⚠️ حذف سرور #${shortId(serverId)} قطعی است و اطلاعات آن از بین می‌رود.\n\nاز حذف مطمئن هستید؟`, { reply_markup: { inline_keyboard: [[{ text: '🗑 بله، حذف کن', callback_data: `srvdel:${serverId}` }], [{ text: 'انصراف', callback_data: `srv:${serverId}` }]] } });
    }
    if (data.startsWith('srvdel:')) {
      const serverId = data.slice('srvdel:'.length);
      if (!await ownedServerOrReply(chatId, userId, serverId)) return;
      await bot.answerCallbackQuery(query.id, { text: 'در حال حذف…' }).catch(() => {});
      try {
        await api.deleteServer(serverId);
        await db.markDeleted(serverId);
        await bot.sendMessage(chatId, `✅ سرور #${shortId(serverId)} حذف شد.`);
      } catch (error) { await bot.sendMessage(chatId, apiErrorText(error)); }
      return;
    }
    if (data.startsWith('topok:')) return handleTopupReview(query, 'approved', Number(data.split(':')[1]));
    if (data.startsWith('topno:')) return handleTopupReview(query, 'rejected', Number(data.split(':')[1]));
    if (data === 'admintopups' && isAdmin(userId)) { await bot.answerCallbackQuery(query.id).catch(() => {}); return showPendingTopups(chatId); }
    if (data === 'adminapi' && isAdmin(userId)) {
      await bot.answerCallbackQuery(query.id, { text: 'در حال تست…' }).catch(() => {});
      try {
        const [me, wallet] = await Promise.all([api.me(), api.wallet()]);
        return bot.sendMessage(chatId, `✅ API متصل است.\nClient: ${safeText(me?.client?.name || me?.client?.id || 'OK')}\nUpstream wallet: ${money(wallet?.wallet?.balance || 0)}`);
      } catch (error) { return bot.sendMessage(chatId, `❌ API: ${apiErrorText(error)}`); }
    }
    await bot.answerCallbackQuery(query.id).catch(() => {});
  } catch (error) {
    console.error('[callback]', data, error);
    await bot.answerCallbackQuery(query.id, { text: 'خطایی رخ داد.', show_alert: true }).catch(() => {});
  }
});

bot.on('polling_error', error => console.error('[polling]', error.code || error.message));

async function bootstrap() {
  await db.init();
  try {
    await api.me();
    console.log('[startup] upstream API authenticated');
  } catch (error) {
    console.error('[startup] upstream API check failed:', error.code || error.message);
  }
  console.log(`[startup] ${config.brandName} bot is running`);
  setInterval(provisioningWatcher, config.provisionPollMs).unref();
  setTimeout(provisioningWatcher, 3000).unref();
}

async function shutdown(signal) {
  console.log(`[shutdown] ${signal}`);
  try { await bot.stopPolling(); } catch (_) {}
  await db.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

bootstrap().catch(error => {
  console.error('[fatal]', error);
  process.exit(1);
});
