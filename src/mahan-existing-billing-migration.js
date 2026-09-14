'use strict';

// Existing Mahan servers predate local renewal timestamps. Give each active
// legacy server one full fresh cycle before the new renewal engine starts
// charging it; new purchases already receive next_billing_at at creation time.
const config = require('./config');
const Database = require('./db');

setTimeout(async () => {
  const db = new Database(config.dbPath);
  try {
    await db.init();
    await db.run(`UPDATE servers
      SET next_billing_at = CASE
        WHEN duration = 'hourly' THEN datetime('now', '+1 hour')
        ELSE datetime('now', '+30 days')
      END,
      billing_state = COALESCE(NULLIF(billing_state, ''), 'active')
      WHERE deleted_at IS NULL AND next_billing_at IS NULL`);
    console.log('[startup] legacy Mahan billing timestamps migrated');
  } catch (error) {
    console.error('[mahan-billing-migration]', error.message || error);
  } finally {
    await db.close().catch(() => {});
  }
}, 5000).unref();
