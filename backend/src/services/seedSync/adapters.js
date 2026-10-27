// Adapter groups (registry `adapter`, plan 4a): groups that sync something
// other than TableSpec rows. diffGroup / previewSeed / applySeed / exportGroup
// hand such a group to its adapter, which answers with the same shapes:
//   status(db)                      -> diffGroup's summary
//   preview(pool)                   -> previewSeed's { ...summary, rows, warnings, signature }
//   apply(pool, decisions, opts)    -> applySeed's { runId, summary }
//   export(pool, opts)              -> exportGroup's { runId, rowCount, rowCounts }
// Required lazily: an adapter may pull in a large stack (maps: seed-map.js).
const { getGroup } = require('./registry.js');

const ADAPTERS = {
  maps: () => require('./mapsGroup.js'),
};

// The adapter of a group (by id), or null for a TableSpec group.
function adapterOf(groupId) {
  const g = getGroup(groupId);
  if (!g.adapter) return null;
  const load = ADAPTERS[g.adapter];
  if (!load) throw new Error(`seed-sync: group ${g.id} names unknown adapter ${g.adapter}`);
  return load();
}

module.exports = { adapterOf };
