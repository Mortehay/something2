// Ordered (seed order) registry of exportable data groups. A group is an
// ordered list of TableSpecs (the order the group writes its tables in):
//   { table, naturalKey: string[], omit: {col: reason}, secretColumns: string[],
//     refs: { [col]: { table, by: 'uuid' } | { table, by: 'key', keyCol } },
//     nameRefs?: { [col]: { table, keyCol, shape: 'text'|'array'|'object-values' } },
//     validate?: 'game_settings', secretNeededIf?: col }
// `omit` columns are deliberately not exported (reason documented);
// `secretColumns` are never exported; `refs` columns are exported translated
// (target sync_uuid or natural key), never as local ids. Every FK column must
// be in `refs` or `omit` (see fkProblems). `nameRefs` columns hold names of
// rows in another table (no FK); they travel as-is and the diff warns
// (dangling_name) about a name that resolves neither locally nor in the file.
//
// Order rules (pinned by seed_sync_registry_db.test.js): inside a group a
// table comes after every table of the group it references (deletes run
// children first, deferred refs only for self/forward refs); across groups an
// FK only points at a group that seeds earlier (ai_providers is first: tile
// and entity types pin a provider by uuid).
const LOCAL = { id: 'local', created_at: 'local', updated_at: 'local', sync_uuid: 'identity' };
const ART = 'art group (plan 3)';

