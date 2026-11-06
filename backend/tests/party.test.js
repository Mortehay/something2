const test = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../src/authority/world.js');
const {
  PartyManager, LOOT_MODES, xpShareFactor, MAX_PARTY_SIZE,
} = require('../src/authority/party.js');

function party(...ids) {
  const pm = new PartyManager();
  const [leader, ...rest] = ids;
  for (const id of rest) {
    assert.equal(pm.invite(leader, id).ok, true);
    assert.equal(pm.accept(id).ok, true);
  }
  return pm;
}

// ---- membership -----------------------------------------------------------

test('invite -> accept creates a party led by the inviter', () => {
  const pm = party('a', 'b');
  assert.equal(pm.sameParty('a', 'b'), true);
  assert.equal(pm.partyOf('a').leaderId, 'a');
});

test('a declined or expired invite leaves no party behind', () => {
  let now = 0;
  const pm = new PartyManager({ now: () => now, inviteTtlMs: 1000 });
  pm.invite('a', 'b');
  assert.equal(pm.decline('b').ok, true);
  assert.equal(pm.partyOf('a'), null);
  pm.invite('a', 'c');
  now = 2000;
  assert.equal(pm.accept('c').reason, 'no_invite');
  assert.equal(pm.partyOf('a'), null);
});

test('party is capped at four and only the leader can invite', () => {
  const pm = party('a', 'b', 'c', 'd');
  assert.equal(MAX_PARTY_SIZE, 4);
  assert.equal(pm.invite('a', 'e').reason, 'party_full');
  assert.equal(pm.invite('b', 'e').reason, 'not_leader');
});

test('cannot invite someone already in a party', () => {
  const pm = party('a', 'b');
  assert.equal(pm.invite('a', 'b').reason, 'already_in_party');
});

test('kick: leader only, target must be a member', () => {
  const pm = party('a', 'b', 'c');
  assert.equal(pm.kick('b', 'c').reason, 'not_leader');
  assert.equal(pm.kick('a', 'x').reason, 'not_member');
  assert.equal(pm.kick('a', 'c').ok, true);
  assert.equal(pm.partyOf('c'), null);
  assert.equal(pm.sameParty('a', 'b'), true);
});

test('transfer leadership, then the old leader loses kick rights', () => {
  const pm = party('a', 'b', 'c');
  assert.equal(pm.transferLeader('a', 'b').ok, true);
  assert.equal(pm.kick('a', 'c').reason, 'not_leader');
  assert.equal(pm.kick('b', 'c').ok, true);
});

test('the leader leaving promotes the next member; a party of one disbands', () => {
  const pm = party('a', 'b', 'c');
  pm.leave('a');
  assert.equal(pm.partyOf('b').leaderId, 'b');
  pm.leave('c');
  assert.equal(pm.partyOf('b'), null, 'lone survivor is not a party');
});

test('a disconnect is a leave and drops the player\'s pending invites', () => {
  const pm = party('a', 'b', 'c');
  pm.invite('a', 'd');
  pm.removePlayer('a');
  assert.equal(pm.accept('d').reason, 'no_invite');
  assert.equal(pm.sameParty('b', 'c'), true);
});

test('onChange reports every user whose view changed', () => {
  const seen = [];
  const pm = new PartyManager({ onChange: (ids, ev) => seen.push([ids.sort(), ev.kind]) });
  pm.invite('a', 'b'); pm.accept('b'); pm.kick('a', 'b');
  assert.deepEqual(seen.map((s) => s[1]), ['invited', 'joined', 'disbanded']);
  assert.deepEqual(seen[2][0], ['a', 'b']);
});

// ---- friendly fire --------------------------------------------------------

test('canDamagePlayer: strangers yes, party-mates no, self no, unknown no', () => {
  const pm = party('a', 'b');
  assert.equal(pm.canDamagePlayer('a', 'c'), true);
  assert.equal(pm.canDamagePlayer('a', 'b'), false);
  assert.equal(pm.canDamagePlayer('a', 'a'), false);
  assert.equal(pm.canDamagePlayer(null, 'a'), false);
  pm.pvpEnabled = false;
  assert.equal(pm.canDamagePlayer('a', 'c'), false);
});

// ---- loot & xp ------------------------------------------------------------

test('loot reservation: free-for-all none, leader always leader, individual rotates', () => {
  const pm = party('a', 'b', 'c');
  assert.equal(pm.lootReservation('b', ['a', 'b', 'c']), null);
  assert.equal(pm.setLootMode('b', LOOT_MODES.LEADER).reason, 'not_leader');
  pm.setLootMode('a', LOOT_MODES.LEADER);
  assert.equal(pm.lootReservation('b', ['a', 'b', 'c']), 'a');
  assert.equal(pm.lootReservation('b', ['b', 'c']), null, 'absent leader -> free for all');
  pm.setLootMode('a', LOOT_MODES.INDIVIDUAL);
  const got = [1, 2, 3, 4].map(() => pm.lootReservation('a', ['a', 'b', 'c']));
  assert.deepEqual(got, ['a', 'b', 'c', 'a']);
  assert.equal(pm.setLootMode('a', 'bogus').reason, 'bad_mode');
});

