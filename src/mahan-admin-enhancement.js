'use strict';

// Extends the existing authenticated Mahan admin page without duplicating its
// login/session implementation. The legacy panel remains the authentication
// authority; this wrapper only augments successful /admin responses and handles
// a small set of custom POST actions after the legacy handler has authenticated
// the session (legacy returns 404 for authenticated unknown admin routes, 401
// otherwise).
const http = require('http');
const config = require('./config');
const Database = require('./db');
const { CoreApi } = require('./core-api');

const db = new Database(config.dbPath);
const api = new CoreApi(config.upstream);
const originalCreateServer = http.createServer;
let initialized = false;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function money(value) {
  return `${Math.round(Number(value || 0)).toLocaleString('fa-IR')} ${config.currencyLabel}`;
}
function faToEn(value) {
  const map = {'۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9','٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
  return String(value ?? '').replace(/[۰-۹٠-٩]/g, c => map[c] || c);
}
function amount(value) {
  const n = Number(faToEn(value).replace(/[,_\s،]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? esc(value) : d.toLocaleString('fa-IR');
}
async function init() {
  if (initialized) return;
  await db.init();
  initialized = true;
}
async function snapshot() {
  await init();
  const stats = await db.stats();
  const billing = await db.get(`SELECT
    SUM(CASE WHEN billing_state='grace' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS grace_count,
    SUM(CASE WHEN deleted_at IS NULL AND (billing_state IS NULL OR billing_state='active') THEN 1 ELSE 0 END) AS active_count
    FROM servers`).catch(() => ({ grace_count: 0, active_count: stats.servers || 0 }));
  const users = await db.all(`SELECT telegram_id, username, first_name, balance, updated_at
    FROM users ORDER BY updated_at DESC LIMIT 40`);
  const servers = await db.all(`SELECT server_id, owner_id, plan_id, duration, sale_price, status,
    location, billing_state, next_billing_at, grace_until, public_ip
    FROM servers WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 50`).catch(async () =>
      db.all(`SELECT server_id, owner_id, plan_id, duration, sale_price, status, public_ip
        FROM servers WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 50`));
  const pending = await db.pendingTopups(20);
  let upstreamBalance = null;
  let upstreamOk = false;
  try {
    upstreamBalance = Number((await api.wallet())?.wallet?.balance || 0);
    upstreamOk = true;
  } catch (_) {}
  return { stats, billing, users, servers, pending, upstreamBalance, upstreamOk };
}
function badge(text, kind='') { return `<span class="mx-badge ${kind}">${esc(text)}</span>`; }
function durationLabel(value) { return value === 'hourly' ? 'ساعتی' : value === 'monthly' ? 'ماهانه' : String(value || '—'); }

async function extraHtml(note='') {
  const x = await snapshot();
  const usersRows = x.users.map(u => `<tr>
    <td>${esc(u.first_name || '—')}<br><span class="muted">${u.username ? '@'+esc(u.username) : ''}</span></td>
    <td><code>${esc(u.telegram_id)}</code></td><td>${esc(money(u.balance))}</td><td>${fmtDate(u.updated_at)}</td>
  </tr>`).join('') || '<tr><td colspan="4">کاربری ثبت نشده است.</td></tr>';
  const serverRows = x.servers.map(s => `<tr>
    <td><code>#${esc(String(s.server_id).slice(-8))}</code><br><span class="muted">${esc(s.public_ip || '')}</span></td>
    <td>${esc(String(s.plan_id || '').toUpperCase())}<br><span class="muted">${esc(durationLabel(s.duration))} • ${esc(s.location || '—')}</span></td>
    <td><code>${esc(s.owner_id)}</code></td>
    <td>${esc(money(s.sale_price))}</td>
    <td>${badge(s.billing_state || s.status || 'active', s.billing_state === 'grace' ? 'warn' : 'okb')}</td>
    <td>${fmtDate(s.next_billing_at)}${s.grace_until ? `<br><span class="muted">مهلت: ${fmtDate(s.grace_until)}</span>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="6">سرور فعالی ثبت نشده است.</td></tr>';
  const pendingRows = x.pending.map(p => `<tr><td>#${p.id}</td><td><code>${esc(p.telegram_id)}</code></td><td>${esc(money(p.amount))}</td><td>${fmtDate(p.created_at)}</td></tr>`).join('') || '<tr><td colspan="4">درخواست شارژ در انتظار ندارید.</td></tr>';
  return `<style>
    .mx-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.mx-stat{background:#0b1220;border:1px solid #334155;border-radius:14px;padding:14px}.mx-stat b{display:block;font-size:22px;margin-top:5px}.mx-badge{display:inline-block;padding:4px 9px;border-radius:999px;background:#334155;font-size:12px}.mx-badge.okb{background:#065f46}.mx-badge.warn{background:#92400e}.mx-scroll{overflow:auto}.mx-actions{display:flex;gap:8px;flex-wrap:wrap}.mx-actions select{background:#0b1220;color:#fff;border:1px solid #475569;border-radius:8px;padding:9px}@media(max-width:800px){.mx-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.mx-scroll table{min-width:820px}}@media(max-width:480px){.mx-grid{grid-template-columns:1fr}}
  </style>
  ${note ? `<div class="ok">${esc(note)}</div>` : ''}
  <div class="card"><h2>نمای کلی</h2><div class="mx-grid">
    <div class="mx-stat">کاربران<b>${Number(x.stats.users || 0).toLocaleString('fa-IR')}</b></div>
    <div class="mx-stat">سرورهای فعال<b>${Number(x.billing?.active_count || 0).toLocaleString('fa-IR')}</b></div>
    <div class="mx-stat">در مهلت پرداخت<b>${Number(x.billing?.grace_count || 0).toLocaleString('fa-IR')}</b></div>
    <div class="mx-stat">درخواست شارژ<b>${Number(x.stats.pendingTopups || 0).toLocaleString('fa-IR')}</b></div>
    <div class="mx-stat">موجودی مشتریان<b>${esc(money(x.stats.localBalance || 0))}</b></div>
    <div class="mx-stat">موجودی تأمین‌کننده<b>${x.upstreamOk ? esc(money(x.upstreamBalance)) : 'خطای اتصال'}</b></div>
  </div></div>
  <div class="card"><h2>مدیریت موجودی مشتری</h2><p class="muted">برای اصلاح دستی کیف پول، ID تلگرام و مبلغ را وارد کنید.</p>
    <form class="inline" method="post" action="/admin/wallet-adjust"><input name="telegram_id" placeholder="Telegram ID" required><input name="amount" placeholder="مبلغ تومان" required><select name="mode"><option value="add">افزایش</option><option value="subtract">کاهش</option><option value="set">تنظیم موجودی</option></select><button>اعمال</button></form>
  </div>
  <div class="card"><h2>کاربران اخیر</h2><div class="mx-scroll"><table><thead><tr><th>کاربر</th><th>ID</th><th>موجودی</th><th>آخرین فعالیت</th></tr></thead><tbody>${usersRows}</tbody></table></div></div>
  <div class="card"><h2>سرورهای فعال</h2><div class="mx-scroll"><table><thead><tr><th>سرور</th><th>پلن</th><th>مالک</th><th>قیمت دوره</th><th>وضعیت مالی</th><th>تمدید / مهلت</th></tr></thead><tbody>${serverRows}</tbody></table></div></div>
  <div class="card"><h2>شارژهای در انتظار</h2><p class="muted">تأیید یا رد رسید همچنان از پیام ادمین تلگرام انجام می‌شود تا رسید و پیام کاربر کنار هم بمانند.</p><div class="mx-scroll"><table><thead><tr><th>#</th><th>کاربر</th><th>مبلغ</th><th>زمان</th></tr></thead><tbody>${pendingRows}</tbody></table></div></div>`;
}

function parseBody(raw) { return Object.fromEntries(new URLSearchParams(raw)); }
async function walletAdjust(raw) {
  await init();
  const b = parseBody(raw);
  const id = String(b.telegram_id || '').trim();
  const n = amount(b.amount);
  const mode = String(b.mode || 'add');
  if (!/^\d{4,20}$/.test(id) || n === null) return { ok:false, note:'ID یا مبلغ نامعتبر است.' };
  const user = await db.getUser(id);
  if (!user) return { ok:false, note:'این کاربر در ربات ثبت نشده است.' };
  if (mode === 'set') await db.run('UPDATE users SET balance=?, updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?',[n,id]);
  else if (mode === 'subtract') await db.run('UPDATE users SET balance=MAX(0,balance-?), updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?',[n,id]);
  else await db.credit(id,n);
  return { ok:true, note:`موجودی کاربر ${id} به‌روزرسانی شد.` };
}

http.createServer = function patchedCreateServer(listener, ...rest) {
  if (typeof listener !== 'function') return originalCreateServer.call(http, listener, ...rest);
  return originalCreateServer.call(http, async (req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch (_) { return listener(req,res); }
    const custom = req.method === 'POST' && url.pathname === '/admin/wallet-adjust';
    let raw = '';
    if (custom) req.on('data', chunk => { if (raw.length < 100000) raw += chunk; });

    const originalEnd = res.end.bind(res);
    let ending = false;
    res.end = function enhancedEnd(chunk, encoding, callback) {
      if (ending) return originalEnd(chunk, encoding, callback);
      const html = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      if (custom && res.statusCode === 404) {
        ending = true;
        Promise.resolve(walletAdjust(raw)).then(async result => {
          res.statusCode = result.ok ? 200 : 400;
          res.setHeader('content-type','text/html; charset=utf-8');
          const extra = await extraHtml(result.note);
          const page = html.replace('<div class="card">صفحه پیدا نشد.</div>', `${extra}<div class="card"><a href="/admin" style="color:#93c5fd">بازگشت به تنظیمات قیمت و کارت</a></div>`);
          originalEnd(page, encoding, callback);
        }).catch(error => {
          console.error('[mahan-admin-enhancement:wallet]', error);
          res.statusCode = 500;
          originalEnd('خطای داخلی', encoding, callback);
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/admin' && res.statusCode === 200 && html.includes('Mahan Cloud Admin')) {
        ending = true;
        Promise.resolve(extraHtml()).then(extra => {
          const marker = '<form method="post" action="/admin/logout">';
          const enhanced = html.includes(marker) ? html.replace(marker, `${extra}${marker}`) : html.replace('</div></body>', `${extra}</div></body>`);
          originalEnd(enhanced, encoding, callback);
        }).catch(error => {
          console.error('[mahan-admin-enhancement:render]', error);
          originalEnd(html, encoding, callback);
        });
        return;
      }
      return originalEnd(chunk, encoding, callback);
    };
    return listener(req,res);
  }, ...rest);
};
