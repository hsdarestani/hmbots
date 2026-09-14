'use strict';

const https = require('https');

const base = String(process.env.ADMIN_PANEL_PUBLIC_URL || '').replace(/\/$/, '');
if (base.startsWith('https://')) {
  setTimeout(() => {
    let target;
    try { target = new URL(`${base}/admin`); } catch (_) { return; }
    const req = https.request(target, {
      method: 'GET',
      timeout: 6000,
      headers: { 'User-Agent': 'mahan-admin-self-check/1.0' }
    }, res => {
      res.resume();
      const status = Number(res.statusCode || 0);
      if (status === 401 || status === 200 || status === 302) {
        console.log('[startup] Mahan admin public route reachable', { status });
      } else {
        console.warn('[startup] Mahan admin public route unexpected status', { status });
      }
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', error => console.warn('[startup] Mahan admin public route unavailable', { message: error.message }));
    req.end();
  }, 5000).unref();
}
