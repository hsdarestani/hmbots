'use strict';

// Telegram/iOS link previews may request a one-time admin login URL before the
// human opens it. The legacy handler consumes the token on that first GET,
// leaving the real browser with "invalid or expired". Capture the successful
// login response for a very short window and replay the same session cookie for
// subsequent requests carrying the exact same token. This keeps the one-time
// token semantics while making preview-prefetched links usable.
const http = require('http');

const previousCreateServer = http.createServer;
const successfulLogins = new Map();
const REPLAY_TTL_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 200;

function cleanup(now = Date.now()) {
  for (const [token, entry] of successfulLogins) {
    if (!entry || entry.expires <= now) successfulLogins.delete(token);
  }
  while (successfulLogins.size > MAX_ENTRIES) {
    const first = successfulLogins.keys().next().value;
    if (first === undefined) break;
    successfulLogins.delete(first);
  }
}

function loginToken(req) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method !== 'GET' || url.pathname !== '/admin/login') return null;
    const token = String(url.searchParams.get('token') || '');
    return token.length >= 16 ? token : null;
  } catch (_) {
    return null;
  }
}

http.createServer = function previewSafeAdminCreateServer(listener, ...rest) {
  if (typeof listener !== 'function') return previousCreateServer.call(http, listener, ...rest);

  return previousCreateServer.call(http, (req, res) => {
    const token = loginToken(req);
    if (!token) return listener(req, res);

    cleanup();
    const cached = successfulLogins.get(token);
    if (cached && cached.expires > Date.now()) {
      res.statusCode = 302;
      res.setHeader('cache-control', 'no-store');
      res.setHeader('location', '/admin');
      res.setHeader('set-cookie', cached.cookie);
      return res.end();
    }

    const originalEnd = res.end.bind(res);
    let captured = false;
    res.end = function previewSafeEnd(chunk, encoding, callback) {
      if (!captured && res.statusCode >= 300 && res.statusCode < 400) {
        const location = String(res.getHeader('location') || '');
        const setCookie = res.getHeader('set-cookie');
        const cookies = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
        const sessionCookie = cookies.find(value => String(value).includes('mahan_admin_session='));
        if (location === '/admin' && sessionCookie) {
          successfulLogins.set(token, {
            cookie: sessionCookie,
            expires: Date.now() + REPLAY_TTL_MS
          });
          cleanup();
          captured = true;
        }
      }
      return originalEnd(chunk, encoding, callback);
    };

    return listener(req, res);
  }, ...rest);
};
