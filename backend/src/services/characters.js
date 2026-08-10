// Character queries (SOMET-259).
//
// Kept out of index.js's inline routes because the slot allocation below is the
// one piece here with real logic worth testing on its own, and because the
// authority -- which has no Express request -- needs ownedCharacter too.

const MAX_CHARACTERS = 8;
const MAX_NAME_LENGTH = 32;

class CharacterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CharacterError';
    this.code = code;
  }
}

async function listPlayableClasses(pool) {
  const r = await pool.query(
    `SELECT id, name, color, hp, strength, dexterity, constitution, intelligence, wisdom, charisma
       FROM entity_types WHERE is_playable = true ORDER BY id ASC`);
  return r.rows.map((x) => ({
    id: x.id,
    name: x.name,
    color: x.color,
    hp: Number(x.hp),
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
  const r = await pool.query(
    'SELECT id, entity_type_id FROM characters WHERE id = $1 AND user_id = $2',
    [id, userId]);
  if (!r.rows.length) return null;
  return { id: r.rows[0].id, entityTypeId: r.rows[0].entity_type_id };
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
  CharacterError,
  listCharacters,
  listPlayableClasses,
  createCharacter,
  deleteCharacter,
  ownedCharacter,
};
