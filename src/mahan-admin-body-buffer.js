'use strict';

// Ensure custom admin POST bodies are fully received before the authenticated
// legacy admin handler performs its 404-as-auth-check. This keeps wallet
// adjustment requests reliable even on slow/mobile connections.
const http = require('http');
const previousCreateServer = http.createServer;

http.createServer = function bufferedAdminCreateServer(listener, ...rest) {
  if (typeof listener !== 'function') return previousCreateServer.call(http, listener, ...rest);
  return previousCreateServer.call(http, (req, res) => {
    let path = '';
    try { path = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; } catch (_) {}
    if (req.method !== 'POST' || path !== '/admin/wallet-adjust') return listener(req, res);
    if (req.readableEnded) return listener(req, res);
    req.resume();
    req.once('end', () => listener(req, res));
  }, ...rest);
};
