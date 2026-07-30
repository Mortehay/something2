// Turning "link these two worlds on this edge" into an ordered list of API
// calls.
//
// The subtlety: setLink() upserts on (from_world_id, edge), twice — once for
// the link and once for its mirror. So creating a.E -> b when a.E -> c already
// exists overwrites a's row but leaves c.W -> a untouched and dangling, which
// is exactly the one-way-travel state the missing-mirror lint reports. Clearing
// the conflicting slots first (clearLink deletes BOTH sides) means the upsert
// never has anything to displace.
import { linksReplacedBy } from './mapGraphLint.js';

export function planLinkChange({ links, fromId, edge, toId }) {
  const clears = linksReplacedBy({ links, fromId, edge, toId })
    .map((row) => ({ fromId: row.from_world_id, edge: row.edge }));
  return { clears, create: { fromId, edge, toId } };
}
