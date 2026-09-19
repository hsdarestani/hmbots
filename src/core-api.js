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
  prices(location = '') {
    const suffix = location ? `?location=${encodeURIComponent(String(location).trim().toLowerCase())}` : '';
    return this.request('GET', `/prices${suffix}`);
  }
  listServers() { return this.request('GET', '/servers'); }
  images(serverType) { return this.request('GET', `/images?server_type=${encodeURIComponent(String(serverType || '').trim().toLowerCase())}`); }
  getServer(id) { return this.request('GET', `/servers/${encodeURIComponent(id)}`); }
  createServer(payload) { return this.request('POST', '/servers', payload); }
  deleteServer(id) { return this.request('DELETE', `/servers/${encodeURIComponent(id)}`); }
  powerOn(id) { return this.request('POST', `/servers/${encodeURIComponent(id)}/poweron`, {}); }
  powerOff(id) { return this.request('POST', `/servers/${encodeURIComponent(id)}/poweroff`, {}); }
  resetPassword(id) { return this.request('POST', `/servers/${encodeURIComponent(id)}/reset-password`, {}); }
  rename(id, name) { return this.request('PATCH', `/servers/${encodeURIComponent(id)}/name`, { name }); }
  traffic(id) { return this.request('GET', `/servers/${encodeURIComponent(id)}/traffic`); }
  changeBillingCycle(id, duration) { return this.request('POST', `/servers/${encodeURIComponent(id)}/billing-cycle`, { duration }); }
  safeUpgrade(id, targetServerType, upgradeDisk = false) { return this.request('POST', `/servers/${encodeURIComponent(id)}/upgrade-safe`, { target_server_type: targetServerType, upgrade_disk: !!upgradeDisk }); }
  changeIp(id) { return this.request('POST', `/servers/${encodeURIComponent(id)}/change-ip`, {}); }
  listAdditionalIps(id) { return this.request('GET', `/servers/${encodeURIComponent(id)}/additional-ips`); }
  addAdditionalIp(id, description = '') { return this.request('POST', `/servers/${encodeURIComponent(id)}/additional-ips`, { description }); }
  deleteAdditionalIp(id, floatingIpId) { return this.request('DELETE', `/servers/${encodeURIComponent(id)}/additional-ips/${encodeURIComponent(floatingIpId)}`); }
  buyTrafficAddon(id, packageTb, nonce) { return this.request('POST', `/servers/${encodeURIComponent(id)}/traffic-addons`, { package_tb: packageTb, nonce }); }
  rebuildImages(id) { return this.request('GET', `/servers/${encodeURIComponent(id)}/rebuild-images`); }
  rebuild(id, image) { return this.request('POST', `/servers/${encodeURIComponent(id)}/rebuild`, { image }); }
}

module.exports = { CoreApi, CoreApiError };