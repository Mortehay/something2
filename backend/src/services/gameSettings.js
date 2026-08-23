// Admin-tunable game constants. One jsonb row per key.
//
// DEFAULTS is BOTH the fallback and the write whitelist. An unknown key is an
// error, never a silent insert: a typo'd key that inserts successfully is a
// setting nothing reads, and it would sit in the admin table looking correct
// forever.
//
// THE XP CURVE IS DELIBERATELY NOT HERE (design doc section 3.5). Changing it
// re-levels every character in the database on the next read; that must be a
// code change with a migration attached, not a number in a form.

const DEFAULTS = Object.freeze({
  passive_points_per_level: 1,
  ground_item_ttl_seconds: 180,
  respec_base_gold: 50,
  rarity_weights: [
    { item_level: 1, white: 90, blue: 9, yellow: 1, foxy: 0 },
    { item_level: 50, white: 70, blue: 21, yellow: 8, foxy: 1 },
    { item_level: 150, white: 45, blue: 30, yellow: 20, foxy: 5 },
  ],
});

const RARITIES = ['white', 'blue', 'yellow', 'foxy'];

function bad(message) {
  const err = new Error(message);
  err.status = 400; // the route turns this into a 400 instead of a 500
  return err;
}

function isKnownKey(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(DEFAULTS, key);
}

function isCount(v, min) {
  return typeof v === 'number' && Number.isInteger(v) && v >= min;
}

// Validation lives here rather than in the route so the store and the HTTP
// surface can never disagree about what a legal value is.
function assertValid(key, value) {
  if (key === 'passive_points_per_level' && !isCount(value, 0)) {
    throw bad('passive_points_per_level must be an integer >= 0');
  }
  if (key === 'ground_item_ttl_seconds' && !isCount(value, 1)) {
    throw bad('ground_item_ttl_seconds must be an integer >= 1');
  }
  if (key === 'respec_base_gold' && !isCount(value, 0)) {
    throw bad('respec_base_gold must be an integer >= 0');
  }
  if (key === 'rarity_weights') {
    if (!Array.isArray(value) || value.length === 0) {
      throw bad('rarity_weights must be a non-empty array of anchor rows');
    }
    for (const row of value) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || !isCount(row.item_level, 1)) {
        throw bad('rarity_weights rows need an integer item_level >= 1');
      }
      for (const r of RARITIES) {
        // A weight that does not sum to 100 is fine -- the roller normalises.
        // A negative one is not: it makes the distribution unrepresentable.
        if (typeof row[r] !== 'number' || !Number.isFinite(row[r]) || row[r] < 0) {
          throw bad(`rarity_weights rows need a finite, non-negative ${r} weight`);
        }
      }
    }
  }
}

// Every requested known key comes back, defaults filled in first and then
// overwritten by whatever rows exist. A caller therefore never has to handle
// "the row is missing", which is the state a fresh database and a deleted row
// share.
async function getSettings(pool, keys) {
  const wanted = (Array.isArray(keys) && keys.length ? keys : Object.keys(DEFAULTS)).filter(isKnownKey);
  const out = {};
  for (const k of wanted) out[k] = DEFAULTS[k];
  if (wanted.length === 0) return out;
  const r = await pool.query(
    'SELECT key, value FROM game_settings WHERE key = ANY($1::text[])',
    [wanted],
  );
  for (const row of r.rows) out[row.key] = row.value;
  return out;
}

async function getSetting(pool, key) {
  if (!isKnownKey(key)) throw bad(`unknown setting: ${key}`);
  const bundle = await getSettings(pool, [key]);
  return bundle[key];
}

async function setSetting(pool, key, value) {
  if (!isKnownKey(key)) throw bad(`unknown setting: ${key}`);
  assertValid(key, value);
  const r = await pool.query(
    `INSERT INTO game_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     RETURNING key, value, updated_at`,
    [key, JSON.stringify(value)],
  );
  return r.rows[0];
}

module.exports = { DEFAULTS, getSetting, getSettings, setSetting };
