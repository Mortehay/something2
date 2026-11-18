'use strict';
// Persistence for the account loot filter. The config is re-validated on the way in (a write) and
// on the way out (a read): a row that was valid when saved but no longer is, after a rule change,
// degrades to the default rather than breaking a join.

const { sanitizeConfig, defaultConfig } = require('./lootFilter.js');

async function loadLootFilter(pool, userId) {
  const r = await pool.query('SELECT config FROM account_loot_filters WHERE user_id = $1', [userId]);
  if (r.rowCount === 0) return defaultConfig();
  try {
    return sanitizeConfig(r.rows[0].config);
  } catch (e) {
    console.error('loot filter row is invalid, using the default:', e.message);
    return defaultConfig();
  }
}

// Throws FilterError (from lootFilter.js) for a bad config. Returns the config as stored.
async function saveLootFilter(pool, userId, raw) {
  const config = sanitizeConfig(raw);
  await pool.query(
    `INSERT INTO account_loot_filters (user_id, config) VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [userId, JSON.stringify(config)],
  );
  return config;
}

module.exports = { loadLootFilter, saveLootFilter };
