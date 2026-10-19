// Ordered (seed order) registry of exportable data groups. A group is an
// ordered list of TableSpecs (the order the group writes its tables in):
//   { table, naturalKey: string[], omit: {col: reason}, secretColumns: string[],
//     refs: { [col]: { table, by: 'uuid' } | { table, by: 'key', keyCol } },
//     nameRefs?: { [col]: { table, keyCol, shape: 'text'|'array'|'object-values' } },
//     validate?: 'game_settings', secretNeededIf?: col, unorderedPair?: [colA, colB] }
// `omit` columns are deliberately not exported (reason documented);
// `secretColumns` are never exported; `refs` columns are exported translated
// (target sync_uuid or natural key), never as local ids. Every FK column must
// be in `refs` or `omit` (see fkProblems). `nameRefs` columns hold names of
// rows in another table (no FK); they travel as-is and the diff warns
// (dangling_name) about a name that resolves neither locally nor in the file.
// `unorderedPair` names two by-uuid refs to ONE table that together are an
// unordered pair (passive_edges): export and diff put the pair in the order of
// the targets' natural keys (plain code-unit compare, = COLLATE "C"), so the
// file, hashes and deep keys never depend on local id order; apply writes the
// two resolved local ids LEAST/GREATEST. The target's natural key must be one
// non-ref column (pairKeyCol).
//
//
// Row and column scoping (plan 3):
//  - rowFilter: string -- an SQL predicate over UNQUALIFIED columns of
//    spec.table (a subquery may name the table itself, e.g.
//    `EXISTS (SELECT 1 FROM audio_bindings b WHERE b.clip_id = audio_clips.id)`).
//    Only rows it holds for are synced: every SELECT, lock-for-update and
//    UPDATE the engine issues for the table ANDs it in via scopeSql(), so a
//    filtered-out row is never exported, listed, deleted or adopted. The
//    upsert of a git row (INSERT ... ON CONFLICT (sync_uuid)) is not filtered:
//    a git row that exists here but is filtered out is overwritten by it.
//    Apply's DELETE does not re-apply it (only `active`): its rows were picked
//    by the scoped diff and locked, and the filter may read children the same
//    seed deleted first (an audio clip whose bindings go with it).
//  - versioned: true -- a history table with an `active` flag whose versions
//    share the subject's sync_uuid (partial UNIQUE (sync_uuid) WHERE active).
//    Implies the filter `active` (ANDed with any rowFilter); the upsert
//    targets ON CONFLICT (sync_uuid) WHERE active (and sets active = true:
//    with a plain UNIQUE (sync_uuid), as art_prompt_notes has, it may hit a
//    deactivated row), and a delete deactivates the active row
//    (UPDATE ... SET active = false) instead of deleting it.
//    Inactive history rows are never read, and written only in that case.
//  - slice: true, columns: string[] -- the group owns only `columns` of a
//    table another group (the "owner", a full spec of the same table) owns.
//    naturalKey and sync_uuid are read (display, deep keys, hashes) but never
//    written. Export and diff read only columns + naturalKey; apply only
//    UPDATEs `columns` of rows that exist here -- it never inserts, deletes or
//    adopts. A git row whose uuid is not here is blocked 'owner_missing'
//    ("seed <owner label> first", the label of the first group with a full
//    spec of the table, see ownerLabel); a local row missing from git is kept
//    ('delete' is refused). Baselines are per group, so a slice hashes only
//    its own columns and the owner (which omits them) never sees slice edits.
//    coverage.js checks the owner omits every slice column and that its
//    art-omitted columns sit in exactly one slice.
//
// Asset columns (plan 3 Task 3): assets: { [col]: { type: 'image'|'sprite'|
// 'audio', dir, maxEdge?, name? } } -- the column holds object-store keys locally and
// travels as repo files + content hashes; see seedSync/assets.js. An asset
// column of a slice must be one of its columns.
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
        // CHECK (a_id < b_id) is on local ids, which follow insertion order:
        // the same edge is (X,Y) here and (Y,X) on another PC.
        unorderedPair: ['a_id', 'b_id'],
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
  // Binary groups (plan 3): rows plus repo files (asset columns). Last: their
  // slices update rows the data groups above create.
  {
    id: 'art',
    label: 'Art',
    binary: true,
    tables: [
      {
        table: 'catalog_art',
        naturalKey: ['subject_kind', 'subject_key'],
        omit: { created_at: 'local', updated_at: 'local', sync_uuid: 'identity' },
        secretColumns: [],
        refs: { provider_id: { table: 'ai_providers', by: 'uuid' } },
        assets: {
          image: {
            type: 'image',
            dir: (r) => ({
              skill: 'textures/skills',
              passive_label: 'textures/passives',
              character_appearance: 'textures/character-appearances',
              item: 'textures/items',
            }[r.subject_kind] || `textures/catalog/${r.subject_kind}`),
            // Icons are capped like the legacy exporter does.
            maxEdge: (r) => (['skill', 'passive_label', 'item'].includes(r.subject_kind) ? 256 : null),
            // Named by subject_key alone like the legacy exporter (each kind
            // has its own dir): the default 'kind|key' would rename every file.
            name: (r) => r.subject_key,
          },
        },
      },
      {
        table: 'art_prompt_descriptions',
        versioned: true,
        naturalKey: ['subject_kind', 'subject_key'],
        omit: { id: 'local', created_at: 'local', active: 'versioned: only the active version syncs', sync_uuid: 'identity' },
        secretColumns: [],
        refs: {},
      },
      {
        table: 'art_prompt_notes',
        versioned: true,
        naturalKey: ['subject_kind', 'subject_key', 'kind', 'note'],
        omit: { id: 'local', created_at: 'local', active: 'versioned: only active notes sync', sync_uuid: 'identity' },
        secretColumns: [],
        refs: {},
      },
      {
        table: 'character_appearances',
        naturalKey: ['entity_type_id', 'variant'],
        omit: { updated_at: 'local', sync_uuid: 'identity' },
        secretColumns: [],
        refs: { entity_type_id: { table: 'entity_types', by: 'uuid' } },
        assets: {
          image: { type: 'image', dir: 'textures/character-appearances' },
          sprite: { type: 'sprite', dir: 'textures/sprites/character_appearances' },
        },
      },
      {
        table: 'tile_types',
        slice: true,
        columns: ['image', 'render_mode', 'sprite'],
        naturalKey: ['name'],
        omit: {},
        secretColumns: [],
        refs: {},
        assets: {
          image: { type: 'image', dir: 'textures/tiles' },
          sprite: { type: 'sprite', dir: 'textures/sprites/tile_types' },
        },
      },
      {
        table: 'entity_types',
        slice: true,
        columns: ['image', 'sprite', 'render_mode', 'display_width', 'display_height', 'prompt'],
        naturalKey: ['name'],
        omit: {},
        secretColumns: [],
        refs: {},
        assets: {
          image: { type: 'image', dir: 'textures/entities' },
          sprite: { type: 'sprite', dir: 'textures/sprites/entity_types' },
        },
      },
      {
        table: 'item_types',
        slice: true,
        columns: ['icon'],
        naturalKey: ['name'],
        omit: {},
        secretColumns: [],
        refs: {},
        assets: { icon: { type: 'image', dir: 'textures/items', maxEdge: 256 } },
      },
    ],
  },
  {
    id: 'audio',
    label: 'Audio',
    binary: true,
    tables: [
      {
        // The clip has no natural key of its own (a rename is a label edit):
        // its identity is the key. Unbound clips stay on their PC.
        table: 'audio_clips',
        naturalKey: ['sync_uuid'],
        rowFilter: 'EXISTS (SELECT 1 FROM audio_bindings b WHERE b.clip_id = audio_clips.id)',
        // sync_uuid is read for the key like every row's, never as a column.
        omit: { id: 'local', created_at: 'local', sync_uuid: 'identity' },
        secretColumns: [],
        refs: { provider_id: { table: 'ai_providers', by: 'uuid' } },
        assets: { storage_key: { type: 'audio', dir: (r) => `audio/${r.kind}` } },
      },
      {
        table: 'audio_bindings',
        naturalKey: ['subject_kind', 'subject_key', 'slot', 'clip_id'],
        omit: { id: 'local', created_at: 'local', sync_uuid: 'identity' },
        secretColumns: [],
        refs: { clip_id: { table: 'audio_clips', by: 'uuid' } },
      },
      {
        table: 'audio_prompts',
        versioned: true,
        naturalKey: ['subject_kind', 'subject_key', 'slot'],
        omit: { id: 'local', created_at: 'local', active: 'versioned: only the active version syncs', sync_uuid: 'identity' },
        secretColumns: [],
        refs: {},
      },
    ],
  },
];