test('xp share: grouping never pays less in total than solo', () => {
  assert.equal(xpShareFactor(1), 1);
  for (const n of [2, 3, 4]) assert.ok(xpShareFactor(n) * n >= 1);
  assert.ok(xpShareFactor(4) < xpShareFactor(2));
});

// ---- World integration: damage and cast replication -----------------------

function makeWorld() {
  const map = { isWalkable: () => true, width: 4000, height: 4000, decorations: [] };
  const staff = { id: 'item_staff', name: 'staff', category: 'weapon', kind: 'melee' };
  return new World(map, new Map([[staff.id, staff]]), staff.id);
}
function stats() {
  return {
    meleeMult: 1, spellMult: 1, level: 100, strength: 100, dexterity: 100, constitution: 100,
    intelligence: 100, wisdom: 100, charisma: 100,
    damageMult: { physical: 1, arcane: 1, fire: 1, ice: 1, lightning: 1, shadow: 1, holy: 1 },
    resists: {}, rules: {},
    sources: Object.fromEntries(['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']
      .map((k) => [k, { base: 100, tree: 0, gear: 0 }])),
  };
}
function add(world, id, x, y) {
  world.addPlayer(id, { x, y }, { items: [], equipment: {} }, { x, y }, 0, stats());
  const p = world.getPlayer(id);
  p.mana = 500; p.maxMana = 500; p.hp = 5000; p.maxHp = 5000;
  return p;
}

test('a skill damages an enemy player (the reported bug: it used to hit nobody)', () => {
  const w = makeWorld();
  const caster = add(w, 'a', 100, 100);
  const enemy = add(w, 'b', 250, 100);
  const hp0 = enemy.hp;
  const res = w.castSkill('a', 'mag_fireball', 250, 100, 1, 0);
  assert.equal(res.ok, true);
  assert.ok(enemy.hp < hp0, 'enemy took skill damage');
  assert.equal(caster.hp > 0, true);
});

test('the same skill passes through a party-mate (friendly fire blocked)', () => {
  const w = makeWorld();
  w.parties = party('a', 'b');
  add(w, 'a', 100, 100);
  const mate = add(w, 'b', 250, 100);
  const stranger = add(w, 'c', 250, 140);
  const mateHp = mate.hp, strangerHp = stranger.hp;
  w.castSkill('a', 'mag_fireball', 250, 100, 1, 0);
  assert.equal(mate.hp, mateHp, 'party-mate untouched');
  assert.ok(stranger.hp < strangerHp, 'non-member standing beside them is hit');
});

test('melee swing respects the party', () => {
  const w = makeWorld();
  w.parties = party('a', 'b');
  add(w, 'a', 100, 100);
  const mate = add(w, 'b', 130, 100);
  const hp0 = mate.hp;
  w.attack('a', 1, 0);
  assert.equal(mate.hp, hp0, 'swing passes through party-mate');

  const pm = new PartyManager();
  const w2 = makeWorld(); w2.parties = pm;
  add(w2, 'a', 100, 100);
  const foe = add(w2, 'b', 130, 100);
  const foeHp = foe.hp;
  w2.attack('a', 1, 0);
  assert.ok(foe.hp < foeHp, 'same swing hurts a stranger');
});

test('every successful cast is queued as a replicable event, exactly once', () => {
  const w = makeWorld();
  add(w, 'a', 100, 100);
  assert.equal(w.castSkill('a', 'mag_fireball', 250, 120, 1, 0).ok, true);
  const casts = w.drainCasts();
  assert.equal(casts.length, 1);
  assert.equal(casts[0].s, 'mag_fireball');
  assert.equal(casts[0].by, 'a');
  assert.equal(casts[0].tx, 250);
  assert.ok(Math.abs(Math.hypot(casts[0].nx, casts[0].ny) - 1) < 1e-9, 'aim is a unit vector');
  assert.equal(w.drainCasts().length, 0, 'drained');
});

test('a refused cast (no mana) emits no event', () => {
  const w = makeWorld();
  const p = add(w, 'a', 100, 100);
  p.mana = 0;
  assert.equal(w.castSkill('a', 'mag_fireball', 250, 100, 1, 0).ok, false);
  assert.equal(w.drainCasts().length, 0);
});

test('a projectile (direct hit and blast share this gate) skips party-mates only', () => {
  const { projectileHitsPlayer } = require('../src/authority/projectiles.js');
  const pm = party('a', 'b');
  const gate = (x, y) => pm.canDamagePlayer(x, y);
  const shot = { ownerKind: 'player', ownerId: 'a' };
  assert.equal(projectileHitsPlayer(shot, { userId: 'b' }, gate), false, 'party-mate');
  assert.equal(projectileHitsPlayer(shot, { userId: 'c' }, gate), true, 'stranger');
  assert.equal(projectileHitsPlayer(shot, { userId: 'a' }, gate), false, 'owner');
  assert.equal(projectileHitsPlayer(shot, { userId: 'c' }), true, 'no gate = old rule');
  const guard = { ownerKind: 'creature', ownerFaction: 'hostile', ownerId: 'cr1' };
  assert.equal(projectileHitsPlayer(guard, { userId: 'b' }, gate), true, 'creatures are not party-gated');
});

