// Skill gems, owned on the server.
//
// A character owns a gem by having a row in character_gems; buying one debits users.gold
// in the same transaction as the insert, so there is no moment where the gold is gone and
// the gem is not (or the reverse). The server also re-checks everything the shop panel
// shows: the gem exists, its level/attribute/quest requirements are met, the player can
// pay, and (in the websocket handler) a gem merchant is within reach.
//
// WHAT IS NOT CHECKED: the weapon requirement. That gates CASTING (world.castSkill),
// not owning -- the shop has always let you buy a bow skill while holding a sword.

const { getSkillById, checkGemRequirements } = require('../../seeds/data/skills.js');

// The most gems a legacy import may name in one message. The catalog is 300 skills; a
// longer list is a forged message, not a player.
const MAX_IMPORT = 300;

async function loadOwnedGems(pool, characterId) {
  const r = await pool.query('SELECT skill_id FROM character_gems WHERE character_id = $1', [characterId]);
  return new Set(r.rows.map((row) => row.skill_id));
}

async function loadGemsImported(pool, characterId) {
  const r = await pool.query('SELECT gems_imported FROM characters WHERE id = $1', [characterId]);
  return r.rowCount === 1 && r.rows[0].gems_imported === true;
}

// Can this player buy `gem` right now, ignoring gold and distance? The requirements are
// exactly the shop's "available" state: everything but the weapon.
function meetsPurchaseRequirements(p, gem) {
  const ctx = p._completedQuests
    ? { completedQuests: p._completedQuests, questTitles: p._questTitles || null }
    : null;
  const req = checkGemRequirements(gem, p.stats, null, ctx);
  const ok = req.levelOk && req.strOk && req.dexOk && req.conOk && req.intOk && req.wisOk && req.chaOk
    && (ctx ? req.questsOk : !(Array.isArray(gem.reqQuests) && gem.reqQuests.length > 0));
  return { ok, req };
}

// Buys `skillId` for the character. Returns { ok: true, skillId, price, gold } or
// { ok: false, reason }.
async function buyGem(pool, entry, userId, characterId, skillId) {
  const p = entry.world.getPlayer(userId);
  if (!p) return { ok: false, reason: 'no player' };
  if (typeof skillId !== 'string') return { ok: false, reason: 'unknown skill' };
  const gem = getSkillById(skillId);
  if (!gem) return { ok: false, reason: 'unknown skill' };
  if (p.ownedGems && p.ownedGems.has(skillId)) return { ok: false, reason: 'you already own that gem' };

  const check = meetsPurchaseRequirements(p, gem);
  if (!check.ok) return { ok: false, reason: check.req.message || 'requirements not met' };

  const price = Number.isFinite(gem.gemPrice) ? gem.gemPrice : 35;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Insert FIRST: if the character already owns it (a stale cache, a second socket) the
    // unique key turns that into a zero-row result and nothing is charged.
    const ins = await client.query(
      `INSERT INTO character_gems (character_id, skill_id, price_paid) VALUES ($1, $2, $3)
       ON CONFLICT (character_id, skill_id) DO NOTHING RETURNING skill_id`,
      [characterId, skillId, price],
    );
    if (ins.rowCount !== 1) { await client.query('ROLLBACK'); return { ok: false, reason: 'you already own that gem' }; }

    // Overdraft-safe: "not enough gold" is a zero-row result, never a negative balance.
    const gr = await client.query(
      'UPDATE users SET gold = gold - $2 WHERE id = $1 AND gold >= $2 RETURNING gold',
      [userId, price],
    );
    if (gr.rowCount !== 1) { await client.query('ROLLBACK'); return { ok: false, reason: 'not enough gold', price }; }
    await client.query('COMMIT');

    const gold = Number(gr.rows[0].gold) || 0;
    p.gold = gold;
    if (!p.ownedGems) p.ownedGems = new Set();
    p.ownedGems.add(skillId);
    return { ok: true, skillId, price, gold };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// One-time claim of the gems a character holds in its browser's localStorage.
//
// The old shop recorded purchases only there, so a character that has been playing owns
// gems the server has never heard of. The claim is honoured ONCE per character and only
// for gems it QUALIFIES for today (same requirements as a purchase), at no cost: they
// were already paid for. That makes the import a bounded gift, not an exploit -- the
// worst a forged list can get is the gems the character could buy anyway, for free, once.
//
// Returns { ok: true, granted: [skillId...] } or { ok: false, reason }.
async function importLegacyGems(pool, entry, userId, characterId, skillIds) {
  const p = entry.world.getPlayer(userId);
  if (!p) return { ok: false, reason: 'no player' };
  if (!Array.isArray(skillIds)) return { ok: false, reason: 'bad list' };

  const seen = new Set();
  const wanted = [];
  for (const id of skillIds.slice(0, MAX_IMPORT)) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    const gem = getSkillById(id);
    if (gem && meetsPurchaseRequirements(p, gem).ok) wanted.push(id);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The flag flips in the same transaction as the grants, and only if it was still
    // down: a second claim (two sockets, a replayed message) gets zero rows and nothing.
    const flag = await client.query(
      'UPDATE characters SET gems_imported = true WHERE id = $1 AND gems_imported = false RETURNING id',
      [characterId],
    );
    if (flag.rowCount !== 1) { await client.query('ROLLBACK'); return { ok: false, reason: 'already imported' }; }

    const granted = [];
    for (const id of wanted) {
      const r = await client.query(
        `INSERT INTO character_gems (character_id, skill_id, price_paid) VALUES ($1, $2, 0)
         ON CONFLICT (character_id, skill_id) DO NOTHING RETURNING skill_id`,
        [characterId, id],
      );
      if (r.rowCount === 1) granted.push(id);
    }
    await client.query('COMMIT');

    if (!p.ownedGems) p.ownedGems = new Set();
    for (const id of granted) p.ownedGems.add(id);
    return { ok: true, granted };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { loadOwnedGems, loadGemsImported, buyGem, importLegacyGems, meetsPurchaseRequirements, MAX_IMPORT };