const GROUPS = [
  {
    id: 'ai_providers',
    label: 'AI Providers',
    tables: [{
      table: 'ai_providers',
      naturalKey: ['name'],
      omit: {
        id: 'local',
        created_at: 'local',
        updated_at: 'local',
        sync_uuid: 'identity',
        models_cache: 'machine cache',
        models_fetched_at: 'machine cache',
        is_active: 'per-PC choice: which box this PC can reach',
      },
      secretColumns: ['auth_token'],
      // auth_token is only needed when the provider sends an auth header.
      secretNeededIf: 'auth_header_name',
      refs: {},
    }],
  },
  {
    id: 'tile_types',
    label: 'Tile Types',
    tables: [{
      table: 'tile_types',
      naturalKey: ['name'],
      omit: {
        id: 'local',
        created_at: 'local',
        updated_at: 'local',
        image: 'art group (plan 3)',
        render_mode: 'art group (plan 3)',
        sprite: 'art group (plan 3)',
        sync_uuid: 'identity',
      },
      secretColumns: [],
      refs: { ai_provider_id: { table: 'ai_providers', by: 'uuid' } },
    }],
  },
  {
    id: 'items',
    label: 'Items',
    tables: [
      {
        table: 'item_types',
        naturalKey: ['name'],
        omit: { ...LOCAL, icon: ART },
        secretColumns: [],
        refs: {
          ammo_type_id: { table: 'item_types', by: 'uuid' },
          attack_origin: { table: 'attack_origins', by: 'key', keyCol: 'name' },
          element: { table: 'elements', by: 'key', keyCol: 'name' },
          impact_behavior_id: { table: 'impact_behaviors', by: 'key', keyCol: 'name' },
          projectile_shape_id: { table: 'projectile_shapes', by: 'key', keyCol: 'name' },
        },
        nameRefs: { vfx: { table: 'vfx_effects', keyCol: 'name', shape: 'object-values' } },
      },
      {
        table: 'affix_types',
        naturalKey: ['key'],
        omit: { id: 'local', created_at: 'local', sync_uuid: 'identity' },
        secretColumns: [],
        refs: {},
      },
    ],
  },
  {
    id: 'attack_effects',
    label: 'Attack Effects',
    tables: [
      {
        table: 'vfx_effects',
        naturalKey: ['name'],
        omit: { id: 'local', created_at: 'local', sync_uuid: 'identity' },
        secretColumns: [],
        refs: {},
      },
      {
        table: 'creature_skills',
        naturalKey: ['name'],
        omit: { ...LOCAL },
        secretColumns: [],
        refs: {},
        nameRefs: {
          summon_entity: { table: 'entity_types', keyCol: 'name', shape: 'text' },
          vfx: { table: 'vfx_effects', keyCol: 'name', shape: 'object-values' },
        },
      },
    ],
  },
  {
    id: 'aura_effects',
    label: 'Aura Effects',
    tables: [{
      table: 'aura_effects',
      naturalKey: ['name'],
      omit: { ...LOCAL },
      secretColumns: [],
      refs: { dot_element: { table: 'elements', by: 'key', keyCol: 'name' } },
    }],
  },
  {
    id: 'creature_behaviors',
    label: 'Creature Behaviors',
    tables: [
      {
        table: 'creature_behaviors',
        naturalKey: ['name'],
        omit: { ...LOCAL },
        secretColumns: [],
        refs: {},
      },
      {
        table: 'creature_abilities',
        naturalKey: ['behavior_id', 'slot'],
        omit: { ...LOCAL },
        secretColumns: [],
        refs: { behavior_id: { table: 'creature_behaviors', by: 'uuid' } },
      },
      {
        table: 'creature_behavior_skills',
        naturalKey: ['behavior_id', 'slot'],
        omit: { ...LOCAL },
        secretColumns: [],
        refs: {
          behavior_id: { table: 'creature_behaviors', by: 'uuid' },
          skill_id: { table: 'creature_skills', by: 'uuid' },
        },
      },
      {
        table: 'behavior_drops',
        naturalKey: ['behavior_id', 'item_type_id'],
        omit: { id: 'local', created_at: 'local', sync_uuid: 'identity' },
        secretColumns: [],
        refs: {
          behavior_id: { table: 'creature_behaviors', by: 'uuid' },
          item_type_id: { table: 'item_types', by: 'uuid' },
        },
      },
      {
        table: 'chest_loot',
        naturalKey: ['level_min', 'level_max', 'item_type_id'],
        omit: { id: 'local', sync_uuid: 'identity' },
        secretColumns: [],
        refs: { item_type_id: { table: 'item_types', by: 'uuid' } },
      },
    ],
  },
  {
    id: 'entities',
    label: 'Entities',
    tables: [
      {
        table: 'entity_types',
        naturalKey: ['name'],
        omit: {
          ...LOCAL,
          image: ART,
          sprite: ART,
          render_mode: ART,
          display_width: ART,
          display_height: ART,
          prompt: ART,
          ai_provider_mode: 'per-PC',
        },
        secretColumns: [],
        refs: {
          behavior_id: { table: 'creature_behaviors', by: 'uuid' },
          ai_provider_id: { table: 'ai_providers', by: 'uuid' },
          element: { table: 'elements', by: 'key', keyCol: 'name' },
          point_kind: { table: 'world_point_kinds', by: 'key', keyCol: 'kind' },
        },
        nameRefs: {
          auras: { table: 'aura_effects', keyCol: 'name', shape: 'array' },
          vfx: { table: 'vfx_effects', keyCol: 'name', shape: 'object-values' },
          spawn_tiles: { table: 'tile_types', keyCol: 'name', shape: 'array' },
        },
      },
      {
        table: 'creature_drops',
        naturalKey: ['entity_type_id', 'item_type_id'],
        omit: { id: 'local', created_at: 'local', sync_uuid: 'identity' },
        secretColumns: [],
        refs: {
          entity_type_id: { table: 'entity_types', by: 'uuid' },
          item_type_id: { table: 'item_types', by: 'uuid' },
        },
      },
      {
        table: 'class_loadouts',
        naturalKey: ['entity_type_id', 'item_type_id'],
        omit: { id: 'local', sync_uuid: 'identity' },
        secretColumns: [],
        refs: {
          entity_type_id: { table: 'entity_types', by: 'uuid' },
          item_type_id: { table: 'item_types', by: 'uuid' },
          socket_into_item_type_id: { table: 'item_types', by: 'uuid' },
        },
      },
    ],
  },
  {
    id: 'biomes',
    label: 'Biomes',
    tables: [{
      table: 'biomes',
      naturalKey: ['name'],
      omit: { ...LOCAL },
      secretColumns: [],
      refs: {},
      nameRefs: {
        terrain_tiles: { table: 'tile_types', keyCol: 'name', shape: 'array' },
        path_tile: { table: 'tile_types', keyCol: 'name', shape: 'text' },
        creature_types: { table: 'entity_types', keyCol: 'name', shape: 'array' },
        flora_types: { table: 'entity_types', keyCol: 'name', shape: 'array' },
      },
    }],
  },
  {
    id: 'skill_tree',
    label: 'Skill Tree',
    tables: [
      {
        // Every column travels: the admin edits label/kind/grants, the
        // seeder writes the structural ones (full fidelity).
        table: 'passive_nodes',
        naturalKey: ['key'],
        omit: { id: 'local', sync_uuid: 'identity' },
        secretColumns: [],
        refs: {},
        // A start node names its playable class (passiveTreeStore joins
        // start_class = entity_types.name); no FK.
        nameRefs: { start_class: { table: 'entity_types', keyCol: 'name', shape: 'text' } },
      },
      {
        table: 'passive_edges',
        naturalKey: ['a_id', 'b_id'],
        omit: { sync_uuid: 'identity' },
        secretColumns: [],
        refs: {
          a_id: { table: 'passive_nodes', by: 'uuid' },
          b_id: { table: 'passive_nodes', by: 'uuid' },
        },
      },
    ],
  },
  {
    id: 'progression',
    label: 'Progression',
    tables: [{
      table: 'game_settings',
      naturalKey: ['key'],
      omit: { updated_at: 'local', sync_uuid: 'identity' },
      secretColumns: [],
      refs: {},
      validate: 'game_settings',
    }],
  },
  {
    id: 'quests',
    label: 'Quests',
    tables: [{
      table: 'quests',
      naturalKey: ['key'],
      omit: { id: 'local', created_at: 'local', sync_uuid: 'identity' },
      secretColumns: [],
      refs: {},
    }],
  },
];

