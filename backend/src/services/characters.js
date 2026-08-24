// Character queries (SOMET-259).
//
// Kept out of index.js's inline routes because the slot allocation below is the
// one piece here with real logic worth testing on its own, and because the
// authority -- which has no Express request -- needs ownedCharacter too.

const { BASE_STAT } = require('./progressionConstants.js');

const MAX_CHARACTERS = 8;

const MAX_NAME_LENGTH = 32;

// SOMET-486. The ONE place entity_types' pool columns become a class's base
// pools, and the ONE column list every reader of them uses.
//
// It matters that both readers below -- listPlayableClasses (what character
// select ADVERTISES) and ownedCharacter (what a joining character GETS) --
// take their numbers from this same pair of columns through this same
// function. The defect this fixes survived since SOMET-242 precisely because
// the advertised number and the played number came from different places, and
// reading `hp` on one side and `max_hp` on the other would rebuild that split
// out of two columns that merely happen to agree today.
const CLASS_POOL_COLUMNS = 'max_hp, max_mana';

// -> { maxHp, maxMana }, each possibly null. derivePlayerStats substitutes
// HP_BASE/MANA_BASE for a null rather than producing NaN; the null is passed
// through rather than defaulted here so there is exactly one fallback, in the
// one function that owns the formula.
//
// SOMET-471 fixed a latent bug here. This read `Number(row.max_hp)` directly,
// and `Number(null)` is 0, not NaN -- so the ONE case the LEFT JOIN in
// ownedCharacter exists to serve (a character whose entity_types row has
// vanished) produced `{ maxHp: 0, maxMana: 0 }`, which is finite, which
// derivePlayerStats then used as the base instead of falling back. That
// character joins with a maximum of 0 hp. A missing column has to become null
// BEFORE the numeric coercion, not after it.
function classPoolsFromRow(row) {
  const num = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  if (row == null) return { maxHp: null, maxMana: null };
  return { maxHp: num(row.max_hp), maxMana: num(row.max_mana) };
}

class CharacterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CharacterError';
    this.code = code;
  }
}

async function listPlayableClasses(pool) {
  // ORDER BY id ASC is deliberately unchanged now that there are six classes:
  // CharacterSelect.jsx defaults the picker to classes[0], so re-ordering here
  // would silently change which class a player gets by pressing Create without
  // touching the radios.
  const r = await pool.query(
    `SELECT id, name, color, main_stat, ${CLASS_POOL_COLUMNS},
            strength, dexterity, constitution, intelligence, wisdom, charisma
       FROM entity_types WHERE is_playable = true ORDER BY id ASC`);
  // SOMET-486: `hp` (and the new `mana`) are the class's BASE POOLS, read
  // through classPoolsFromRow -- the same function and the same columns the
  // join path uses. `hp` used to come from entity_types.hp, a DIFFERENT column
  // that nothing in the running game ever consulted. The key stays named `hp`
  // because CharacterSelect.jsx already renders it.
  return r.rows.map((x) => ({
    id: x.id,
    name: x.name,
    color: x.color,
    // SOMET-471: the passive tree's start position for this class (spec 5.2).
    // The picker shows it as the class's main stat.
    mainStat: x.main_stat,
    hp: classPoolsFromRow(x).maxHp,
    mana: classPoolsFromRow(x).maxMana,
    strength: Number(x.strength),
    dexterity: Number(x.dexterity),
    constitution: Number(x.constitution),
    intelligence: Number(x.intelligence),
    wisdom: Number(x.wisdom),
    charisma: Number(x.charisma),
  }));
}

async function listCharacters(pool, userId) {
  // LEFT JOINs throughout: a freshly created character has no progression row
  // and has never been in a world, and must still list. An INNER JOIN here
  // would make a brand-new character invisible on the very screen the player
  // just created it from.
  const r = await pool.query(
    `SELECT c.id, c.slot, c.name, c.entity_type_id,
            e.name AS class_name,
            COALESCE(pr.level, 1) AS level,
            w.name AS last_world_name,
            lw.world_id AS last_world_id
       FROM characters c
       JOIN entity_types e ON e.id = c.entity_type_id
       LEFT JOIN player_progression pr ON pr.character_id = c.id
       LEFT JOIN LATERAL (
         SELECT world_id FROM world_players
          WHERE character_id = c.id ORDER BY updated_at DESC LIMIT 1
       ) lw ON true
       LEFT JOIN worlds w ON w.id = lw.world_id
      WHERE c.user_id = $1
      ORDER BY c.slot ASC`,
    [userId]);
  return r.rows.map((x) => ({
    id: x.id,
    slot: x.slot,
    name: x.name,
    className: x.class_name,
    entityTypeId: x.entity_type_id,
    level: Number(x.level),
    lastWorldName: x.last_world_name,
    // The id the client auto-joins into on the next login. lastWorldName is
    // for display only; resuming needs the id. Both come from the same LATERAL
    // row, so they can never describe different worlds.
    lastWorldId: x.last_world_id,
  }));
}

