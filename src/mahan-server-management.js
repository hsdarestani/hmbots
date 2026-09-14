'use strict';

const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const Database = require('./db');
const { CoreApi, CoreApiError } = require('./core-api');

const db = new Database(config.dbPath);
const api = new CoreApi(config.upstream);
let initialized = false;
let commandSetup = false;
let sourceSyncStarted = false;
let plansCache = { at: 0, plans: [] };
const actionLocks = new Set();

function money(value) { return `${Math.round(Number(value || 0)).toLocaleString('fa-IR')} ${config.currencyLabel}`; }
function shortId(value) { return String(value || '').slice(-8); }
function durationFa(value) { return value === 'hourly' ? 'ساعتی' : 'ماهانه'; }
function cycleMs(value) { return value === 'hourly' ? 3600_000 : 30 * 24 * 3600_000; }
function apiMessage(error) {
  if (!(error instanceof CoreApiError)) return 'خطای داخلی رخ داد. دوباره تلاش کنید.';
  if (error.code === 'OPERATION_IN_PROGRESS') return 'عملیات دیگری روی این سرور در حال انجام است. چند لحظه بعد دوباره تلاش کنید.';
  if (error.code === 'ARCHITECTURE_MISMATCH') return 'ارتقا بین معماری x86 و ARM امکان‌پذیر نیست.';
  if (error.code === 'INSUFFICIENT_WALLET') return 'موجودی حساب تأمین‌کننده کافی نیست؛ مدیریت مطلع شد.';
  return error.message || 'عملیات انجام نشد.';
}
function specs(plan, compact=false) {
  const values = [];
  if (plan?.cores) values.push(compact ? `${plan.cores}C` : `${plan.cores} vCPU`);
  if (plan?.memory) values.push(compact ? `${plan.memory}G` : `${plan.memory}GB RAM`);
  if (plan?.disk) values.push(compact ? `${plan.disk}G` : `${plan.disk}GB Disk`);
  return values.join(compact ? '/' : ' • ') || String(plan?.label || plan?.id || '—');
}
function architecture(planOrId) {
  const id = String(planOrId?.hetzner_type || planOrId?.id || planOrId || '').toLowerCase();
  if (id.startsWith('cax')) return 'arm';
  if (/^(cx|cpx|ccx)/.test(id)) return 'x86';
  return '';
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
async function setting(key, fallback='') {
  const row = await db.get('SELECT value FROM app_settings WHERE key=?', [key]).catch(() => null);
  return row ? row.value : fallback;
}
async function override(planId, duration) {
  const row = await db.get('SELECT final_price FROM price_overrides WHERE plan_id=? AND duration=?', [String(planId).toLowerCase(), duration]).catch(() => null);
  return row ? Number(row.final_price) : null;
}
async function finalPrice(plan, duration) {
  const custom = await override(plan.id, duration);
  if (custom > 0) return custom;
  const base = upstreamPrice(plan, duration);
  if (duration === 'monthly') return Math.round(base + Number(await setting('monthly_markup', '450000')));
  return Math.round(legacyHourly(base) + Number(await setting('hourly_extra', '500')));
}
async function plans(force=false) {
  if (!force && plansCache.plans.length && Date.now() - plansCache.at < 60_000) return plansCache.plans;
  const response = await api.prices();
  let list = Array.isArray(response.plans) ? response.plans.filter(p => p && p.available !== false) : [];
  if (config.catalog.allowedPlans.size) list = list.filter(p => config.catalog.allowedPlans.has(String(p.id || '').toLowerCase()));
  plansCache = { at: Date.now(), plans: list };
  return list;
}
async function findPlan(id) {
  let plan = (await plans()).find(p => String(p.id).toLowerCase() === String(id).toLowerCase());
  if (!plan) plan = (await plans(true)).find(p => String(p.id).toLowerCase() === String(id).toLowerCase());
  return plan || null;
}

async function init() {
  if (initialized) return;
  await db.init();
  await db.run(`CREATE TABLE IF NOT EXISTS mahan_paid_actions(
    event_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    action TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  for (const [key, value] of [['extra_ip_price','900000'],['extra_traffic_tb_price','300000']]) {
    await db.run(`INSERT OR IGNORE INTO app_settings(key,value) VALUES(?,?)`, [key, value]).catch(() => {});
  }
  initialized = true;
}

async function reserveCharge(eventKey, ownerId, serverId, action, amount) {
  await init();
  await db.run('BEGIN IMMEDIATE');
  try {
    const existing = await db.get('SELECT status FROM mahan_paid_actions WHERE event_key=?', [eventKey]);
    if (existing) {
      await db.run('COMMIT');
      return { ok: false, duplicate: true, status: existing.status };
    }
    const user = await db.getUser(ownerId);
    if (!user || Number(user.balance || 0) < amount) {
      await db.run('ROLLBACK');
      return { ok: false, insufficient: true, balance: Number(user?.balance || 0) };
    }
    await db.run('UPDATE users SET balance=balance-?, updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?', [amount, String(ownerId)]);
    await db.run(`INSERT INTO mahan_paid_actions(event_key,owner_id,server_id,action,amount,status) VALUES(?,?,?,?,?,'reserved')`, [eventKey,String(ownerId),String(serverId),action,amount]);
    await db.run('COMMIT');
    return { ok: true, balance: Number(user.balance || 0) - amount };
  } catch (error) {
    await db.run('ROLLBACK').catch(() => {});
    throw error;
  }
}
async function completeCharge(eventKey) {
  await db.run(`UPDATE mahan_paid_actions SET status='completed',updated_at=CURRENT_TIMESTAMP WHERE event_key=? AND status='reserved'`, [eventKey]);
}
async function refundCharge(eventKey) {
  await db.run('BEGIN IMMEDIATE');
  try {
    const row = await db.get(`SELECT * FROM mahan_paid_actions WHERE event_key=? AND status='reserved'`, [eventKey]);
    if (row) {
      await db.run('UPDATE users SET balance=balance+?,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?', [Number(row.amount),String(row.owner_id)]);
      await db.run(`UPDATE mahan_paid_actions SET status='refunded',updated_at=CURRENT_TIMESTAMP WHERE event_key=?`, [eventKey]);
    }
    await db.run('COMMIT');
  } catch (error) {
    await db.run('ROLLBACK').catch(() => {});
    throw error;
  }
}

function ensureCommands(bot) {
  if (commandSetup) return;
  commandSetup = true;
  setTimeout(() => bot.setMyCommands([
    { command: 'start', description: 'شروع و نمایش منوی اصلی' },
    { command: 'menu', description: 'نمایش منوی اصلی' },
    { command: 'admin', description: 'پنل مدیریت (ادمین)' },
    { command: 'cancel', description: 'لغو عملیات جاری' }
  ]).catch(error => console.warn('[mahan-commands]', error.message || error)), 700).unref();
}

async function syncSourceLabels() {
  if (sourceSyncStarted) return;
  sourceSyncStarted = true;
  await init();
  const rows = await db.all(`SELECT server_id,owner_id,plan_id FROM servers WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 300`).catch(() => []);
  for (const row of rows) {
    const label = `Mahan • ${String(row.plan_id || '').toUpperCase()} • مشتری ${row.owner_id}`.slice(0, 60);
    await api.rename(row.server_id, label).catch(() => {});
  }
}

const originalCreateServer = CoreApi.prototype.createServer;
CoreApi.prototype.createServer = async function mahanTaggedCreateServer(payload) {
  const originalName = String(payload?.name || `server-${Date.now()}`);
  const tagged = { ...(payload || {}), name: originalName.startsWith('mahan-') ? originalName : `mahan-${originalName}`.slice(0, 63) };
  const result = await originalCreateServer.call(this, tagged);
  const serverId = result?.server?.id;
  if (serverId) {
    const userPart = originalName.match(/^c(\d+)-/)?.[1] || '';
    const planPart = String(payload?.server_type || '').toUpperCase();
    const label = `Mahan • ${planPart}${userPart ? ` • مشتری ${userPart}` : ''}`.slice(0, 60);
    await this.rename(serverId, label).catch(() => {});
  }
  return result;
};

async function owned(serverId, userId) {
  await init();
  return db.getOwnedServer(String(serverId), String(userId));
}

async function showServer(bot, q, serverId, notice='') {
  const userId = String(q.from.id);
  const row = await owned(serverId, userId);
  if (!row) return bot.answerCallbackQuery(q.id, { text: 'سرور پیدا نشد.', show_alert: true }).catch(() => {});
  let remote = null;
  try {
    const response = await api.getServer(serverId);
    remote = response.provider || response.server || null;
    await db.updateServerState(serverId, remote?.status || row.status, remote?.public_ip || row.public_ip).catch(() => {});
  } catch (_) {}
  const plan = await findPlan(row.plan_id).catch(() => null);
  const status = remote?.status || row.status || 'unknown';
  const ip = remote?.public_ip || row.public_ip || 'در حال تخصیص';
  const next = row.next_billing_at ? new Date(row.next_billing_at).toLocaleString('fa-IR') : '—';
  const lines = [
    notice,
    `🖥 سرور #${shortId(serverId)}`,
    `🏷 مبدا: Mahan Cloud`,
    `📦 پلن: ${String(row.plan_id || '').toUpperCase()}${plan ? ` • ${specs(plan)}` : ''}`,
    `📍 لوکیشن: ${row.location || remote?.location || '—'}`,
    `📊 وضعیت: ${status}`,
    `🌐 IP: ${ip}`,
    `🗓 پرداخت: ${durationFa(row.duration)}`,
    `💵 قیمت دوره: ${money(row.sale_price)}`,
    `⏰ تمدید بعدی: ${next}`
  ].filter(Boolean);
  const keyboard = [
    [{ text:'🟢 روشن کردن', callback_data:`srvon:${serverId}` },{ text:'🔴 خاموش کردن', callback_data:`srvoff:${serverId}` }],
    [{ text:'🔑 ریست رمز root', callback_data:`srvpass:${serverId}` },{ text:'📊 ترافیک', callback_data:`srvtraffic:${serverId}` }]
  ];
  if (row.duration === 'hourly') keyboard.push([{ text:'🔁 تغییر پرداخت به ماهانه', callback_data:`mxc:${serverId}` }]);
  keyboard.push([{ text:'⬆️ ارتقای سرور', callback_data:`mxu:${serverId}` },{ text:'🔄 تغییر IP رایگان', callback_data:`mxip:${serverId}` }]);
  keyboard.push([{ text:'➕ خرید IP • ۹۰۰هزار', callback_data:`mxaip:${serverId}` },{ text:'➕ خرید ترافیک', callback_data:`mxt:${serverId}` }]);
  keyboard.push([{ text:'♻️ ریبیلد سرور', callback_data:`mxrb:${serverId}` },{ text:'🔄 بروزرسانی', callback_data:`srv:${serverId}` }]);
  keyboard.push([{ text:'🗑 حذف سرور', callback_data:`srvdelq:${serverId}` }],[{ text:'↩️ سرورهای من', callback_data:'myservers' }]);
  await bot.answerCallbackQuery(q.id).catch(() => {});
  return bot.editMessageText(lines.join('\n'), { chat_id:q.message.chat.id, message_id:q.message.message_id, reply_markup:{ inline_keyboard:keyboard } }).catch(() =>
    bot.sendMessage(q.message.chat.id, lines.join('\n'), { reply_markup:{ inline_keyboard:keyboard } })
  );
}

async function cycleQuote(bot,q,serverId) {
  const row = await owned(serverId,q.from.id); if(!row) return false;
  if(row.duration !== 'hourly') return bot.answerCallbackQuery(q.id,{text:'این سرور از قبل ماهانه است.',show_alert:true});
  const plan = await findPlan(row.plan_id); if(!plan) return bot.answerCallbackQuery(q.id,{text:'پلن فعلی پیدا نشد.',show_alert:true});
  const price = await finalPrice(plan,'monthly'), nonce=crypto.randomBytes(5).toString('hex');
  await bot.answerCallbackQuery(q.id).catch(()=>{});
  return bot.sendMessage(q.message.chat.id,`🔁 تغییر پرداخت به ماهانه\n\nسرور: #${shortId(serverId)}\nپلن: ${String(row.plan_id).toUpperCase()}\nمبلغ یک ماه: ${money(price)}\n\nبا تأیید، مبلغ یک ماه از کیف پول کسر می‌شود و دوره جدید ماهانه از همین لحظه شروع می‌شود.`,{reply_markup:{inline_keyboard:[[{text:`✅ پرداخت ${money(price)}`,callback_data:`mxcok:${serverId}:${nonce}`}],[{text:'❌ انصراف',callback_data:`srv:${serverId}`}]]}});
}
async function cycleConfirm(bot,q,serverId,nonce) {
  const key=`cycle:${serverId}:${nonce}`, lock=`cycle:${serverId}`; if(actionLocks.has(lock)) return bot.answerCallbackQuery(q.id,{text:'در حال انجام…'});
  actionLocks.add(lock);
  try {
    const row=await owned(serverId,q.from.id); if(!row)return false; if(row.duration!=='hourly')return showServer(bot,q,serverId,'✅ پرداخت این سرور از قبل ماهانه شده است.');
    const plan=await findPlan(row.plan_id), price=await finalPrice(plan,'monthly');
    const reserve=await reserveCharge(key,q.from.id,serverId,'billing_cycle',price);
    if(!reserve.ok) return bot.answerCallbackQuery(q.id,{text:reserve.insufficient?`موجودی کافی نیست؛ ${money(price)} لازم است.`:'این درخواست قبلاً پردازش شده است.',show_alert:true});
    try {
      await api.changeBillingCycle(serverId,'monthly');
      const next=new Date(Date.now()+cycleMs('monthly')).toISOString();
      await db.run(`UPDATE servers SET duration='monthly',sale_price=?,upstream_price=?,next_billing_at=?,billing_state='active',grace_started_at=NULL,grace_until=NULL,low_balance_alert_at=NULL WHERE server_id=?`,[price,upstreamPrice(plan,'monthly'),next,serverId]);
      await completeCharge(key);
      await api.powerOn(serverId).catch(()=>{});
      return showServer(bot,q,serverId,`✅ پرداخت به ماهانه تغییر کرد و ${money(price)} کسر شد.`);
    } catch(error) { await refundCharge(key); return bot.answerCallbackQuery(q.id,{text:apiMessage(error),show_alert:true}); }
  } finally { actionLocks.delete(lock); }
}

async function upgradeMenu(bot,q,serverId) {
  const row=await owned(serverId,q.from.id); if(!row)return false;
  const current=await findPlan(row.plan_id); if(!current)return bot.answerCallbackQuery(q.id,{text:'پلن فعلی پیدا نشد.',show_alert:true});
  const currentPrice=await finalPrice(current,row.duration), arch=architecture(current);
  const candidates=[];
  for(const plan of await plans()) {
    if(String(plan.id).toLowerCase()===String(current.id).toLowerCase()) continue;
    if(arch && architecture(plan) && architecture(plan)!==arch) continue;
    const price=await finalPrice(plan,row.duration);
    if(price>currentPrice) candidates.push({plan,price});
  }
  candidates.sort((a,b)=>a.price-b.price);
  if(!candidates.length)return bot.answerCallbackQuery(q.id,{text:'پلن ارتقای سازگار پیدا نشد.',show_alert:true});
  const keyboard=candidates.slice(0,18).map(({plan,price})=>[{text:`${String(plan.id).toUpperCase()} • ${specs(plan,true)} • ${money(price)}`,callback_data:`mxuq:${serverId}:${plan.id}`}]);
  keyboard.push([{text:'↩️ بازگشت',callback_data:`srv:${serverId}`}]);
  await bot.answerCallbackQuery(q.id).catch(()=>{});
  return bot.sendMessage(q.message.chat.id,`⬆️ ارتقای سرور #${shortId(serverId)}\n\nپلن فعلی: ${String(current.id).toUpperCase()} • ${money(currentPrice)}\nقیمت‌های زیر دقیقاً قیمت دوره ${durationFa(row.duration)} در Mahan هستند.`,{reply_markup:{inline_keyboard:keyboard}});
}
async function upgradeQuote(bot,q,serverId,targetId) {
  const row=await owned(serverId,q.from.id), target=await findPlan(targetId); if(!row||!target)return false;
  const price=await finalPrice(target,row.duration);
  await bot.answerCallbackQuery(q.id).catch(()=>{});
  return bot.sendMessage(q.message.chat.id,`⚠️ تأیید ارتقا\n\nسرور: #${shortId(serverId)}\nپلن هدف: ${String(target.id).toUpperCase()} • ${specs(target)}\nقیمت دوره بعد: ${money(price)}\n\nبرای ارتقا سرور موقتاً خاموش و پس از اتمام دوباره روشن می‌شود. هزینه جداگانه‌ای همین لحظه از کیف پول Mahan کم نمی‌شود؛ از تمدید بعد قیمت پلن جدید اعمال می‌شود.`,{reply_markup:{inline_keyboard:[[{text:'✅ تأیید ارتقا',callback_data:`mxuok:${serverId}:${target.id}`}],[{text:'❌ انصراف',callback_data:`srv:${serverId}`}]]}});
}
async function upgradeConfirm(bot,q,serverId,targetId) {
  const lock=`upgrade:${serverId}`; if(actionLocks.has(lock))return bot.answerCallbackQuery(q.id,{text:'ارتقا در حال انجام است…'}); actionLocks.add(lock);
  try {
    const row=await owned(serverId,q.from.id), target=await findPlan(targetId); if(!row||!target)return false;
    await bot.answerCallbackQuery(q.id,{text:'ارتقا شروع شد…'}).catch(()=>{});
    const result=await api.safeUpgrade(serverId,target.id,false);
    const price=await finalPrice(target,row.duration);
    await db.run('UPDATE servers SET plan_id=?,sale_price=?,upstream_price=?,status=? WHERE server_id=?',[String(target.id),price,upstreamPrice(target,row.duration),result.power_on_ok===false?'stopped':'active',serverId]);
    return showServer(bot,q,serverId,`✅ ارتقا به ${String(target.id).toUpperCase()} انجام شد. قیمت تمدید بعدی: ${money(price)}`);
  } catch(error){return bot.answerCallbackQuery(q.id,{text:apiMessage(error),show_alert:true});} finally{actionLocks.delete(lock);}
}

async function changeIpQuote(bot,q,serverId) {
  const row=await owned(serverId,q.from.id); if(!row)return false;
  await bot.answerCallbackQuery(q.id).catch(()=>{});
  return bot.sendMessage(q.message.chat.id,`🔄 تغییر IP رایگان\n\nIPv4 اصلی سرور #${shortId(serverId)} با یک IP جدید جایگزین می‌شود. سرور ممکن است برای مدت کوتاهی خاموش شود.\n\nبرای مشتری Mahan این عملیات رایگان است.`,{reply_markup:{inline_keyboard:[[{text:'✅ تغییر IP',callback_data:`mxipok:${serverId}`}],[{text:'❌ انصراف',callback_data:`srv:${serverId}`}]]}});
}
async function changeIpConfirm(bot,q,serverId) {
  const lock=`ip:${serverId}`; if(actionLocks.has(lock))return bot.answerCallbackQuery(q.id,{text:'تغییر IP در حال انجام است…'});actionLocks.add(lock);
  try {
    if(!await owned(serverId,q.from.id))return false;
    await bot.answerCallbackQuery(q.id,{text:'در حال تغییر IP…'}).catch(()=>{});
    const result=await api.changeIp(serverId);
    await db.run('UPDATE servers SET public_ip=? WHERE server_id=?',[result.new_ip||null,serverId]);
    return showServer(bot,q,serverId,`✅ IP تغییر کرد: ${result.old_ip||'—'} → ${result.new_ip||'—'}`);
  } catch(error){return bot.answerCallbackQuery(q.id,{text:apiMessage(error),show_alert:true});} finally{actionLocks.delete(lock);}
}

async function addIpQuote(bot,q,serverId) {
  if(!await owned(serverId,q.from.id))return false;
  const price=Math.max(0,Number(await setting('extra_ip_price','900000'))||900000),nonce=crypto.randomBytes(5).toString('hex');
  await bot.answerCallbackQuery(q.id).catch(()=>{});
  return bot.sendMessage(q.message.chat.id,`➕ خرید IPv4 اضافه\n\nسرور: #${shortId(serverId)}\nقیمت هر IP: ${money(price)}\n\nاین IP علاوه بر IP اصلی سرور است و ممکن است برای استفاده داخل سیستم‌عامل نیاز به تنظیم شبکه داشته باشد.`,{reply_markup:{inline_keyboard:[[{text:`✅ خرید ${money(price)}`,callback_data:`mxaipok:${serverId}:${nonce}`}],[{text:'❌ انصراف',callback_data:`srv:${serverId}`}]]}});
}
async function addIpConfirm(bot,q,serverId,nonce) {
  const lock=`addip:${serverId}`;if(actionLocks.has(lock))return bot.answerCallbackQuery(q.id,{text:'در حال خرید IP…'});actionLocks.add(lock);
  const price=Math.max(0,Number(await setting('extra_ip_price','900000'))||900000),key=`addip:${serverId}:${nonce}`;
  try {
    if(!await owned(serverId,q.from.id))return false;
    const reserve=await reserveCharge(key,q.from.id,serverId,'additional_ip',price);
    if(!reserve.ok)return bot.answerCallbackQuery(q.id,{text:reserve.insufficient?`موجودی کافی نیست؛ ${money(price)} لازم است.`:'این درخواست قبلاً پردازش شده است.',show_alert:true});
    try {
      const result=await api.addAdditionalIp(serverId,`Mahan customer ${q.from.id}`);
      await completeCharge(key);
      const ip=result?.additional_ip?.ip || result?.additional_ip?.address || 'ایجاد شد';
      await bot.answerCallbackQuery(q.id,{text:'IP اضافه خریداری شد.'}).catch(()=>{});
      return bot.sendMessage(q.message.chat.id,`✅ IP اضافه با موفقیت خریداری شد.\n\n🌐 IP: ${ip}\n💳 مبلغ: ${money(price)}\n\nدر صورت نیاز، IP را داخل سیستم‌عامل سرور نیز کانفیگ کنید.`,{reply_markup:{inline_keyboard:[[{text:'↩️ مدیریت سرور',callback_data:`srv:${serverId}`}]]}});
    } catch(error){await refundCharge(key);return bot.answerCallbackQuery(q.id,{text:apiMessage(error),show_alert:true});}
  } finally{actionLocks.delete(lock);}
}

async function trafficMenu(bot,q,serverId) {
  if(!await owned(serverId,q.from.id))return false;
  const perTb=Math.max(0,Number(await setting('extra_traffic_tb_price','300000'))||300000);
  await bot.answerCallbackQuery(q.id).catch(()=>{});
  return bot.sendMessage(q.message.chat.id,`➕ خرید ترافیک اضافه\n\nنرخ Mahan: هر ۱ ترابایت ${money(perTb)}\nترافیک خریداری‌شده تا ریست ماهانه Hetzner معتبر است.`,{reply_markup:{inline_keyboard:[[{text:`۱ TB • ${money(perTb)}`,callback_data:`mxtq:${serverId}:1`}],[{text:`۵ TB • ${money(perTb*5)}`,callback_data:`mxtq:${serverId}:5`}],[{text:`۱۰ TB • ${money(perTb*10)}`,callback_data:`mxtq:${serverId}:10`}],[{text:`۲۰ TB • ${money(perTb*20)}`,callback_data:`mxtq:${serverId}:20`}],[{text:'↩️ بازگشت',callback_data:`srv:${serverId}`}]]}});
}
async function trafficQuote(bot,q,serverId,tb) {
  if(!await owned(serverId,q.from.id))return false;
  if(![1,5,10,20].includes(Number(tb)))return false;
  const perTb=Math.max(0,Number(await setting('extra_traffic_tb_price','300000'))||300000),amount=perTb*Number(tb),nonce=crypto.randomBytes(5).toString('hex');
  await bot.answerCallbackQuery(q.id).catch(()=>{});
  return bot.sendMessage(q.message.chat.id,`📦 تأیید خرید ترافیک\n\nحجم: ${tb} TB\nمبلغ: ${money(amount)}\n\nپس از تأیید مبلغ از کیف پول Mahan کسر و سهمیه همین دوره افزایش داده می‌شود.`,{reply_markup:{inline_keyboard:[[{text:`✅ پرداخت ${money(amount)}`,callback_data:`mxtok:${serverId}:${tb}:${nonce}`}],[{text:'❌ انصراف',callback_data:`srv:${serverId}`}]]}});
}
async function trafficConfirm(bot,q,serverId,tb,nonce) {
  const lock=`traffic:${serverId}`;if(actionLocks.has(lock))return bot.answerCallbackQuery(q.id,{text:'در حال خرید ترافیک…'});actionLocks.add(lock);
  const perTb=Math.max(0,Number(await setting('extra_traffic_tb_price','300000'))||300000),amount=perTb*Number(tb),key=`traffic:${serverId}:${tb}:${nonce}`;
  try {
    if(!await owned(serverId,q.from.id))return false;
    const reserve=await reserveCharge(key,q.from.id,serverId,'traffic_addon',amount);
    if(!reserve.ok)return bot.answerCallbackQuery(q.id,{text:reserve.insufficient?`موجودی کافی نیست؛ ${money(amount)} لازم است.`:'این درخواست قبلاً پردازش شده است.',show_alert:true});
    try {
      const result=await api.buyTrafficAddon(serverId,Number(tb),nonce);
      await completeCharge(key);
      await bot.answerCallbackQuery(q.id,{text:'ترافیک اضافه شد.'}).catch(()=>{});
      return bot.sendMessage(q.message.chat.id,`✅ ${tb} ترابایت ترافیک اضافه خریداری شد.\n💳 مبلغ: ${money(amount)}${result.period_reset?`\n🔄 معتبر تا: ${new Date(result.period_reset).toLocaleDateString('fa-IR')}`:''}`,{reply_markup:{inline_keyboard:[[{text:'📊 مشاهده ترافیک',callback_data:`srvtraffic:${serverId}`}],[{text:'↩️ مدیریت سرور',callback_data:`srv:${serverId}`}]]}});
    } catch(error){await refundCharge(key);return bot.answerCallbackQuery(q.id,{text:apiMessage(error),show_alert:true});}
  } finally{actionLocks.delete(lock);}
}

async function rebuildMenu(bot,q,serverId) {
  if(!await owned(serverId,q.from.id))return false;
  await bot.answerCallbackQuery(q.id,{text:'در حال دریافت سیستم‌عامل‌ها…'}).catch(()=>{});
  try {
    const response=await api.rebuildImages(serverId),images=Array.isArray(response.images)?response.images:[];
    if(!images.length)return bot.sendMessage(q.message.chat.id,'سیستم‌عامل سازگاری برای ریبیلد پیدا نشد.');
    const keyboard=images.slice(0,20).map(image=>[{text:String(image.label||image.name||image.id).slice(0,45),callback_data:`mxrbq:${serverId}:${image.id}`}]);
    keyboard.push([{text:'↩️ بازگشت',callback_data:`srv:${serverId}`}]);
    return bot.sendMessage(q.message.chat.id,`♻️ ریبیلد سرور #${shortId(serverId)}\n\nسیستم‌عامل جدید را انتخاب کنید. تمام اطلاعات فعلی دیسک سرور پاک می‌شود.`,{reply_markup:{inline_keyboard:keyboard}});
  } catch(error){return bot.sendMessage(q.message.chat.id,`❌ ${apiMessage(error)}`);}
}
async function rebuildQuote(bot,q,serverId,imageId) {
  if(!await owned(serverId,q.from.id))return false;
  await bot.answerCallbackQuery(q.id).catch(()=>{});
  return bot.sendMessage(q.message.chat.id,`⚠️ ریبیلد تمام اطلاعات فعلی سرور #${shortId(serverId)} را حذف می‌کند.\n\nاز انجام این عملیات مطمئن هستید؟`,{reply_markup:{inline_keyboard:[[{text:'✅ بله، ریبیلد شود',callback_data:`mxrbok:${serverId}:${imageId}`}],[{text:'❌ انصراف',callback_data:`srv:${serverId}`}]]}});
}
async function rebuildConfirm(bot,q,serverId,imageId) {
  const lock=`rebuild:${serverId}`;if(actionLocks.has(lock))return bot.answerCallbackQuery(q.id,{text:'ریبیلد در حال انجام است…'});actionLocks.add(lock);
  try {
    if(!await owned(serverId,q.from.id))return false;
    await bot.answerCallbackQuery(q.id,{text:'ریبیلد شروع شد…'}).catch(()=>{});
    const result=await api.rebuild(serverId,imageId);
    const pass=result?.root_password;
    return bot.sendMessage(q.message.chat.id,`✅ ریبیلد سرور شروع شد.${pass?`\n\n🔐 رمز root جدید:\n<code>${String(pass).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code>\n⚠️ رمز را در جای امن نگه دارید.`:'\nپس از آماده‌شدن سیستم‌عامل، سرور قابل استفاده خواهد بود.'}`,{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'↩️ مدیریت سرور',callback_data:`srv:${serverId}`}]]}});
  } catch(error){return bot.answerCallbackQuery(q.id,{text:apiMessage(error),show_alert:true});} finally{actionLocks.delete(lock);}
}