function getGroup(id) {
  const g = GROUPS.find((x) => x.id === id);
  if (!g) throw new Error('unknown group');
  return g;
}

function tableSpecs(group) {
  return group.tables;
}

// The one TableSpec of a single-table, single-key-column group without refs;
// anything else throws. No engine path needs it any more (export, diff,
// preview and apply all handle multi-table groups with refs since plan 2
// Task 5); kept for tests that address a Plan-1 group's only table.
function soleSpec(group) {
  const specs = tableSpecs(group);
  if (specs.length !== 1) {
    throw new Error(`seed-sync: group ${group.id} has ${specs.length} tables; only single-table groups are supported yet`);
  }
  const spec = specs[0];
  if (spec.naturalKey.length !== 1) {
    throw new Error(`seed-sync: ${spec.table} has a composite natural key; only single-column keys are supported yet`);
  }
  if (Object.keys(spec.refs || {}).length) {
    throw new Error(`seed-sync: group ${group.id}: ${spec.table} has refs; diff/seed of ref columns is not supported yet`);
  }
  return spec;
}

// TEST ONLY: registers `groups` (ids must be new) for the duration of fn, then
// removes them, even when fn throws. Production code never calls this; it lets
// tests exercise multi-table/ref export before the real groups exist (Task 6).
async function _withTestGroups(groups, fn) {
  for (const g of groups) {
    if (GROUPS.some((x) => x.id === g.id)) throw new Error(`seed-sync: test group ${g.id} already registered`);
  }
  GROUPS.push(...groups);
  try {
    return await fn();
  } finally {
    for (const g of groups) {
      const i = GROUPS.indexOf(g);
      if (i >= 0) GROUPS.splice(i, 1);
    }
  }
}

