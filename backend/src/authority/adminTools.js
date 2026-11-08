// The in-game admin menu's server side: grants for testing (gold, level, xp, passive points,
// a full restore, an item at your feet). Dependency-injected and free of sockets, so each
// action is testable without a world; server.js (debugAdmin) does the admin check and the
// pushes to the client.
//
// Every number is clamped HERE, not trusted from the message, and every action reports what it
// actually did (the clamped value), so the menu can say "gold +1,000,000,000 (capped)" instead of
// silently granting less.
const { xpFloor, levelForXp } = require('../services/playerStats.js');
const { loadProgression, awardXp } = require('../services/progressionStore.js');
const { getSetting } = require('../services/gameSettings.js');
const { awardGold } = require('../services/bossGate.js');
const { rollItemInstance, RARITIES } = require('./affixes.js');

const MAX_GOLD_GRANT = 1_000_000_000;
const MAX_XP_GRANT = 100_000_000_000;
const MAX_POINTS_GRANT = 1000;
const MAX_ITEM_LEVEL = 200;
const GROUND_ITEM_MS = 10 * 60 * 1000;

// A whole number in [1, max], or 0 for anything else (a string, NaN, negative, absent).
function amountOf(v, max) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(n, max);
}

async function giveGold(pool, characterId, rawAmount) {
  const amount = amountOf(rawAmount, MAX_GOLD_GRANT);
  if (!amount) return { ok: false, error: 'gold must be a positive whole number' };
  const gold = await awardGold(pool, characterId, amount);
  if (gold == null) return { ok: false, error: 'no such character' };
  return { ok: true, gold, granted: amount, capped: amount < Math.floor(Number(rawAmount)) };
}

// Sets the character's level exactly (up or down): experience goes to that level's floor. Levels
// GAINED pay the passive points a real level-up would; going down takes none away (a test tool
// must not eat points a tester already spent).
async function setLevel(pool, characterId, rawLevel) {
  const wanted = amountOf(rawLevel, 10_000);
  if (!wanted) return { ok: false, error: 'level must be a positive whole number' };
  const level = levelForXp(xpFloor(wanted)); // the top of the curve clamps
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await loadProgression(client, characterId, { forUpdate: true });
    const gained = Math.max(0, level - before.level);
    const perLevel = gained > 0 ? Number(await getSetting(client, 'passive_points_per_level')) || 0 : 0;
    await client.query(
      `UPDATE player_progression
          SET experience = $2, level = $3, passive_points = passive_points + $4, updated_at = now()
        WHERE character_id = $1`,
      [characterId, xpFloor(level), level, gained * perLevel],
    );
    await client.query('COMMIT');
    return { ok: true, level, before: before.level, pointsGained: gained * perLevel, capped: level < wanted };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Experience through the real award path (level-ups and their passive points included).
async function giveXp(pool, characterId, rawAmount) {
  const amount = amountOf(rawAmount, MAX_XP_GRANT);
  if (!amount) return { ok: false, error: 'xp must be a positive whole number' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await awardXp(client, characterId, amount, 'kill');
    await client.query('COMMIT');
    return { ok: true, granted: r.awarded, level: r.newLevel, leveledUp: r.leveledUp, pointsGained: r.pointsGained };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function givePassivePoints(pool, characterId, rawAmount) {
  const amount = amountOf(rawAmount, MAX_POINTS_GRANT);
  if (!amount) return { ok: false, error: 'points must be a positive whole number' };
  await loadProgression(pool, characterId); // creates the row on first use
  const r = await pool.query(
    'UPDATE player_progression SET passive_points = passive_points + $2, updated_at = now() WHERE character_id = $1 RETURNING passive_points',
    [characterId, amount],
  );
  return { ok: true, granted: amount, total: r.rows[0] ? Number(r.rows[0].passive_points) : null };
}

// hp, mana and stamina to full, and the dead are not raised (a corpse awaiting resolveDeaths must
// stay one, the same guard refreshDerivedStats keeps).
function restorePlayer(player) {
  if (!player || !(player.hp > 0)) return { ok: false, error: 'you are dead' };
  player.hp = player.maxHp;
  player.mana = player.maxMana;
  player.stamina = player.maxStamina;
  return { ok: true, hp: player.hp, mana: player.mana, stamina: player.stamina };
}

// An item on the ground at (x, y), held for `userId`: any item type by id, any rarity, any level.
async function dropItem(pool, entry, userId, x, y, { itemTypeId, rarity = 'white', level = 1, quantity = 1 } = {}) {
  const id = Math.floor(Number(itemTypeId));
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: 'pick an item' };
  if (!RARITIES.includes(rarity)) return { ok: false, error: `rarity must be one of ${RARITIES.join(', ')}` };
  const lvl = Math.min(MAX_ITEM_LEVEL, Math.max(1, Math.floor(Number(level)) || 1));
  const qty = Math.min(9999, Math.max(1, Math.floor(Number(quantity)) || 1));
  const t = await pool.query('SELECT id, name, category, tier, req_level FROM item_types WHERE id = $1', [id]);
  const type = t.rows[0];
  if (!type) return { ok: false, error: 'no such item' };
  const itemType = (entry.world && entry.world.weapons ? entry.world.weapons.get(type.id) : null) || type;
  // Only gear rolls affixes; a potion or a stack of ore is just the thing.
  const gear = type.category === 'weapon' || type.category === 'armor';
  const rolled = gear
    ? rollItemInstance({ itemType, itemLevel: lvl, rarity, affixPool: entry.affixPool || [] }, Math.random)
    : { affixes: [] };
  const affixJson = JSON.stringify((rolled.affixes || []).map((a) => ({ affixTypeId: a.affixTypeId, value: a.value })));
  const ins = await pool.query(
    `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity, rarity, item_level, affixes)
     VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 millisecond'), $6, $7, $8, $9::jsonb)
     RETURNING id, item_type_id, x, y, expires_at, quantity, rarity, item_level`,
    [entry.worldId, type.id, Math.round(x), Math.round(y), GROUND_ITEM_MS, gear ? 1 : qty, gear ? rarity : 'white', lvl, affixJson],
  );
  const row = ins.rows[0];
  if (row && entry.world && entry.world.groundItems) {
    entry.world.groundItems.add([row]);
    if (typeof entry.world.groundItems.reserve === 'function') {
      entry.world.groundItems.reserve(row.id, userId, Date.now() + GROUND_ITEM_MS);
    }
  }
  return { ok: true, name: type.name, rarity: gear ? rarity : 'white', level: lvl, quantity: gear ? 1 : qty };
}

module.exports = {
  giveGold, setLevel, giveXp, givePassivePoints, restorePlayer, dropItem, amountOf,
  MAX_GOLD_GRANT, MAX_XP_GRANT, MAX_POINTS_GRANT, MAX_ITEM_LEVEL,
};
