'use strict';

// Production feature layer for Mahan Cloud. It deliberately runs as a Node
// preload so the stable bot stays the rollback path while these reseller-only
// features can intercept the few flows they own.
const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const Database = require('./db');
const { CoreApi, CoreApiError } = require('./core-api');

const featureDb = new Database(config.dbPath);
const api = new CoreApi(config.upstream);
const loginTokens = new Map();
const sessions = new Map();
let runtimeBot = null;
let started = false;
let planCache = { at: 0, plans: [] };
let billingBusy = false;
let upstreamBusy = false;
let upstreamLastAlert = 0;

const locations = String(process.env.AVAILABLE_LOCATIONS || 'nbg1,fsn1,hel1,ash,hil,sin')
  .split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
const locationLabels = {
  nbg1: '🇩🇪 آلمان • نورنبرگ', fsn1: '🇩🇪 آلمان • فالکن‌اشتاین',
  hel1: '🇫🇮 فنلاند • هلسینکی', ash: '🇺🇸 آمریکا • اشبرن',
  hil: '🇺🇸 آمریکا • هیلزبورو', sin: '🇸🇬 سنگاپور'
};
const panelHost = String(process.env.ADMIN_PANEL_HOST || '0.0.0.0');
const panelPort = Math.max(1, Number(process.env.ADMIN_PANEL_PORT || 8787));
const panelPublicUrl = String(process.env.ADMIN_PANEL_PUBLIC_URL || '').replace(/\/$/, '');
const billingPollMs = Math.max(60_000, Number(process.env.BILLING_POLL_MS || 300_000));
const upstreamPollMs = Math.max(60_000, Number(process.env.UPSTREAM_BALANCE_POLL_MS || 300_000));

