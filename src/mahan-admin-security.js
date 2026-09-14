'use strict';

const http = require('http');
const previousCreateServer = http.createServer;

http.createServer = function securedAdminCreateServer(listener, ...rest) {
  if (typeof listener !== 'function') return previousCreateServer.call(http, listener, ...rest);
  return previousCreateServer.call(http, (req, res) => {
    let path = '';
    try { path = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; } catch (_) {}
    if (path === '/admin' || path.startsWith('/admin/')) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
      const originalSetHeader = res.setHeader.bind(res);
      res.setHeader = function secureCookie(name, value) {
        if (String(name).toLowerCase() === 'set-cookie') {
          const addSecure = v => String(v).includes('mahan_admin_session=') && !/;\s*Secure/i.test(String(v)) ? `${v}; Secure` : v;
          value = Array.isArray(value) ? value.map(addSecure) : addSecure(value);
        }
        return originalSetHeader(name, value);
      };
    }
    return listener(req, res);
  }, ...rest);
};
