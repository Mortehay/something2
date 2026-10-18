// Classification of every base table in the schema, so a new admin table can
// never be silently forgotten by seed sync. Each table is in exactly one of:
//   - a registry group TableSpec (synced now),
//   - EXCLUDED (never synced; short, specific reason),
//   - PENDING (admin content that a named future plan will sync).
const { GROUPS, tableSpecs } = require('./registry.js');

const P3 = 'plan 3 (art/sprites/audio)';
const P4 = 'plan 4 (maps)';

const EXCLUDED = {
  // machine-local job / history / queue state
  art_jobs: 'machine-local art job queue',
  art_generations: 'machine-local generation history',
  audio_jobs: 'machine-local audio job queue',
  audio_misses: 'machine-local log of unbound audio lookups',
  // runtime / world state
  world_creatures: 'runtime: live creature instances',
  world_items: 'runtime: items lying in the world',
  world_players: 'runtime: player positions in worlds',
  creature_respawns: 'runtime: respawn timers',
  engine_mobs: 'runtime: engine (Go) mob state',
  engine_players: 'runtime: engine (Go) player state',
  world_chunks: 'cache: regenerable from world seed',
  // player / account data
  users: 'player accounts and credentials',
  invite_codes: 'account invite codes',
  characters: 'player characters',
  character_passives: 'player progression state',
  character_quests: 'player quest progress',
  character_summons: 'player runtime summons',
  character_visited_worlds: 'player exploration state',
  character_waypoints: 'player unlocked waypoints',
  player_binds: 'player hotbar bindings',
  player_equipment: 'player equipment',
  player_item_affixes: 'rolled affixes on player items',
  player_items: 'player inventory instances',
  player_progression: 'player level/xp state',
  account_items: 'player account stash',
  stone_instances: 'player-owned stone instances',
  // derived
  merchant_stock: 'derived: regenerated per village from item_types',
  // lookups referenced by name (code/spec-defined, not edited as content)
  elements: 'lookup referenced by name (nameRefs)',
  attack_origins: 'lookup referenced by name (nameRefs)',
  impact_behaviors: 'lookup referenced by name (nameRefs)',
  projectile_shapes: 'lookup referenced by name (nameRefs)',
  // infrastructure
  seed_export_runs: 'seed sync own run history',
  seed_row_hashes: 'seed sync own baselines',
  pgmigrations: 'node-pg-migrate ledger',
};

const PENDING = {
  catalog_art: P3,
  art_prompt_descriptions: P3,
  art_prompt_notes: P3,
  sprite_sets: P3,
  character_appearances: P3,
  audio_clips: P3,
  audio_bindings: P3,
  audio_prompts: P3,
  worlds: P4,
  map_links: P4,
  waypoints: P4,
  world_chests: P4,
  villages: P4,
  maps: P4,
  map_entities: P4,
  // lookup, but edited with the map/entity UI; also a by-key ref target
  world_point_kinds: P4,
};

function groupTables() {
  return GROUPS.flatMap((g) => tableSpecs(g).map((s) => s.table));
}

// Pure checker (injectable lists for tests). Returns problem strings; [] = ok.
function coverageProblems(dbTables, lists = {}) {
  const grouped = lists.groupTables || groupTables();
  const excluded = lists.excluded || EXCLUDED;
  const pending = lists.pending || PENDING;
  const where = new Map();
  const add = (t, w) => where.set(t, [...(where.get(t) || []), w]);
  grouped.forEach((t) => add(t, 'group'));
  Object.keys(excluded).forEach((t) => add(t, 'EXCLUDED'));
  Object.keys(pending).forEach((t) => add(t, 'PENDING'));
  const db = new Set(dbTables);
  const out = [];
  for (const t of [...db].sort()) {
    if (!where.has(t)) out.push(`unclassified table: ${t}`);
  }
  for (const [t, w] of [...where].sort()) {
    if (w.length > 1) out.push(`table ${t} is in several lists: ${w.join(', ')}`);
    if (!db.has(t)) out.push(`${w.join('/')} names a table that does not exist: ${t}`);
  }
  for (const [t, r] of Object.entries(excluded)) if (!r) out.push(`EXCLUDED ${t} has no reason`);
  return out;
}

module.exports = { EXCLUDED, PENDING, groupTables, coverageProblems };
