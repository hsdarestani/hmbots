'use strict';

require('dotenv').config();
const path = require('path');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function numberEnv(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} is invalid`);
  return value;
}

function csv(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

const upstreamBase = required('UPSTREAM_API_URL').replace(/\/+$/, '');

module.exports = {
  botToken: required('BOT_TOKEN'),
  adminIds: new Set(csv(required('ADMIN_IDS')).map(String)),
  brandName: String(process.env.BRAND_NAME || 'Cloud Store').trim(),
  supportUsername: String(process.env.SUPPORT_USERNAME || '').trim().replace(/^@/, ''),
  upstream: {
    baseUrl: upstreamBase,
    apiKey: required('UPSTREAM_API_KEY'),
    timeoutMs: numberEnv('UPSTREAM_TIMEOUT_MS', 25000, { min: 3000, max: 120000 })
  },
  catalog: {
    allowedPlans: new Set(csv(process.env.ALLOWED_PLANS).map(v => v.toLowerCase())),
    defaultImage: String(process.env.DEFAULT_IMAGE || 'ubuntu-24.04').trim(),
    defaultLocation: String(process.env.DEFAULT_LOCATION || 'nbg1').trim().toLowerCase(),
    defaultDuration: ['hourly', 'monthly'].includes(String(process.env.DEFAULT_DURATION || '').toLowerCase())
      ? String(process.env.DEFAULT_DURATION).toLowerCase()
      : 'monthly',
    markupPercent: numberEnv('PRICE_MARKUP_PERCENT', 20, { min: 0, max: 10000 }),
    markupFixed: numberEnv('PRICE_MARKUP_FIXED', 0, { min: 0 }),
    roundTo: numberEnv('PRICE_ROUND_TO', 1000, { min: 1 }),
    maxVisiblePlans: numberEnv('MAX_VISIBLE_PLANS', 24, { min: 1, max: 100 })
  },
  payment: {
    minTopup: numberEnv('MIN_TOPUP', 100000, { min: 1 }),
    card: String(process.env.PAYMENT_CARD || '').trim(),
    cardHolder: String(process.env.PAYMENT_CARD_HOLDER || '').trim(),
    note: String(process.env.PAYMENT_NOTE || 'بعد از واریز، تصویر رسید را همینجا ارسال کنید.').trim()
  },
  currencyLabel: String(process.env.CURRENCY_LABEL || 'تومان').trim(),
  dbPath: path.resolve(process.env.DB_PATH || './data/bot.sqlite'),
  provisionPollMs: numberEnv('PROVISION_POLL_MS', 20000, { min: 5000, max: 300000 })
};
