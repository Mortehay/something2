// Ordered (seed order) registry of exportable data groups.
// `omit` columns are deliberately not exported (reason documented);
// `secretColumns` are never exported.
const GROUPS = [
  {
    id: 'tile_types',
    label: 'Tile Types',
    table: 'tile_types',
    naturalKey: 'name',
    omit: { id: 'local', created_at: 'local', updated_at: 'local', image: 'art group (plan 3)', sync_uuid: 'identity' },
    secretColumns: [],
  },
  {
    id: 'quests',
    label: 'Quests',
    table: 'quests',
    naturalKey: 'key',
    omit: { id: 'local', created_at: 'local', sync_uuid: 'identity' },
    secretColumns: [],
  },
  {
    id: 'ai_providers',
    label: 'AI Providers',
    table: 'ai_providers',
    naturalKey: 'name',
    omit: {
      id: 'local',
      created_at: 'local',
      updated_at: 'local',
      sync_uuid: 'identity',
      models_cache: 'machine cache',
      models_fetched_at: 'machine cache',
    },
    secretColumns: ['auth_token'],
  },
];

function getGroup(id) {
  const g = GROUPS.find((x) => x.id === id);
  if (!g) throw new Error('unknown group');
  return g;
}

async function liveColumns(db, group) {
  const { rows } = await db.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [group.table],
  );
  const skip = new Set([...Object.keys(group.omit), ...(group.secretColumns || [])]);
  return rows
    .filter((r) => !skip.has(r.column_name))
    .map((r) => ({ name: r.column_name, dataType: r.data_type }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

module.exports = { GROUPS, getGroup, liveColumns };
