// The two paid-upgrade operations, both transactional and both authoritative:
//
//   enchantItem  spend one enchant scroll on a weapon (+0..+15)
//   upgradeSkill spend gold to raise a skill one level (0..15)
//
// The rules (odds, damage per level, price curve) live in services/enchant.js and
// services/skillLeveling.js. This file only moves the state: it re-reads the rows
// FROM THE DATABASE under a lock (the in-memory inventory is a cache that can be
// stale, never a source of truth for a money or item movement), applies the rule,
// commits, and only then mirrors the result into the live player.

const enchant = require('../services/enchant.js');
const leveling = require('../services/skillLeveling.js');
const { getSkillById } = require('../../seeds/data/skills.js');

// -- weapon enchanting --------------------------------------------------------

// Spends ONE scroll from the stack `scrollId` on the weapon `itemId`.
//
// Returns { ok: true, outcome, level, itemId, scrollId, scrollsLeft, destroyed }
// or { ok: false, reason }. A refusal changes nothing: every check that can fail
// runs before the scroll is consumed, inside one transaction, so there is no state
// in which a scroll is spent and no outcome is recorded.
//
// `rng` is injectable so a test can force a success or a burn.
async function enchantItem(pool, entry, userId, characterId, scrollId, itemId, {
  rng = Math.random, cfg = enchant.ENCHANT_CONFIG,
} = {}) {
  const p = entry.world.getPlayer(userId);
  if (!p || !p.inv) return { ok: false, reason: 'no player' };
  if (typeof scrollId !== 'string' || typeof itemId !== 'string') return { ok: false, reason: 'choose a scroll and a weapon' };
  if (scrollId === itemId) return { ok: false, reason: 'choose a scroll and a weapon' };

  // Cheap refusals first, off the cache. The transaction below repeats every one of
  // them against the database, so a stale cache can cost a spurious refusal here but
  // can never let a bad enchant through.
  const cachedScroll = p.inv.items.find((it) => it.id === scrollId);
  const cachedItem = p.inv.items.find((it) => it.id === itemId);
  if (!cachedScroll) return { ok: false, reason: 'you do not own that scroll' };
  if (!cachedItem) return { ok: false, reason: 'you do not own that weapon' };
  const weapons = entry.world.weapons;
  const scrollType = weapons.get(cachedScroll.typeId);
  if (!scrollType || scrollType.name !== cfg.scrollItemName) return { ok: false, reason: 'that is not an enchant scroll' };
  const pre = enchant.checkEnchantable(cachedItem, weapons.get(cachedItem.typeId), cfg);
  if (!pre.ok) return pre;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Both rows, locked in id order so two concurrent enchants cannot deadlock.
    const rows = await client.query(
      `SELECT pi.id, pi.quantity, pi.enchant_level, it.name, it.category
         FROM player_items pi
         JOIN item_types it ON it.id = pi.item_type_id
        WHERE pi.id = ANY($1::uuid[]) AND pi.character_id = $2
        ORDER BY pi.id
          FOR UPDATE OF pi`,
      [[scrollId, itemId], characterId],
    );
    const scroll = rows.rows.find((r) => r.id === scrollId);
    const target = rows.rows.find((r) => r.id === itemId);
    if (!scroll || Number(scroll.quantity) < 1) { await client.query('ROLLBACK'); return { ok: false, reason: 'you do not own that scroll' }; }
    if (!target) { await client.query('ROLLBACK'); return { ok: false, reason: 'you do not own that weapon' }; }
    if (scroll.name !== cfg.scrollItemName) { await client.query('ROLLBACK'); return { ok: false, reason: 'that is not an enchant scroll' }; }
    const check = enchant.checkEnchantable(
      { enchantLevel: Number(target.enchant_level) }, { category: target.category }, cfg,
    );
    if (!check.ok) { await client.query('ROLLBACK'); return check; }

    // The scroll goes first and unconditionally: once the dice are rolled it is
    // spent whatever they say.
    const stack = Number(scroll.quantity);
    if (stack > 1) {
      await client.query('UPDATE player_items SET quantity = quantity - 1 WHERE id = $1', [scrollId]);
    } else {
      await client.query('DELETE FROM player_items WHERE id = $1', [scrollId]);
    }

    const result = enchant.rollEnchant(Number(target.enchant_level), rng, cfg);
    if (result.outcome === 'success') {
      await client.query('UPDATE player_items SET enchant_level = $2 WHERE id = $1', [itemId, result.level]);
    } else if (result.outcome === 'destroyed') {
      // Equipment rows and an inserted stone's socket reference both cascade / null
      // out on delete (player_equipment.item_id ON DELETE CASCADE, stone_instances
      // .socketed_into_id ON DELETE SET NULL), so the burnt weapon leaves nothing behind.
      await client.query('DELETE FROM player_items WHERE id = $1', [itemId]);
    }
    await client.query('COMMIT');

    // Mirror into the live inventory only after the commit.
    const scrollsLeft = stack - 1;
    if (scrollsLeft > 0) cachedScroll.quantity = scrollsLeft;
    else p.inv.items = p.inv.items.filter((it) => it.id !== scrollId);

    const destroyed = result.outcome === 'destroyed';
    const wasEquipped = Object.values(p.inv.equipment || {}).includes(itemId);
    if (destroyed) {
      p.inv.items = p.inv.items.filter((it) => it.id !== itemId);
      for (const [slot, id] of Object.entries(p.inv.equipment || {})) {
        if (id === itemId) delete p.inv.equipment[slot];
      }
    } else if (result.outcome === 'success') {
      cachedItem.enchantLevel = result.level;
    }
    return {
      ok: true, outcome: result.outcome, level: result.level, itemId, scrollId,
      scrollsLeft, destroyed, wasEquipped,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// -- skill leveling -----------------------------------------------------------

async function loadSkillLevels(pool, characterId) {
  const r = await pool.query(
    'SELECT skill_id, level FROM character_skill_levels WHERE character_id = $1',
    [characterId],
  );
  return new Map(r.rows.map((row) => [row.skill_id, Number(row.level)]));
}

// Buys the next level of `skillId` for the character, paying from users.gold.
//
// Returns { ok: true, skillId, level, cost, gold } or { ok: false, reason }.
//
// One transaction: the gold debit and the level bump commit together or not at all,
// and the debit is overdraft-proof (the WHERE guard turns "not enough gold" into a
// zero-row result). The level bump is a compare-and-set on the level we priced the
// purchase against, so two upgrades racing from two sockets cannot both pay the
// level-3 price and both land on level 4.
async function upgradeSkill(pool, entry, userId, characterId, skillId, { cfg = leveling.SKILL_LEVELING_CONFIG } = {}) {
  const p = entry.world.getPlayer(userId);
  if (!p) return { ok: false, reason: 'no player' };
  if (typeof skillId !== 'string') return { ok: false, reason: 'unknown skill' };
  const skill = getSkillById(skillId);
  if (!skill) return { ok: false, reason: 'unknown skill' };
  // A skill belongs to a class; levelling another class's skill would be paying
  // for something the character can never cast.
  if (p.className && skill.class !== p.className) return { ok: false, reason: 'that skill is not for your class' };

  const current = (p.skillLevels && p.skillLevels.get(skillId)) || 0;
  const pre = leveling.checkUpgrade(current, p.gold, cfg);
  if (!pre.ok) return pre;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The authoritative level, under a lock, so the price is the price of the level
    // actually being bought.
    const cur = await client.query(
      'SELECT level FROM character_skill_levels WHERE character_id = $1 AND skill_id = $2 FOR UPDATE',
      [characterId, skillId],
    );
    const level = cur.rowCount === 1 ? Number(cur.rows[0].level) : 0;
    // The gold figure is irrelevant here (the UPDATE below is the real guard); only
    // the level cap and the cost matter.
    const gate = leveling.checkUpgrade(level, Number.MAX_SAFE_INTEGER, cfg);
    if (!gate.ok) { await client.query('ROLLBACK'); return { ok: false, reason: gate.reason }; }

    const gr = await client.query(
      'UPDATE users SET gold = gold - $2 WHERE id = $1 AND gold >= $2 RETURNING gold',
      [userId, gate.cost],
    );
    if (gr.rowCount !== 1) { await client.query('ROLLBACK'); return { ok: false, reason: 'not enough gold', cost: gate.cost }; }

    if (level === 0) {
      // No row to lock yet, so a racing first purchase is caught here instead:
      // DO NOTHING returns zero rows when the other writer got there first.
      const first = await client.query(
        `INSERT INTO character_skill_levels (character_id, skill_id, level) VALUES ($1, $2, 1)
         ON CONFLICT (character_id, skill_id) DO NOTHING RETURNING level`,
        [characterId, skillId],
      );
      if (first.rowCount !== 1) { await client.query('ROLLBACK'); return { ok: false, reason: 'that skill changed, try again' }; }
    } else {
      await client.query(
        'UPDATE character_skill_levels SET level = $3, updated_at = now() WHERE character_id = $1 AND skill_id = $2 AND level = $4',
        [characterId, skillId, level + 1, level],
      );
    }
    // Verify the write took, rather than assume it: a lost compare-and-set leaves the
    // stored level unchanged, and we must not have charged for it.
    const after = await client.query(
      'SELECT level FROM character_skill_levels WHERE character_id = $1 AND skill_id = $2',
      [characterId, skillId],
    );
    if (after.rowCount !== 1 || Number(after.rows[0].level) !== level + 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'that skill changed, try again' };
    }
    await client.query('COMMIT');

    const gold = Number(gr.rows[0].gold) || 0;
    p.gold = gold;
    if (!p.skillLevels) p.skillLevels = new Map();
    p.skillLevels.set(skillId, level + 1);
    return { ok: true, skillId, level: level + 1, cost: gate.cost, gold };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { enchantItem, upgradeSkill, loadSkillLevels };