function getGroup(id) {
  const g = GROUPS.find((x) => x.id === id);
  if (!g) throw new Error('unknown group');
  return g;
}

// Throws on a TableSpec whose plan-3 fields are inconsistent.
function checkSpec(spec) {
  const where = `seed-sync: ${spec.table}`;
  if (spec.rowFilter !== undefined && (typeof spec.rowFilter !== 'string' || !spec.rowFilter.trim())) {
    throw new Error(`${where}: rowFilter must be a non-empty SQL predicate`);
  }
  if (spec.versioned !== undefined && spec.versioned !== true) throw new Error(`${where}: versioned must be true or absent`);
  if (spec.slice !== undefined && spec.slice !== true) throw new Error(`${where}: slice must be true or absent`);
  if (spec.slice) {
    if (!Array.isArray(spec.columns) || !spec.columns.length) throw new Error(`${where}: a slice needs columns`);
    const clash = spec.columns.filter((c) => spec.naturalKey.includes(c) || c === 'sync_uuid');
    if (clash.length) throw new Error(`${where}: slice columns ${clash.join(', ')} are key columns (read, never written)`);
    if (spec.unorderedPair) throw new Error(`${where}: a slice cannot be an unorderedPair`);
  } else if (spec.columns !== undefined) {
    throw new Error(`${where}: columns is only for a slice`);
  }
  // Lazy: assets.js requires this module.
  require('./assets.js').checkAssets(spec);
}

