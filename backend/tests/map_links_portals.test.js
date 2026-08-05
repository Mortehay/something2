// backend/tests/map_links_portals.test.js
const test = require('node:test');
const assert = require('node:assert');
const { setPortalLink, clearPortalLink, fetchLinks } = require('../src/services/mapLinks.js');

// A fake pool whose query() just records calls and returns canned rows --
// same style as this repo's other service-level tests (route() dispatch on
// a regex against the SQL text). No live DB needed for these.
function fakePool() {
  const calls = [];
  const links = []; // { from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y }
  return {
    calls,
    links,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^\s*INSERT INTO map_links/i.test(sql)) {
        let id, link;
        if (params.length === 3) {
          // setLink case: [fromId, edge, toId]
          const [fromId, edge, toId] = params;
          id = `link-${links.length}`;
          link = { id, from_world_id: fromId, edge, to_world_id: toId,
            from_x: null, from_y: null, to_x: null, to_y: null };
        } else if (params.length === 6) {
          // setPortalLink case: [fromId, toId, fromX, fromY, toX, toY]
          const [fromId, toId, fromX, fromY, toX, toY] = params;
          id = `link-${links.length}`;
          link = { id, from_world_id: fromId, edge: 'PORTAL', to_world_id: toId,
            from_x: fromX, from_y: fromY, to_x: toX, to_y: toY };
        }
        if (link) {
          links.push(link);
        }
        return { rows: [{ id }] };
      }
      if (/^\s*DELETE FROM map_links/i.test(sql)) {
        let idx = -1;
        if (sql.includes("edge = 'PORTAL'") && sql.includes("from_x")) {
          // clearPortalLink case with edge and coordinates
          const [fromId, fromX, fromY] = params;
          idx = links.findIndex((l) =>
            l.from_world_id === fromId && l.edge === 'PORTAL' && l.from_x === fromX && l.from_y === fromY);
        } else {
          // clearLink case without portal coordinates
          const [fromId, edge] = params;
          idx = links.findIndex((l) =>
            l.from_world_id === fromId && l.edge === edge);
        }
        const removed = idx >= 0 ? links.splice(idx, 1) : [];
        return { rows: removed };
      }
      if (/^\s*SELECT/i.test(sql)) {
        if (sql.includes("ml.id, ml.edge")) {
          // fetchLinks query
          const [worldId] = params;
          return { rows: links.filter((l) => l.from_world_id === worldId).map((l) => ({
            id: l.id, edge: l.edge, to_world_id: l.to_world_id,
            to_width: 10, to_height: 10,
            from_x: l.from_x, from_y: l.from_y, to_x: l.to_x, to_y: l.to_y,
          })) };
        } else if (sql.includes("to_world_id, to_x, to_y") && sql.includes("from_x")) {
          // clearPortalLink's SELECT query
          const [fromId, fromX, fromY] = params;
          const found = links.filter((l) =>
            l.from_world_id === fromId && l.edge === 'PORTAL' && l.from_x === fromX && l.from_y === fromY);
          return { rows: found.map((l) => ({
            to_world_id: l.to_world_id, to_x: l.to_x, to_y: l.to_y
          })) };
        } else {
          // clearLink's SELECT query or other queries
          const [fromId, edge] = params;
          const found = links.filter((l) =>
            l.from_world_id === fromId && l.edge === edge);
          return { rows: found.map((l) => ({ to_world_id: l.to_world_id })) };
        }
      }
      return { rows: [] };
    },
  };
}

test('setPortalLink writes both directions with swapped coordinates', async () => {
  const pool = fakePool();
  const { id } = await setPortalLink(pool, 'world-a', 100, 100, 'world-b', 50, 50);
  assert.equal(pool.links.length, 2, 'a two-way portal is two rows');
  const forward = pool.links.find((l) => l.id === id);
  assert.deepStrictEqual(
    { from: forward.from_world_id, fx: forward.from_x, fy: forward.from_y,
      to: forward.to_world_id, tx: forward.to_x, ty: forward.to_y },
    { from: 'world-a', fx: 100, fy: 100, to: 'world-b', tx: 50, ty: 50 });
  const mirror = pool.links.find((l) => l.id !== id);
  assert.deepStrictEqual(
    { from: mirror.from_world_id, fx: mirror.from_x, fy: mirror.from_y,
      to: mirror.to_world_id, tx: mirror.to_x, ty: mirror.to_y },
    { from: 'world-b', fx: 50, fy: 50, to: 'world-a', tx: 100, ty: 100 },
    'the mirror row swaps from and to entirely, giving two-way travel from one call');
  assert.ok(pool.links.every((l) => l.edge === 'PORTAL'));
});

test('clearPortalLink removes both the row and its mirror', async () => {
  const pool = fakePool();
  await setPortalLink(pool, 'world-a', 100, 100, 'world-b', 50, 50);
  await clearPortalLink(pool, 'world-a', 100, 100);
  assert.equal(pool.links.length, 0);
});

test('clearPortalLink on an unknown tile removes nothing', async () => {
  const pool = fakePool();
  await setPortalLink(pool, 'world-a', 100, 100, 'world-b', 50, 50);
  await clearPortalLink(pool, 'world-a', 999, 999);
  assert.equal(pool.links.length, 2, 'the wrong coordinates must not delete an unrelated portal');
});

test('fetchLinks returns coordinate fields for portal rows', async () => {
  const pool = fakePool();
  await setPortalLink(pool, 'world-a', 100, 100, 'world-b', 50, 50);
  const rows = await fetchLinks(pool, 'world-a');
  assert.equal(rows.length, 1);
  assert.deepStrictEqual(
    { edge: rows[0].edge, from_x: rows[0].from_x, from_y: rows[0].from_y,
      to_x: rows[0].to_x, to_y: rows[0].to_y },
    { edge: 'PORTAL', from_x: 100, from_y: 100, to_x: 50, to_y: 50 });
});