async function handle(bot,q) {
  const data=String(q.data||'');
  let m;
  if((m=data.match(/^srv:(.+)$/))) return showServer(bot,q,m[1]);
  if((m=data.match(/^mxc:([^:]+)$/))) return cycleQuote(bot,q,m[1]);
  if((m=data.match(/^mxcok:([^:]+):([a-f0-9]+)$/))) return cycleConfirm(bot,q,m[1],m[2]);
  if((m=data.match(/^mxu:([^:]+)$/))) return upgradeMenu(bot,q,m[1]);
  if((m=data.match(/^mxuq:([^:]+):([^:]+)$/))) return upgradeQuote(bot,q,m[1],m[2]);
  if((m=data.match(/^mxuok:([^:]+):([^:]+)$/))) return upgradeConfirm(bot,q,m[1],m[2]);
  if((m=data.match(/^mxip:([^:]+)$/))) return changeIpQuote(bot,q,m[1]);
  if((m=data.match(/^mxipok:([^:]+)$/))) return changeIpConfirm(bot,q,m[1]);
  if((m=data.match(/^mxaip:([^:]+)$/))) return addIpQuote(bot,q,m[1]);
  if((m=data.match(/^mxaipok:([^:]+):([a-f0-9]+)$/))) return addIpConfirm(bot,q,m[1],m[2]);
  if((m=data.match(/^mxt:([^:]+)$/))) return trafficMenu(bot,q,m[1]);
  if((m=data.match(/^mxtq:([^:]+):(1|5|10|20)$/))) return trafficQuote(bot,q,m[1],Number(m[2]));
  if((m=data.match(/^mxtok:([^:]+):(1|5|10|20):([a-f0-9]+)$/))) return trafficConfirm(bot,q,m[1],Number(m[2]),m[3]);
  if((m=data.match(/^mxrb:([^:]+)$/))) return rebuildMenu(bot,q,m[1]);
  if((m=data.match(/^mxrbq:([^:]+):([^:]+)$/))) return rebuildQuote(bot,q,m[1],m[2]);
  if((m=data.match(/^mxrbok:([^:]+):([^:]+)$/))) return rebuildConfirm(bot,q,m[1],m[2]);
  return false;
}

const originalOn=TelegramBot.prototype.on;
TelegramBot.prototype.on=function mahanManagementOn(event,listener) {
  const bot=this;
  ensureCommands(bot);
  if(!sourceSyncStarted) setTimeout(()=>syncSourceLabels().catch(error=>console.warn('[mahan-source-sync]',error.message||error)),3500).unref();
  if(event==='callback_query') return originalOn.call(this,event,async q=>{
    try { if(await handle(bot,q)) return; }
    catch(error) { console.error('[mahan-management]',error); await bot.answerCallbackQuery(q.id,{text:'خطایی رخ داد.',show_alert:true}).catch(()=>{}); return; }
    return listener(q);
  });
  return originalOn.call(this,event,listener);
};
