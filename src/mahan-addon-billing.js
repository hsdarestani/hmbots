'use strict';

const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const Database = require('./db');
const { CoreApi, CoreApiError } = require('./core-api');

const db = new Database(config.dbPath);
const api = new CoreApi(config.upstream);
const FIRST_RENEWAL_MS = 719 * 3600_000; // one hour before upstream's 720h renewal
const RENEWAL_MS = 720 * 3600_000;
const POLL_MS = Math.max(60_000, Number(process.env.MAHAN_ADDON_BILLING_POLL_MS || 120_000));
let runtimeBot = null;
let initialized = false;
let workerStarted = false;
let busy = false;

function money(value) {
  return `${Math.round(Number(value || 0)).toLocaleString('fa-IR')} ${config.currencyLabel}`;
}

async function setting(key, fallback) {
  const row = await db.get('SELECT value FROM app_settings WHERE key=?', [key]).catch(() => null);
  return row ? row.value : fallback;
}

async function init() {
  if (initialized) return;
  await db.init();
  await db.run(`CREATE TABLE IF NOT EXISTS mahan_additional_ip_billing(
    floating_ip_id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    ip TEXT,
    price INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    next_billing_at TEXT NOT NULL,
    last_billed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.run('CREATE INDEX IF NOT EXISTS idx_mahan_additional_ip_due ON mahan_additional_ip_billing(status,next_billing_at)');
  initialized = true;
}

async function registerAdditionalIp(serverId, description, response) {
  await init();
  const ip = response?.additional_ip;
  const floatingId = ip?.id;
  if (!floatingId) return;
  const match = String(description || '').match(/Mahan customer\s+(\d+)/i);
  let ownerId = match?.[1] || null;
  if (!ownerId) {
    const row = await db.getServer(serverId).catch(() => null);
    ownerId = row?.owner_id ? String(row.owner_id) : null;
  }
  if (!ownerId) return;
  const price = Math.max(0, Number(await setting('extra_ip_price', '900000')) || 900000);
  const next = new Date(Date.now() + FIRST_RENEWAL_MS).toISOString();
  await db.run(`INSERT OR IGNORE INTO mahan_additional_ip_billing
    (floating_ip_id,server_id,owner_id,ip,price,status,next_billing_at,last_billed_at)
    VALUES(?,?,?,?,?,'active',?,CURRENT_TIMESTAMP)`, [String(floatingId),String(serverId),ownerId,String(ip.ip || ''),price,next]);
}

const originalAddAdditionalIp = CoreApi.prototype.addAdditionalIp;
CoreApi.prototype.addAdditionalIp = async function trackedAdditionalIp(serverId, description = '') {
  const result = await originalAddAdditionalIp.call(this, serverId, description);
  registerAdditionalIp(serverId, description, result).catch(error => {
    console.error('[mahan-addon-register]', error.message || error);
  });
  return result;
};

async function cancelLocal(floatingId) {
  await db.run(`UPDATE mahan_additional_ip_billing SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE floating_ip_id=?`, [String(floatingId)]);
}

async function notify(ownerId, text) {
  if (!runtimeBot) return;
  await runtimeBot.sendMessage(String(ownerId), text).catch(() => {});
}

async function processDue(row) {
  const server = await db.getServer(row.server_id).catch(() => null);
  if (!server || server.deleted_at) {
    await cancelLocal(row.floating_ip_id);
    return;
  }

  let current;
  try {
    const response = await api.listAdditionalIps(row.server_id);
    current = Array.isArray(response?.additional_ips) ? response.additional_ips : [];
  } catch (error) {
    console.warn('[mahan-addon-list]', { server_id: row.server_id, message: error.message || error });
    return;
  }
  if (!current.some(ip => String(ip.id) === String(row.floating_ip_id))) {
    await cancelLocal(row.floating_ip_id);
    return;
  }

  const price = Math.max(0, Number(await setting('extra_ip_price', String(row.price || 900000))) || Number(row.price || 900000));
  const paid = await db.debitIfEnough(row.owner_id, price);
  if (paid) {
    const previousDue = Date.parse(row.next_billing_at) || Date.now();
    const next = new Date(Math.max(previousDue + RENEWAL_MS, Date.now() + RENEWAL_MS - 3600_000)).toISOString();
    await db.run(`UPDATE mahan_additional_ip_billing
      SET price=?,last_billed_at=CURRENT_TIMESTAMP,next_billing_at=?,updated_at=CURRENT_TIMESTAMP
      WHERE floating_ip_id=? AND status='active'`, [price,next,String(row.floating_ip_id)]);
    await notify(row.owner_id, `✅ IP اضافه ${row.ip || ''} برای سرور #${String(row.server_id).slice(-8)} تمدید شد.\n💳 مبلغ کسرشده: ${money(price)}\n⏳ دوره: ۳۰ روز`);
    return;
  }

  try {
    await api.deleteAdditionalIp(row.server_id, row.floating_ip_id);
    await cancelLocal(row.floating_ip_id);
    await notify(row.owner_id, `⚠️ به دلیل کافی نبودن موجودی، IP اضافه ${row.ip || ''} برای سرور #${String(row.server_id).slice(-8)} تمدید نشد و حذف شد.\nبرای خرید مجدد ابتدا کیف پول را شارژ کنید.`);
  } catch (error) {
    if (error instanceof CoreApiError && error.code === 'ADDITIONAL_IP_NOT_FOUND') {
      await cancelLocal(row.floating_ip_id);
      return;
    }
    console.error('[mahan-addon-cancel]', { floating_ip_id: row.floating_ip_id, message: error.message || error });
  }
}

async function billingTick() {
  if (busy) return;
  busy = true;
  try {
    await init();
    const due = await db.all(`SELECT * FROM mahan_additional_ip_billing
      WHERE status='active' AND datetime(next_billing_at) <= datetime('now')
      ORDER BY next_billing_at ASC LIMIT 30`);
    for (const row of due) await processDue(row);
  } catch (error) {
    console.error('[mahan-addon-billing]', error.message || error);
  } finally {
    busy = false;
  }
}

function startWorker(bot) {
  runtimeBot = bot;
  if (workerStarted) return;
  workerStarted = true;
  init().then(() => {
    setTimeout(billingTick, 20_000).unref();
    setInterval(billingTick, POLL_MS).unref();
    console.log('[startup] Mahan additional IP billing active');
  }).catch(error => console.error('[mahan-addon-start]', error.message || error));
}

const originalOn = TelegramBot.prototype.on;
TelegramBot.prototype.on = function mahanAddonOn(event, listener) {
  startWorker(this);
  return originalOn.call(this, event, listener);
};
