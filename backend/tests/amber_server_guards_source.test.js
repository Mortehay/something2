// Amber Stance source gate for server.js / index.js wiring that the live test
// (amber_server_live.test.js) cannot reach one handler at a time. Reads the
// SOURCE: removing a guard, adding one to an unlisted handler, dropping a
// trigger skip or the production `amber: true` all fail here.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '../src/authority/server.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

// Every message handler that uses a world object (merchant, gem/skill
// merchant, blacksmith, bank, chest, quest node, portal travel) or casts
// (charm, teleport). `pickup` is deliberately NOT here: loot at your own feet
// stays allowed while sealed (and auto-loot runs anyway).
const GUARDED = [
  'travel', 'teleportCast', 'charm', 'buyGem', 'enchant', 'buyScrolls',
  'interact', 'openchest', 'buy', 'sell', 'openbank', 'deposit', 'withdraw',
].sort();

// Handler bodies inside `const messageHandlers = { ... }`: each starts at a
// four-space-indented `name(ws` and ends at the next four-space `},`.
function handlerBodies() {
  const start = server.indexOf('const messageHandlers = {');
  assert.ok(start > 0, 'messageHandlers table not found');
  const out = new Map();
  const re = /\n {4}(?:async )?([A-Za-z_]+)\(ws[^)]*\) \{([\s\S]*?)\n {4}\},/g;
  re.lastIndex = start;
  let m;
  while ((m = re.exec(server))) out.set(m[1], m[2]);
  return out;
}

test('exactly the world-object and casting handlers refuse a sealed player', () => {
  const bodies = handlerBodies();
  for (const name of GUARDED) assert.ok(bodies.has(name), `handler ${name} not found`);
  const guarded = [...bodies].filter(([, body]) => /refuseIfSealed\(ws, entry, \w+\)/.test(body)).map(([n]) => n).sort();
  assert.deepEqual(guarded, GUARDED);
});

test('pickup stays allowed while sealed', () => {
  assert.equal(/refuseIfSealed/.test(handlerBodies().get('pickup') || ''), false);
});

test('both tick-loop triggers (doorway/edge and portal) skip a sealed player', () => {
  const skip = 'if (amber.isSealed(p, entry.world.now)) continue;';
  const doorwayPlan = server.indexOf('const t = planTransition({');
  const portalPlan = server.indexOf('const t = planPortalTransition({');
  assert.ok(doorwayPlan > 0 && portalPlan > 0);
  const doorwayLoop = server.lastIndexOf('for (const p of entry.world.players.values())', doorwayPlan);
  const portalLoop = server.lastIndexOf('for (const p of entry.world.players.values())', portalPlan);
  assert.ok(server.slice(doorwayLoop, doorwayPlan).includes(skip), 'doorway/edge trigger skip missing');
  assert.ok(server.slice(portalLoop, portalPlan).includes(skip), 'portal trigger skip missing');
});

test('attack and skill refusals carry reason amber on the existing frames', () => {
  assert.match(server, /gate\.reason === 'amber'\)\) send\(ws, \{ type: 'attackrefused', reason: gate\.reason \}\)/);
  assert.match(server, /\['form', 'form_spell', 'requirements_unmet', 'weapon_mismatch', 'amber'\]\.includes\(reason\)/);
});

test('joins wait for the amber config, and the refresh timer is cleared on drain and close', () => {
  assert.match(server, /await amberConfigLoaded;\s*\n\s*entry\.world\.addPlayer\(/);
  assert.equal((server.match(/if \(amberTimer\) clearInterval\(amberTimer\);/g) || []).length, 2);
});

test('production turns amber on: index.js passes amber: true to attachAuthority', () => {
  assert.match(index, /attachAuthority\(server, pool, \{[^}]*\bamber: true\b[^}]*\}\)/);
});
