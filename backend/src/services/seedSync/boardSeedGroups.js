// The seed groups "Seed from git" runs on the Orange Pi board, in seed order.
// No imports on purpose: the host-side helper requires this file directly and
// the host has no backend dependencies guaranteed.
// Excluded: ai_provider_templates, art, audio, maps. Tables written by these
// groups must never include a player table (users, characters, anything with
// a user_id / character_id column); tests/board_seed_scope_db.test.js proves it.
const BOARD_SEED_GROUPS = [
  'ai_providers', 'tile_types', 'items', 'attack_effects', 'aura_effects',
  'creature_behaviors', 'entities', 'biomes', 'skill_tree', 'progression', 'quests',
];

module.exports = { BOARD_SEED_GROUPS };