// ---- service + AOI + loot gate ------------------------------------------------

test('castsNear: in-view casts reach others, never the caster, never far strangers', () => {
  const { castsNear } = require('../src/authority/playerAoi.js');
  const casts = [
    { s: 'x', by: 'a', x: 100, y: 100, tx: 300, ty: 100 },
    { s: 'y', by: 'z', x: 90000, y: 90000, tx: 90100, ty: 90000 },
    { s: 'far-cast-lands-near', by: 'q', x: 90000, y: 90000, tx: 150, ty: 150 },
  ];
  const seen = castsNear(casts, 120, 120, 8, 'b').map((c) => c.s);
  assert.deepEqual(seen, ['x', 'far-cast-lands-near']);
  assert.equal(castsNear(casts, 120, 120, 8, 'a').some((c) => c.by === 'a'), false);
  assert.deepEqual(castsNear([], 0, 0, 640, 'a'), []);
});

test('GroundItemSim reservation: only the holder until it expires, then everyone', () => {
  const { GroundItemSim } = require('../src/authority/groundItems.js');
  const g = new GroundItemSim(8);
  g.add([{ id: 1, item_type_id: 1, x: 0, y: 0, expires_at: null }]);
  assert.equal(g.canClaim(1, 'b', 0), true, 'unreserved');
  g.reserve(1, 'a', 1000);
  assert.equal(g.canClaim(1, 'a', 500), true);
  assert.equal(g.canClaim(1, 'b', 500), false);
  assert.equal(g.canClaim(1, 'b', 1000), true, 'reservation expired');
});

test('party service: invite -> accept -> frame with vitals, kick, errors', () => {
  const { createPartyService } = require('../src/authority/partyService.js');
  const sent = [];
  const mk = (id) => ({ userId: id, characterName: id.toUpperCase() });
  const sessions = new Map([['a', mk('a')], ['b', mk('b')], ['c', mk('c')]]);
  const world = makeWorld();
  add(world, 'a', 100, 100); add(world, 'b', 200, 100); add(world, 'c', 300, 100);
  const worlds = new Map([['w1', { worldId: 'w1', world }]]);
  const svc = createPartyService({ worlds, sessionsByUser: sessions, send: (ws, m) => sent.push([ws.userId, m]) });
  const wsA = { userId: 'a', worldId: 'w1' }, wsB = { userId: 'b', worldId: 'w1' };
  svc.handlers.partyInvite(wsA, { targetId: 'b' });
  assert.ok(sent.some(([u, m]) => u === 'b' && m.type === 'partyInvite' && m.fromName === 'A'));
  svc.handlers.partyAccept(wsB);
  const last = sent.filter(([u, m]) => u === 'b' && m.type === 'party').pop()[1].party;
  assert.equal(last.leaderId, 'a');
  assert.equal(last.members.length, 2);
  const mb = last.members.find((m) => m.id === 'b');
  assert.equal(mb.hp, 5000); assert.equal(mb.w, 'w1'); assert.ok(mb.x > 0);
  // wire ids arrive as JSON strings/numbers; a non-member cannot be kicked
  sent.length = 0;
  svc.handlers.partyKick(wsA, { targetId: 'c' });
  assert.deepEqual(sent.pop(), ['a', { type: 'partyError', reason: 'not_member' }]);
  svc.handlers.partyKick(wsB, { targetId: 'a' });
  assert.equal(sent.pop()[1].reason, 'not_leader');
  // sharers: only alive, in-range members of the killer's party
  assert.deepEqual(svc.sharers(worlds.get('w1'), 'a', 100, 100), ['a', 'b']);
  world.getPlayer('b').hp = 0;
  assert.deepEqual(svc.sharers(worlds.get('w1'), 'a', 100, 100), [], 'a lone survivor shares with nobody');
});

test('party service: a disconnect keeps the seat through the grace window', () => {
  const { createPartyService } = require('../src/authority/partyService.js');
  const timers = [];
  const sessions = new Map([['a', { userId: 'a' }], ['b', { userId: 'b' }]]);
  const svc = createPartyService({
    worlds: new Map([['w', { worldId: 'w', world: makeWorld() }]]), sessionsByUser: sessions,
    send: () => {}, setTimer: (fn) => { timers.push(fn); return {}; },
  });
  svc.parties.invite('a', 'b'); svc.parties.accept('b');
  sessions.delete('b');                       // socket closed (e.g. doorway transition)
  svc.onDisconnect('b');
  assert.equal(svc.parties.sameParty('a', 'b'), true, 'seat held');
  sessions.set('b', { userId: 'b' });         // reconnected
  timers[0]();
  assert.equal(svc.parties.sameParty('a', 'b'), true, 'reconnect keeps the seat');
  sessions.delete('b'); svc.onDisconnect('b'); timers[1]();
  assert.equal(svc.parties.sameParty('a', 'b'), false, 'gone for good after the grace window');
});