function isAdmin(id) { return config.adminIds.has(String(id)); }
function money(n) { return `${Math.round(Number(n || 0)).toLocaleString('fa-IR')} ${config.currencyLabel}`; }
function shortId(id) { return String(id).slice(-8); }
function faToEn(value) {
  const m = {'۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9','٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
  return String(value ?? '').replace(/[۰-۹٠-٩]/g, c => m[c] || c);
}
function amount(value) {
  const n = Number(faToEn(value).replace(/[,_\s،]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function durationFa(d) { return d === 'hourly' ? 'ساعتی' : 'ماهانه'; }
function cycleMs(d) { return d === 'hourly' ? 3600_000 : 30 * 24 * 3600_000; }
function locLabel(l) { return locationLabels[l] || String(l).toUpperCase(); }
function upstreamPrice(plan, duration) {
  return Number(duration === 'hourly'
    ? (plan.amount_hourly ?? plan.hourly_price_toman ?? plan.price)
    : (plan.amount_monthly ?? plan.monthly_toman ?? plan.monthly_price_toman));
}
function legacyHourly(base) {
  const raw = Number(base || 0) * (1 + config.catalog.markupPercent / 100) + config.catalog.markupFixed;
  return Math.ceil(raw / config.catalog.roundTo) * config.catalog.roundTo;
}
function apiError(error) {
  if (!(error instanceof CoreApiError)) return 'خطای داخلی رخ داد. دوباره تلاش کنید.';
  if (error.code === 'HETZNER_PLACEMENT_UNAVAILABLE') return 'این پلن در لوکیشن انتخابی موقتاً ظرفیت ندارد.';
  if (error.code === 'NOT_ALLOWED') return 'این لوکیشن یا پلن برای حساب فروشگاه فعال نیست.';
  if (error.code === 'INSUFFICIENT_WALLET') return 'موجودی حساب تأمین‌کننده کافی نیست؛ مدیریت مطلع شد.';
  return error.message || 'عملیات انجام نشد.';
}

async function schema() {
  await featureDb.init();
  await featureDb.run(`CREATE TABLE IF NOT EXISTS app_settings(
    key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await featureDb.run(`CREATE TABLE IF NOT EXISTS price_overrides(
    plan_id TEXT NOT NULL,duration TEXT NOT NULL,final_price INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(plan_id,duration))`);
  const columns = new Set((await featureDb.all('PRAGMA table_info(servers)')).map(c => c.name));
  for (const [name, type] of [
    ['location','TEXT'],['next_billing_at','TEXT'],['billing_state',"TEXT NOT NULL DEFAULT 'active'"],
    ['grace_started_at','TEXT'],['grace_until','TEXT'],['low_balance_alert_at','TEXT']
  ]) if (!columns.has(name)) await featureDb.run(`ALTER TABLE servers ADD COLUMN ${name} ${type}`);
  const defaults = {
    monthly_markup: '450000', hourly_extra: '500', low_balance_threshold: '100000',
    low_balance_repeat_minutes: '360', grace_hours: '6',
    payment_card: config.payment.card || '6219861422915552',
    payment_card_holder: config.payment.cardHolder || 'بارانی'
  };
  for (const [k,v] of Object.entries(defaults)) await featureDb.run('INSERT OR IGNORE INTO app_settings(key,value) VALUES(?,?)',[k,String(v)]);
  const s = await settings();
  if (s.payment_card) config.payment.card = s.payment_card;
  if (s.payment_card_holder) config.payment.cardHolder = s.payment_card_holder;
}
async function setting(key, fallback='') { const r=await featureDb.get('SELECT value FROM app_settings WHERE key=?',[key]); return r ? r.value : fallback; }
async function saveSetting(key,value) {
  await featureDb.run(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`,[key,String(value)]);
}
async function settings() { const out={}; for(const r of await featureDb.all('SELECT key,value FROM app_settings')) out[r.key]=r.value; return out; }
async function override(planId,duration) { const r=await featureDb.get('SELECT final_price FROM price_overrides WHERE plan_id=? AND duration=?',[String(planId).toLowerCase(),duration]); return r ? Number(r.final_price) : null; }
async function saveOverride(planId,duration,price) {
  const id=String(planId).toLowerCase();
  if (!(price > 0)) return featureDb.run('DELETE FROM price_overrides WHERE plan_id=? AND duration=?',[id,duration]);
  await featureDb.run(`INSERT INTO price_overrides(plan_id,duration,final_price,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(plan_id,duration) DO UPDATE SET final_price=excluded.final_price,updated_at=CURRENT_TIMESTAMP`,[id,duration,Math.round(price)]);
}
async function finalPrice(plan,duration) {
  const custom=await override(plan.id,duration); if(custom>0) return custom;
  const base=upstreamPrice(plan,duration), s=await settings();
  return duration === 'monthly'
    ? Math.round(base + Number(s.monthly_markup || 450000))
    : Math.round(legacyHourly(base) + Number(s.hourly_extra || 500));
}
async function plans(force=false) {
  if(!force && planCache.plans.length && Date.now()-planCache.at<60_000) return planCache.plans;
  const out=await api.prices(); let list=Array.isArray(out.plans)?out.plans.filter(p=>p&&p.available!==false):[];
  if(config.catalog.allowedPlans.size) list=list.filter(p=>config.catalog.allowedPlans.has(String(p.id||'').toLowerCase()));
  list=list.slice(0,config.catalog.maxVisiblePlans); planCache={at:Date.now(),plans:list}; return list;
}
async function findPlan(id) { let p=(await plans()).find(x=>String(x.id).toLowerCase()===String(id).toLowerCase()); if(!p)p=(await plans(true)).find(x=>String(x.id).toLowerCase()===String(id).toLowerCase()); return p||null; }
function specs(plan, compact=false) {
  const x=[]; if(plan.cores)x.push(compact?`${plan.cores}C`:`${plan.cores} vCPU`); if(plan.memory)x.push(compact?`${plan.memory}G`:`${plan.memory}GB RAM`); if(plan.disk)x.push(compact?`${plan.disk}G`:`${plan.disk}GB Disk`); return x.join(compact?'/':' • ') || String(plan.label||plan.id);
}

async function editOrSend(bot,chatId,messageId,text,keyboard) {
  const opts={reply_markup:{inline_keyboard:keyboard}};
  if(messageId) {
    const ok=await bot.editMessageText(text,{chat_id:chatId,message_id:messageId,...opts}).then(()=>true).catch(()=>false);
    if(ok)return;
  }
  await bot.sendMessage(chatId,text,opts);
}
async function showLocations(bot,q,duration) {
  const valid=['hourly','monthly'].includes(duration)?duration:config.catalog.defaultDuration;
  const rows=[]; for(let i=0;i<locations.length;i+=2) rows.push(locations.slice(i,i+2).map(l=>({text:locLabel(l),callback_data:`mxloc:${valid}:${l}`})));
  rows.push([{text:'🏠 منوی اصلی',callback_data:'home'}]);
  await editOrSend(bot,q.message.chat.id,q.message.message_id,`📍 انتخاب لوکیشن\n\nنوع پرداخت: ${durationFa(valid)}\nلوکیشن دیتاسنتر را انتخاب کنید:`,rows);
}
async function showPlans(bot,q,duration,location) {
  const valid=['hourly','monthly'].includes(duration)?duration:'monthly';
  const list=(await plans()).filter(p=>upstreamPrice(p,valid)>0); const rows=[];
  for(const p of list) rows.push([{text:`${String(p.id).toUpperCase()} • ${specs(p,true)} • ${money(await finalPrice(p,valid))}`,callback_data:`mxplan:${valid}:${location}:${p.id}`}]);
  rows.push([{text:valid==='monthly'?'✅ ماهانه':'ماهانه',callback_data:`mxloc:monthly:${location}`},{text:valid==='hourly'?'✅ ساعتی':'ساعتی',callback_data:`mxloc:hourly:${location}`}]);
  rows.push([{text:`📍 ${locLabel(location)}`,callback_data:`locations:${valid}:0`}]);
  rows.push([{text:'🏠 منوی اصلی',callback_data:'home'}]);
  await editOrSend(bot,q.message.chat.id,q.message.message_id,`🛒 انتخاب پلن\n\n📍 ${locLabel(location)}\nنوع پرداخت: ${durationFa(valid)}\nمشخصات و قیمت نهایی روی هر دکمه نمایش داده شده است.`,rows);
}
async function showPlan(bot,q,duration,location,planId) {
  const p=await findPlan(planId); if(!p)return bot.sendMessage(q.message.chat.id,'این پلن دیگر موجود نیست.');
  const sale=await finalPrice(p,duration);
  const text=`🧾 جزئیات سفارش\n\n${String(p.id).toUpperCase()}\n⚙️ ${specs(p)}\n🗓 دوره: ${durationFa(duration)}\n📍 لوکیشن: ${locLabel(location)}\n💵 قیمت نهایی: ${money(sale)}\n💿 سیستم‌عامل: ${config.catalog.defaultImage}\n\nبعد از تأیید مبلغ از کیف پول کسر می‌شود.`;
  await editOrSend(bot,q.message.chat.id,q.message.message_id,text,[[{text:`✅ تأیید و پرداخت ${money(sale)}`,callback_data:`mxbuy:${duration}:${location}:${p.id}`}],[{text:'↩️ بازگشت',callback_data:`mxloc:${duration}:${location}`}]]);
}
async function buy(bot,q,duration,location,planId) {
  const userId=String(q.from.id), chatId=q.message.chat.id, p=await findPlan(planId);
  if(!p)return bot.sendMessage(chatId,'پلن انتخاب‌شده دیگر موجود نیست.');
  const base=upstreamPrice(p,duration), sale=await finalPrice(p,duration);
  if(!(base>0&&sale>0))return bot.sendMessage(chatId,'قیمت این پلن قابل محاسبه نیست.');
  if(!await featureDb.debitIfEnough(userId,sale)) return bot.sendMessage(chatId,`❌ موجودی کافی نیست.\nمبلغ سفارش: ${money(sale)}`,{reply_markup:{inline_keyboard:[[{text:'➕ شارژ حساب',callback_data:'topup'}]]}});
  await bot.answerCallbackQuery(q.id,{text:'در حال ثبت سفارش…'}).catch(()=>{});
  const m=await bot.sendMessage(chatId,'⏳ سفارش ثبت شد؛ در حال ایجاد سرور…');
  try {
    const result=await api.createServer({server_type:String(p.id),duration,image:config.catalog.defaultImage,location,name:`c${userId}-${Date.now()}`});
    const srv=result.server||{}; if(!srv.id)throw new Error('upstream did not return server id');
    const next=new Date(Date.now()+cycleMs(duration)).toISOString();
    await featureDb.run(`INSERT INTO servers(server_id,owner_id,plan_id,duration,sale_price,upstream_price,status,public_ip,location,next_billing_at,billing_state)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[String(srv.id),userId,String(p.id),duration,sale,base,srv.status||'provisioning',srv.public_ip||null,location,next,'active']);
    await bot.editMessageText(`✅ سفارش ثبت شد.\n\nشناسه: #${shortId(srv.id)}\nپلن: ${String(p.id).toUpperCase()} • ${specs(p)}\n📍 ${locLabel(location)}\nمبلغ: ${money(sale)}\nتمدید بعدی: ${new Date(next).toLocaleString('fa-IR')}\n\nبعد از آماده‌شدن IP و رمز ارسال می‌شود.`,{chat_id:chatId,message_id:m.message_id});
  } catch(error) {
    await featureDb.credit(userId,sale); await bot.editMessageText(`❌ ساخت سرور انجام نشد و مبلغ برگشت داده شد.\n\n${apiError(error)}`,{chat_id:chatId,message_id:m.message_id});
  }
}

async function dueInfo(row) {
  const p=await findPlan(row.plan_id); if(!p)return null;
  const unit=await finalPrice(p,row.duration); const dueAt=new Date(row.next_billing_at).getTime();
  const cycles=Math.max(1,Math.floor((Date.now()-dueAt)/cycleMs(row.duration))+1);
  return {plan:p,unit,cycles,total:unit*cycles,next:new Date(dueAt+cycles*cycleMs(row.duration)).toISOString()};
}
async function setGrace(row,price) {
  const h=Math.max(1,Number(await setting('grace_hours','6'))||6), until=new Date(Date.now()+h*3600_000).toISOString();
  await api.powerOff(row.server_id).catch(()=>{});
  await featureDb.run(`UPDATE servers SET billing_state='grace',grace_started_at=?,grace_until=?,low_balance_alert_at=? WHERE server_id=?`,[new Date().toISOString(),until,new Date().toISOString(),row.server_id]);
  await runtimeBot.sendMessage(row.owner_id,`⚠️ موجودی برای تمدید سرور #${shortId(row.server_id)} کافی نبود و سرور خاموش شد.\n\nمبلغ لازم: ${money(price)}\nتا ${h} ساعت فرصت دارید حساب را شارژ کنید و از «سرورهای من» دکمه روشن را بزنید.\nدر صورت پایان مهلت، سرور حذف می‌شود.`).catch(()=>{});
  for(const admin of config.adminIds) await runtimeBot.sendMessage(admin,`⚠️ کمبود موجودی مشتری\nUser: ${row.owner_id}\nServer: #${shortId(row.server_id)}\nنیاز: ${money(price)}\nمهلت: ${h} ساعت`).catch(()=>{});
}
async function lowBalance(row,user,price) {
  const s=await settings(), threshold=Math.max(Number(s.low_balance_threshold||100000),price), repeat=(Number(s.low_balance_repeat_minutes||360)||360)*60_000;
  if(Number(user.balance)>=threshold)return;
  const last=Date.parse(row.low_balance_alert_at||'')||0; if(Date.now()-last<repeat)return;
  await featureDb.run('UPDATE servers SET low_balance_alert_at=? WHERE server_id=?',[new Date().toISOString(),row.server_id]);
  await runtimeBot.sendMessage(row.owner_id,`⚠️ موجودی حساب شما کم است.\n\nموجودی: ${money(user.balance)}\nهزینه تمدید بعدی سرور #${shortId(row.server_id)}: ${money(price)}\nبرای جلوگیری از خاموشی، حساب را شارژ کنید.`).catch(()=>{});
}
async function billingTick() {
  if(billingBusy||!runtimeBot)return; billingBusy=true;
  try {
    const rows=await featureDb.all(`SELECT * FROM servers WHERE deleted_at IS NULL AND next_billing_at IS NOT NULL ORDER BY next_billing_at ASC`);
    for(const row of rows) try {
      const p=await findPlan(row.plan_id); if(!p)continue; const price=await finalPrice(p,row.duration); const user=await featureDb.getUser(row.owner_id); if(!user)continue;
      if(row.billing_state==='grace') {
        const until=Date.parse(row.grace_until||'')||0;
        if(until && Date.now()>=until) {
          await api.deleteServer(row.server_id).catch(()=>{}); await featureDb.markDeleted(row.server_id);
          await runtimeBot.sendMessage(row.owner_id,`⌛ مهلت ۶ ساعته سرور #${shortId(row.server_id)} تمام شد و سرویس برای جلوگیری از هزینه بیشتر حذف شد.`).catch(()=>{});
          continue;
        }
        await lowBalance(row,user,price); continue;
      }
      await lowBalance(row,user,price);
      if(Date.now() < (Date.parse(row.next_billing_at)||Infinity))continue;
      const due=await dueInfo(row); if(!due)continue;
      if(await featureDb.debitIfEnough(row.owner_id,due.total)) {
        await featureDb.run(`UPDATE servers SET next_billing_at=?,billing_state='active',grace_started_at=NULL,grace_until=NULL WHERE server_id=?`,[due.next,row.server_id]);
        await runtimeBot.sendMessage(row.owner_id,`✅ تمدید سرور #${shortId(row.server_id)} انجام شد.\nمبلغ: ${money(due.total)}\nموعد بعدی: ${new Date(due.next).toLocaleString('fa-IR')}`).catch(()=>{});
      } else await setGrace(row,due.total);
    } catch(e){ console.error('[mahan-billing:item]',row.server_id,e.message||e); }
  } catch(e){ console.error('[mahan-billing]',e.message||e); } finally { billingBusy=false; }
}
async function handlePowerOn(bot,q) {
  const serverId=String(q.data.split(':')[1]||''), userId=String(q.from.id), row=await featureDb.getOwnedServer(serverId,userId);
  if(!row)return bot.answerCallbackQuery(q.id,{text:'سرور پیدا نشد.',show_alert:true});
  if(row.billing_state!=='grace') {
    try{await api.powerOn(serverId); await bot.answerCallbackQuery(q.id,{text:'درخواست روشن‌کردن ارسال شد'});}catch(e){await bot.answerCallbackQuery(q.id,{text:apiError(e),show_alert:true});} return true;
  }
  const until=Date.parse(row.grace_until||'')||0;
  if(until && Date.now()>=until) { await bot.answerCallbackQuery(q.id,{text:'مهلت پرداخت پایان یافته است.',show_alert:true}); return true; }
  const due=await dueInfo(row); if(!due)return true;
  if(!await featureDb.debitIfEnough(userId,due.total)) {
    await bot.answerCallbackQuery(q.id,{text:`موجودی کافی نیست؛ ${money(due.total)} لازم است.`,show_alert:true}); return true;
  }
  try {
    await api.powerOn(serverId);
    await featureDb.run(`UPDATE servers SET next_billing_at=?,billing_state='active',grace_started_at=NULL,grace_until=NULL,low_balance_alert_at=NULL WHERE server_id=?`,[due.next,serverId]);
    await bot.answerCallbackQuery(q.id,{text:'پرداخت انجام شد و سرور روشن می‌شود.'});
    await bot.sendMessage(q.message.chat.id,`✅ ${money(due.total)} برای تمدید کسر شد و سرور #${shortId(serverId)} روشن می‌شود.`);
  } catch(e) { await featureDb.credit(userId,due.total); await bot.answerCallbackQuery(q.id,{text:apiError(e),show_alert:true}); }
  return true;
}
async function upstreamTick() {
  if(upstreamBusy||!runtimeBot)return; upstreamBusy=true;
  try {
    const s=await settings(), threshold=Math.max(100000,Number(s.low_balance_threshold||100000));
    const balance=Number((await api.wallet())?.wallet?.balance||0), repeat=(Number(s.low_balance_repeat_minutes||360)||360)*60_000;
    if(balance<threshold && Date.now()-upstreamLastAlert>repeat) {
      upstreamLastAlert=Date.now(); for(const admin of config.adminIds) await runtimeBot.sendMessage(admin,`🚨 موجودی حساب تأمین Mahan Cloud کم است.\nموجودی فعلی: ${money(balance)}\nلطفاً برای جلوگیری از اختلال در ساخت/تمدید سرورها موجودی را بررسی کنید.`).catch(()=>{});
    }
  } catch(e){ console.error('[mahan-upstream-wallet]',e.message||e); } finally { upstreamBusy=false; }
}

function cookie(req) { const out={}; for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i>0)out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());}return out; }
function body(req) { return new Promise((resolve,reject)=>{let raw='';req.on('data',c=>{raw+=c;if(raw.length>200000)req.destroy();});req.on('end',()=>resolve(Object.fromEntries(new URLSearchParams(raw))));req.on('error',reject);}); }
function layout(title,inner) { return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font-family:Tahoma,Arial;background:#0f172a;color:#e5e7eb;margin:0}.wrap{max-width:1100px;margin:30px auto;padding:0 16px}.card{background:#111827;border:1px solid #334155;border-radius:16px;padding:18px;margin:12px 0}h1,h2{margin-top:0}input{background:#0b1220;color:#fff;border:1px solid #475569;border-radius:8px;padding:9px;width:160px}button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:10px 16px;cursor:pointer}table{width:100%;border-collapse:collapse}td,th{padding:9px;border-bottom:1px solid #334155;text-align:right}.ok{background:#064e3b;padding:10px;border-radius:8px}.muted{color:#94a3b8;font-size:13px}form.inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}</style></head><body><div class="wrap">${inner}</div></body></html>`; }
function sendHtml(res,status,content) { res.statusCode=status; res.setHeader('content-type','text/html; charset=utf-8'); res.setHeader('cache-control','no-store'); res.setHeader('x-frame-options','DENY'); res.end(content); }
function newLogin(adminId) { const t=crypto.randomBytes(24).toString('base64url'); loginTokens.set(t,{adminId:String(adminId),expires:Date.now()+10*60_000}); return t; }
function authed(req) { const sid=cookie(req).mahan_admin_session, s=sessions.get(sid); if(!s||s.expires<Date.now()){if(sid)sessions.delete(sid);return null;} return s; }
async function renderPanel(note='') {
  const s=await settings(), list=await plans().catch(()=>[]); let rows='';
  for(const p of list){const m=await finalPrice(p,'monthly'),h=await finalPrice(p,'hourly'),mo=await override(p.id,'monthly'),ho=await override(p.id,'hourly');rows+=`<tr><td><b>${esc(String(p.id).toUpperCase())}</b><br><span class="muted">${esc(specs(p))}</span></td><td>${esc(money(upstreamPrice(p,'monthly')))}</td><td><form class="inline" method="post" action="/admin/price"><input type="hidden" name="plan_id" value="${esc(p.id)}"><input type="hidden" name="duration" value="monthly"><input name="final_price" value="${mo||''}" placeholder="${m}"><button>ذخیره</button></form></td><td><form class="inline" method="post" action="/admin/price"><input type="hidden" name="plan_id" value="${esc(p.id)}"><input type="hidden" name="duration" value="hourly"><input name="final_price" value="${ho||''}" placeholder="${h}"><button>ذخیره</button></form></td></tr>`;}
  return layout('Mahan Cloud Admin',`<h1>☁️ مدیریت Mahan Cloud</h1>${note?`<div class="ok">${esc(note)}</div>`:''}<div class="card"><h2>تنظیمات عمومی</h2><form method="post" action="/admin/settings"><p>افزایش قیمت ماهانه روی قیمت Hamoon: <input name="monthly_markup" value="${esc(s.monthly_markup)}"> تومان</p><p>افزایش قیمت ساعتی روی قیمت فعلی Mahan: <input name="hourly_extra" value="${esc(s.hourly_extra)}"> تومان</p><p>هشدار موجودی کمتر از: <input name="low_balance_threshold" value="${esc(s.low_balance_threshold)}"> تومان</p><p>تکرار هشدار (دقیقه): <input name="low_balance_repeat_minutes" value="${esc(s.low_balance_repeat_minutes)}"></p><p>مهلت بعد از خاموشی (ساعت): <input name="grace_hours" value="${esc(s.grace_hours)}"></p><p>شماره کارت: <input name="payment_card" value="${esc(s.payment_card)}" style="width:240px"></p><p>نام صاحب کارت: <input name="payment_card_holder" value="${esc(s.payment_card_holder)}"></p><button>ذخیره تنظیمات</button></form></div><div class="card"><h2>قیمت پلن‌ها</h2><p class="muted">خالی یا 0 = استفاده از فرمول پیش‌فرض. قیمت نهایی را مستقیم وارد کنید.</p><table><thead><tr><th>پلن</th><th>قیمت Hamoon ماهانه</th><th>قیمت نهایی ماهانه</th><th>قیمت نهایی ساعتی</th></tr></thead><tbody>${rows}</tbody></table></div><form method="post" action="/admin/logout"><button>خروج</button></form>`);
}
function startPanel() {
  const server=http.createServer(async(req,res)=>{
    try {
      const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
      if(u.pathname==='/health')return sendHtml(res,200,'ok');
      if(u.pathname==='/admin/login') {
        const t=loginTokens.get(u.searchParams.get('token')); if(!t||t.expires<Date.now())return sendHtml(res,401,layout('ورود','<div class="card">لینک ورود نامعتبر یا منقضی است.</div>'));
        loginTokens.delete(u.searchParams.get('token')); const sid=crypto.randomBytes(24).toString('base64url'); sessions.set(sid,{adminId:t.adminId,expires:Date.now()+12*3600_000}); res.setHeader('Set-Cookie',`mahan_admin_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`); res.statusCode=302;res.setHeader('location','/admin');return res.end();
      }
      if(!authed(req))return sendHtml(res,401,layout('ورود','<div class="card">برای ورود، در تلگرام دستور /admin را بزنید و لینک یک‌بارمصرف را باز کنید.</div>'));
      if(u.pathname==='/admin'&&req.method==='GET')return sendHtml(res,200,await renderPanel());
      if(u.pathname==='/admin/settings'&&req.method==='POST') {
        const b=await body(req); for(const k of ['monthly_markup','hourly_extra','low_balance_threshold','low_balance_repeat_minutes','grace_hours']){const n=amount(b[k]);if(n!==null)await saveSetting(k,n);} await saveSetting('payment_card',String(b.payment_card||'').trim());await saveSetting('payment_card_holder',String(b.payment_card_holder||'').trim());config.payment.card=String(b.payment_card||'').trim();config.payment.cardHolder=String(b.payment_card_holder||'').trim(); return sendHtml(res,200,await renderPanel('تنظیمات ذخیره شد.'));
      }
      if(u.pathname==='/admin/price'&&req.method==='POST') { const b=await body(req),d=['hourly','monthly'].includes(b.duration)?b.duration:null,p=amount(b.final_price);if(!d||p===null)return sendHtml(res,400,layout('خطا','<div class="card">قیمت نامعتبر است.</div>'));await saveOverride(b.plan_id,d,p);return sendHtml(res,200,await renderPanel(`قیمت ${String(b.plan_id).toUpperCase()} ذخیره شد.`)); }
      if(u.pathname==='/admin/logout'&&req.method==='POST'){const sid=cookie(req).mahan_admin_session;if(sid)sessions.delete(sid);res.setHeader('Set-Cookie','mahan_admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return sendHtml(res,200,layout('خروج','<div class="card">خارج شدید.</div>'));}
      sendHtml(res,404,layout('یافت نشد','<div class="card">صفحه پیدا نشد.</div>'));
    } catch(e){console.error('[mahan-admin]',e);sendHtml(res,500,layout('خطا','<div class="card">خطای داخلی.</div>'));}
  });
  server.listen(panelPort,panelHost,()=>console.log(`[startup] Mahan admin panel listening on ${panelHost}:${panelPort}`));
}

async function featureCallback(bot,q) {
  const data=String(q.data||'');
  if(/^plans:(hourly|monthly):/.test(data)) { await bot.answerCallbackQuery(q.id).catch(()=>{}); await showLocations(bot,q,data.split(':')[1]); return true; }
  if(data.startsWith('mxloc:')) { const[,d,l]=data.split(':'); await bot.answerCallbackQuery(q.id).catch(()=>{}); await showPlans(bot,q,d,l); return true; }
  if(data.startsWith('mxplan:')) { const[,d,l,...rest]=data.split(':'); await bot.answerCallbackQuery(q.id).catch(()=>{}); await showPlan(bot,q,d,l,rest.join(':')); return true; }
  if(data.startsWith('mxbuy:')) { const[,d,l,...rest]=data.split(':'); await buy(bot,q,d,l,rest.join(':')); return true; }
  if(data.startsWith('srvon:')) return handlePowerOn(bot,q);
  if(data==='adminweb'&&isAdmin(q.from.id)) { await bot.answerCallbackQuery(q.id).catch(()=>{}); if(!panelPublicUrl){await bot.sendMessage(q.message.chat.id,`پنل فعال است اما ADMIN_PANEL_PUBLIC_URL تنظیم نشده. پورت ${panelPort}`);return true;}const t=newLogin(q.from.id);await bot.sendMessage(q.message.chat.id,`🌐 لینک ورود یک‌بارمصرف پنل مدیریت (۱۰ دقیقه):\n${panelPublicUrl}/admin/login?token=${t}\n\nاین لینک را برای کسی نفرستید.`);return true; }
  return false;
}
async function startRuntime(bot) {
  if(started)return; started=true; runtimeBot=bot;
  await schema(); startPanel();
  setInterval(billingTick,billingPollMs).unref();setTimeout(billingTick,15_000).unref();
  setInterval(upstreamTick,upstreamPollMs).unref();setTimeout(upstreamTick,20_000).unref();
  console.log('[startup] Mahan reseller feature layer active');
}

const originalOn=TelegramBot.prototype.on;
TelegramBot.prototype.on=function patchedOn(event,listener) {
  const bot=this; if(!runtimeBot)setTimeout(()=>startRuntime(bot).catch(e=>console.error('[mahan-feature-start]',e)),250);
  if(event==='callback_query') return originalOn.call(this,event,async q=>{try{if(await featureCallback(bot,q))return;}catch(e){console.error('[mahan-feature-callback]',e);await bot.answerCallbackQuery(q.id,{text:'خطایی رخ داد.',show_alert:true}).catch(()=>{});return;}return listener(q);});
  return originalOn.call(this,event,listener);
};
const originalOnText=TelegramBot.prototype.onText;
TelegramBot.prototype.onText=function patchedOnText(regexp,callback) {
  const bot=this; if(!runtimeBot)setTimeout(()=>startRuntime(bot).catch(e=>console.error('[mahan-feature-start]',e)),250);
  if(regexp instanceof RegExp && regexp.source==='^\\/admin$') return originalOnText.call(this,regexp,async(...args)=>{await callback(...args);const msg=args[0];if(isAdmin(msg.from.id))await bot.sendMessage(msg.chat.id,'🌐 مدیریت قیمت‌ها، کارت و تنظیمات:',{reply_markup:{inline_keyboard:[[{text:'🌐 پنل وب مدیریت',callback_data:'adminweb'}]]}});});
  return originalOnText.call(this,regexp,callback);
};