// Exported columns of one table: everything but omit and secret columns (ref
// columns included), sorted by name.
async function liveColumns(db, spec) {
  const { rows } = await db.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [spec.table],
  );
  const skip = new Set([...Object.keys(spec.omit), ...(spec.secretColumns || [])]);
  return rows
    .filter((r) => !skip.has(r.column_name))
    .map((r) => ({ name: r.column_name, dataType: r.data_type }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// FK coverage of one TableSpec against the live schema, sorted by column:
//  - uncovered:    an FK column in neither `refs` nor `omit` (would export a local id)
//  - wrong_target: a declared ref whose table is not the FK's referenced table
//  - not_a_fk:     a declared ref on a column with no FK constraint
async function fkProblems(db, spec) {
  const { rows } = await db.query(
    `SELECT a.attname::text AS col, t.relname::text AS target
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       JOIN pg_class t ON t.oid = c.confrelid
      WHERE c.contype = 'f' AND c.conrelid = $1::text::regclass`,
    [`"${spec.table.replace(/"/g, '""')}"`],
  );
  const fkTargets = new Map(); // col -> Set(target table)
  for (const r of rows) {
    if (!fkTargets.has(r.col)) fkTargets.set(r.col, new Set());
    fkTargets.get(r.col).add(r.target);
  }
  const refs = spec.refs || {};
  const out = [];
  for (const [col, targets] of fkTargets) {
    const target = [...targets].sort().join(',');
    if (Object.prototype.hasOwnProperty.call(refs, col)) {
      if (targets.size !== 1 || !targets.has(refs[col].table)) {
        out.push({ column: col, problem: 'wrong_target', target, declared: refs[col].table });
      }
    } else if (!Object.prototype.hasOwnProperty.call(spec.omit, col)) {
      out.push({ column: col, problem: 'uncovered', target });
    }
  }
  for (const [col, ref] of Object.entries(refs)) {
    if (!fkTargets.has(col)) out.push({ column: col, problem: 'not_a_fk', target: null, declared: ref.table });
  }
  return out.sort((a, b) => (a.column < b.column ? -1 : a.column > b.column ? 1 : 0));
}

const NAME_REF_SHAPES = ['text', 'array', 'object-values'];

// nameRefs of one TableSpec against the live schema, sorted by column:
//  - bad_shape:      shape is not one of NAME_REF_SHAPES
//  - not_a_column:   the by-name column does not exist in spec.table
//  - not_exported:   the column is omitted or secret (nothing to check)
//  - missing_target: target table/keyCol does not exist
async function nameRefProblems(db, spec) {
  const entries = Object.entries(spec.nameRefs || {});
  if (!entries.length) return [];
  const tables = [...new Set([spec.table, ...entries.map(([, nr]) => nr.table)])];
  const { rows } = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    [tables],
  );
  const has = new Set(rows.map((r) => `${r.table_name}\u0000${r.column_name}`));
  const hidden = new Set([...Object.keys(spec.omit || {}), ...(spec.secretColumns || [])]);
  const out = [];
  for (const [col, nr] of entries) {
    const base = { column: col, target: nr && nr.table ? `${nr.table}.${nr.keyCol}` : null };
    if (!nr || !NAME_REF_SHAPES.includes(nr.shape)) out.push({ ...base, problem: 'bad_shape', shape: nr ? nr.shape : null });
    if (!has.has(`${spec.table}\u0000${col}`)) out.push({ ...base, problem: 'not_a_column' });
    else if (hidden.has(col)) out.push({ ...base, problem: 'not_exported' });
    if (!nr || !has.has(`${nr.table}\u0000${nr.keyCol}`)) out.push({ ...base, problem: 'missing_target' });
  }
  return out.sort((a, b) => (a.column < b.column ? -1 : a.column > b.column ? 1 : 0));
}

module.exports = {
  GROUPS, getGroup, tableSpecs, soleSpec, liveColumns, fkProblems, nameRefProblems, NAME_REF_SHAPES, _withTestGroups,
};