// A group lists each table once: a full spec, or one slice (a group that
// owns some columns of a table owns them through ONE slice).
function tableSpecs(group) {
  group.tables.forEach(checkSpec);
  const seen = new Set();
  for (const s of group.tables) {
    if (seen.has(s.table)) throw new Error(`seed-sync: group ${group.id} lists ${s.table} twice`);
    seen.add(s.table);
  }
  return group.tables;
}

// The registered full (non-slice) TableSpec of `table` (first group that has
// it), or null.
function specOfTable(table) {
  for (const g of GROUPS) {
    const s = g.tables.find((x) => x.table === table && !x.slice);
    if (s) return s;
  }
  return null;
}

// Label of the group owning a sliced table (first group with a full spec of
// it); the table name when none is registered.
function ownerLabel(table) {
  const g = GROUPS.find((x) => x.tables.some((s) => s.table === table && !s.slice));
  return g ? g.label : table;
}

// The row predicate of a spec (versioned -> `active`, ANDed with rowFilter),
// or null when every row syncs.
function rowPredicate(spec) {
  const parts = [];
  if (spec && spec.versioned) parts.push('active');
  if (spec && spec.rowFilter) parts.push(`(${spec.rowFilter})`);
  return parts.length ? parts.join(' AND ') : null;
}

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

