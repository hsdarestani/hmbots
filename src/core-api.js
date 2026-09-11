'use strict';

const axios = require('axios');

class CoreApiError extends Error {
  constructor(message, { status = 0, code = 'UPSTREAM_ERROR', details = null, requestId = null } = {}) {
    super(message);
    this.name = 'CoreApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

class CoreApi {
  constructor(config) {
    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'white-label-reseller-bot/1.0'
      },
      validateStatus: () => true
    });
  }

  async request(method, path, data) {
    let response;
    try {
      response = await this.http.request({ method, url: path, data });
    } catch (error) {
      throw new CoreApiError('سرویس اصلی در دسترس نیست.', { code: 'NETWORK_ERROR' });
    }
    const body = response.data || {};
    if (response.status >= 200 && response.status < 300 && body.ok !== false) return body;
    throw new CoreApiError(
      body?.error?.message || 'درخواست توسط سرویس اصلی انجام نشد.',
      {
        status: response.status,
        code: body?.error?.code || `HTTP_${response.status}`,
        details: body?.error?.details || null,
        requestId: response.headers?.['x-request-id'] || null
      }
    );
  }

  me() { return this.request('GET', '/me'); }
  wallet() { return this.request('GET', '/wallet'); }
  prices() { return this.request('GET', '/prices'); }
  listServers() { return this.request('GET', '/servers'); }
  getServer(id) { return this.request('GET', `/servers/${encodeURIComponent(id)}`); }
  createServer(payload) { return this.request('POST', '/servers', payload); }
  deleteServer(id) { return this.request('DELETE', `/servers/${encodeURIComponent(id)}`); }
  powerOn(id) { return this.request('POST', `/servers/${encodeURIComponent(id)}/poweron`, {}); }
  powerOff(id) { return this.request('POST', `/servers/${encodeURIComponent(id)}/poweroff`, {}); }
  resetPassword(id) { return this.request('POST', `/servers/${encodeURIComponent(id)}/reset-password`, {}); }
  traffic(id) { return this.request('GET', `/servers/${encodeURIComponent(id)}/traffic`); }
}

module.exports = { CoreApi, CoreApiError };
