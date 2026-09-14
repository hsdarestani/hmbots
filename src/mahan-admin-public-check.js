'use strict';

const https = require('https');

const base = String(process.env.ADMIN_PANEL_PUBLIC_URL || '').replace(/\/$/, '');

if (base.startsWith('https://')) {
  let attempts = 0;
  const maxAttempts = 12;

  function check() {
    attempts += 1;
    let target;
    try { target = new URL(`${base}/admin`); } catch (_) { return; }

    const req = https.request(target, {
      method: 'GET',
      timeout: 7000,
      headers: { 'User-Agent': 'mahan-admin-self-check/1.1' }
    }, res => {
      res.resume();
      const status = Number(res.statusCode || 0);
      if (status === 401 || status === 200 || status === 302) {
        console.log('[startup] Mahan admin public route reachable', { status, attempts });
        return;
      }
      console.warn('[startup] Mahan admin public route unexpected status', { status, attempts });
      if (attempts < maxAttempts) setTimeout(check, 10000).unref();
    });

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', error => {
      console.warn('[startup] Mahan admin public route unavailable', { message: error.message, attempts });
      if (attempts < maxAttempts) setTimeout(check, 10000).unref();
    });
    req.end();
  }

  setTimeout(check, 5000).unref();
}