// '' or ' AND (<row predicate>)', for appending to a WHERE that already has a
// condition. Without `alias` (or with alias === spec.table) the statement must
// name spec.table unaliased and have no other table whose columns could
// capture the predicate's unqualified names. With another alias (a join), the
// predicate is evaluated on the same physical row in a subquery of its own,
// where its unqualified names (and spec.table inside it) bind to that row:
// ' AND EXISTS (SELECT 1 FROM t WHERE t.ctid = alias.ctid AND (pred))'.
function scopeSql(spec, alias) {
  const pred = rowPredicate(spec);
  if (!pred) return '';
  if (!alias || alias === spec.table) return ` AND (${pred})`;
  const t = quoteIdent(spec.table);
  return ` AND EXISTS (SELECT 1 FROM ${t} WHERE ${t}.ctid = ${alias}.ctid AND (${pred}))`;
}

// The target table and its single natural-key column of an unorderedPair
// spec; throws on a misconfigured pair (different targets, not by uuid, or a
// target whose natural key is not one plain column).
function pairKeyCol(spec) {
  const [a, b] = spec.unorderedPair;
  const ra = (spec.refs || {})[a];
  const rb = (spec.refs || {})[b];
  if (!ra || !rb || ra.by !== 'uuid' || rb.by !== 'uuid' || ra.table !== rb.table) {
    throw new Error(`seed-sync: ${spec.table}.unorderedPair must name two by-uuid refs to one table`);
  }
  const ts = specOfTable(ra.table);
  if (!ts || ts.naturalKey.length !== 1 || Object.prototype.hasOwnProperty.call(ts.refs || {}, ts.naturalKey[0])) {
    throw new Error(`seed-sync: ${spec.table}.unorderedPair target ${ra.table} needs a single plain natural key`);
  }
  return { table: ra.table, keyCol: ts.naturalKey[0] };
}

// `row` with its unorderedPair columns ordered by keyOf(value) (code-unit
// compare). keyOf returns the target's natural key text or null (unknown:
// the row is left as is). Any other spec: `row` unchanged.
function orderPair(spec, row, keyOf) {
  if (!spec.unorderedPair) return row;
  const [a, b] = spec.unorderedPair;
  if (row[a] == null || row[b] == null) return row;
  const ka = keyOf(row[a]);
  const kb = keyOf(row[b]);
  if (typeof ka !== 'string' || typeof kb !== 'string' || !(ka > kb)) return row;
  return { ...row, [a]: row[b], [b]: row[a] };
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
// columns included), sorted by name. A slice: only its columns + naturalKey.
async function liveColumns(db, spec) {
  const { rows } = await db.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [spec.table],
  );
  const skip = new Set([...Object.keys(spec.omit || {}), ...(spec.secretColumns || [])]);
  // A slice reads only its columns plus the natural key.
  const only = spec.slice ? new Set([...spec.columns, ...spec.naturalKey]) : null;
  if (only) {
    const have = new Set(rows.map((r) => r.column_name));
    const gone = [...only].filter((c) => !have.has(c));
    if (gone.length) throw new Error(`seed-sync: slice of ${spec.table} names missing columns ${gone.join(', ')}`);
  }
  return rows
    .filter((r) => !skip.has(r.column_name) && (!only || only.has(r.column_name)))
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
  const omit = spec.omit || {};
  // A slice answers only for the columns it reads (the owner covers the rest).
  const reads = spec.slice ? new Set([...spec.columns, ...spec.naturalKey]) : null;
  const out = [];
  for (const [col, targets] of fkTargets) {
    if (reads && !reads.has(col)) continue;
    const target = [...targets].sort().join(',');
    if (Object.prototype.hasOwnProperty.call(refs, col)) {
      if (targets.size !== 1 || !targets.has(refs[col].table)) {
        out.push({ column: col, problem: 'wrong_target', target, declared: refs[col].table });
      }
    } else if (!Object.prototype.hasOwnProperty.call(omit, col)) {
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
  if (spec.slice) {
    for (const [col] of entries) if (!spec.columns.includes(col) && !spec.naturalKey.includes(col)) hidden.add(col);
  }
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
  GROUPS, getGroup, tableSpecs, specOfTable, ownerLabel, rowPredicate, scopeSql, quoteIdent, pairKeyCol, orderPair, soleSpec,
  liveColumns, fkProblems, nameRefProblems, NAME_REF_SHAPES, _withTestGroups,
};