// The ownership check every caller that names a character must go through.
// Returns the character, or null when it does not exist OR is not owned -- the
// two are deliberately indistinguishable to the caller so no route can leak
// which character ids are real.
async function ownedCharacter(pool, userId, characterId) {
  const id = Number(characterId);
  if (!Number.isInteger(id)) return null;
  // LEFT JOIN, not JOIN: a character whose class row has vanished must still
  // resolve (the ownership answer is about `characters`, not `entity_types`).
  // classPoolsFromRow then yields nulls and derivePlayerStats falls back to
  // HP_BASE/MANA_BASE -- a pool-less join, not a refused one.
  const r = await pool.query(
    `SELECT c.id, c.entity_type_id, c.inventory_slots,
            e.name AS class_name, e.main_stat, e.max_hp, e.max_mana
       FROM characters c
       LEFT JOIN entity_types e ON e.id = c.entity_type_id
      WHERE c.id = $1 AND c.user_id = $2`,
    [id, userId]);
  if (!r.rows.length) return null;
  // inventory_slots rides the ownership lookup rather than getting its own
  // query: the join path already needs this row, and the carry limit must be
  // in hand before the first grant path runs (see authority/items.js).
  //
  // classPools rides it for the same reason (SOMET-486): every path that
  // derives a character's stats already resolves ownership first, so this is
  // where the class's base pools are cheapest to obtain and hardest to forget.
  //
  // className and mainStat ride it too (SOMET-471). The join path already
  // joins entity_types for the pools, so a second round trip for one string
  // would be pure waste -- and the class has to be in hand BEFORE addPlayer
  // builds the player object, because that is where a class's mechanical
  // identity (spec 8.3's life-cost casting) has to be decided. Both are null
  // for a character whose class row has vanished; the LEFT JOIN above is what
  // makes that a pool-less join rather than a refused one.
  return {
    id: r.rows[0].id,
    entityTypeId: r.rows[0].entity_type_id,
    inventorySlots: Number(r.rows[0].inventory_slots),
    className: r.rows[0].class_name,
    mainStat: r.rows[0].main_stat,
    classPools: classPoolsFromRow(r.rows[0]),
  };
}

// Allocation and insert are ONE statement. A read-then-write ("SELECT the free
// slots, then INSERT into the lowest") leaves a window in which two concurrent
// creates both pick the same slot; here the loser hits
// characters_user_slot_unique and is translated to no_free_slot below.
async function createCharacter(pool, userId, name, entityTypeId) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) {
    throw new CharacterError('bad_name', `name must be 1-${MAX_NAME_LENGTH} characters`);
  }
  const typeId = Number(entityTypeId);
  if (!Number.isInteger(typeId)) throw new CharacterError('not_playable', 'unknown class');

  const cls = await pool.query(
    'SELECT id FROM entity_types WHERE id = $1 AND is_playable = true', [typeId]);
  if (!cls.rows.length) throw new CharacterError('not_playable', 'unknown class');

  try {
    const r = await pool.query(
      `INSERT INTO characters (user_id, slot, name, entity_type_id)
       SELECT $1, s.slot, $2, $3
         FROM generate_series(1, ${MAX_CHARACTERS}) AS s(slot)
        WHERE NOT EXISTS (SELECT 1 FROM characters WHERE user_id = $1 AND slot = s.slot)
        ORDER BY s.slot ASC
        LIMIT 1
       RETURNING id, slot, name`,
      [userId, trimmed, typeId]);
    if (!r.rows.length) throw new CharacterError('no_free_slot', 'all character slots are used');

    // The class-base stat SNAPSHOT (design doc 3.3, contract 6.1), written
    // once here and never mutated again. progressionStore.loadProgression
    // still lazily creates a row for characters that predate this write, so
    // this is not the only path -- but it is the one that decides what a
    // character's base IS, and it must be an explicit write rather than a
    // reliance on the column defaults, because T3 changes THIS statement when
    // per-class bases arrive.
    //
    // Every class bases at 5 on all six stats today, deliberately. Reading
    // entity_types' stats here instead -- Warrior 10s, Ranger DEX 12 -- would
    // silently rebalance every new character: every formula in playerStats.js
    // is an identity at BASE_STAT, so a snapshot CON of 10 is +50 max HP.
    // Class identity comes from the tree start position and the starting
    // loadout, not from different base stats.
    //
    // ON CONFLICT DO NOTHING for the same reason loadProgression has it: the
    // insert must be idempotent and must never be the thing that fails a
    // character creation that already succeeded.
    await pool.query(
      `INSERT INTO player_progression
         (character_id, strength, dexterity, constitution, intelligence, wisdom, charisma)
       VALUES ($1, $2, $2, $2, $2, $2, $2)
       ON CONFLICT (character_id) DO NOTHING`,
      [r.rows[0].id, BASE_STAT],
    );

    return { id: r.rows[0].id, slot: r.rows[0].slot, name: r.rows[0].name };
  } catch (err) {
    if (err instanceof CharacterError) throw err;
    if (err && err.constraint === 'characters_name_unique') {
      throw new CharacterError('name_taken', 'that name is taken');
    }
    if (err && err.constraint === 'characters_user_slot_unique') {
      // Lost a race for the last free slot: the SELECT saw it free, another
      // transaction committed into it first.
      throw new CharacterError('no_free_slot', 'all character slots are used');
    }
    throw err;
  }
}

async function deleteCharacter(pool, userId, characterId) {
  const id = Number(characterId);
  if (!Number.isInteger(id)) return false;
  // Scoped by user_id in the DELETE itself rather than by a preceding SELECT:
  // one statement, no window in which ownership could change between check and
  // delete.
  const r = await pool.query(
    'DELETE FROM characters WHERE id = $1 AND user_id = $2', [id, userId]);
  return r.rowCount > 0;
}

module.exports = {
  MAX_CHARACTERS,
  MAX_NAME_LENGTH,
  CLASS_POOL_COLUMNS,
  classPoolsFromRow,
  CharacterError,
  listCharacters,
  listPlayableClasses,
  createCharacter,
  deleteCharacter,
  ownedCharacter,
};
