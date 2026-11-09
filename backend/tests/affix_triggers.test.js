// Trigger affixes (authority/triggers.js): on-hit statuses as riders, kill and hurt events, cooldowns and chances,
// and the places in the authority that wire them. Offline.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const triggers = require('../src/authority/triggers.js');
const balance = require('../src/authority/skillBalance.js');
const { applyHitStatuses, hasEffect, BURN, CHILL, SHOCK } = require('../src/authority/effects.js');
const { TRIGGER_AFFIXES } = require('../seeds/data/affixTypes.js');

test.afterEach(() => balance.setRng());

const eff = (key) => TRIGGER_AFFIXES.find((a) => a.key === key).effect;
const aff = (key, value) => ({ key, label: key, value, effect: eff(key) });

const player = (over = {}) => ({
  userId: 1, hp: 50, maxHp: 100, mana: 10, maxMana: 100, stamina: 20, maxStamina: 100, buffs: new Map(), ...over,
});

// ---------------------------------------------------------------- reading an affix

test('triggerOf reads the roll as a chance or as a size, and refuses what it cannot run', () => {
  const harvest = triggers.triggerOf(aff('of_the_harvest', 5));
  assert.deepEqual([harvest.on, harvest.action, harvest.pool, harvest.chance, harvest.magnitude], ['kill', 'restore', 'mana', 1, 0.05]);
  const turtle = triggers.triggerOf(aff('of_the_turtle', 20));
  assert.deepEqual([turtle.on, turtle.action, turtle.chance, turtle.cooldownMs], ['hurt', 'buff', 0.2, 8000]);
  assert.equal(turtle.buff.id, 'trg_ward');
  const phoenix = triggers.triggerOf(aff('of_the_phoenix', 10));
  assert.deepEqual([phoenix.action, phoenix.chance, phoenix.magnitude], ['heal', 0.1, 0.08]);
  const embers = triggers.triggerOf(aff('of_embers', 10));
  assert.deepEqual([embers.on, embers.action, embers.status, embers.chance], ['hit', 'status', 'burn', 0.1]);

  assert.equal(triggers.triggerOf(null), null);
  assert.equal(triggers.triggerOf({ value: 5, effect: { type: 'stat', stat: 'strength' } }), null, 'not a trigger');
  assert.equal(triggers.triggerOf(aff('of_the_harvest', 0)), null, 'a zero roll does nothing');
  assert.equal(triggers.triggerOf(aff('of_the_harvest', -3)), null);
  assert.equal(triggers.triggerOf({ value: 5, effect: { type: 'trigger', on: 'kill', action: 'restore', pool: 'gold' } }), null, 'a pool that does not exist');
  assert.equal(triggers.triggerOf({ value: 5, effect: { type: 'trigger', on: 'kill', action: 'nova' } }), null, 'an action that does not exist');
  assert.equal(triggers.triggerOf({ value: 5, effect: { type: 'trigger', on: 'sneeze', action: 'heal' } }), null, 'an event that does not exist');
  assert.equal(triggers.triggerOf({ value: 5, effect: { type: 'trigger', on: 'hurt', action: 'buff', buff: { id: 'x', ms: 0 } } }), null, 'a buff with no duration');
  assert.equal(triggers.triggerOf({ value: 5, effect: { type: 'trigger', on: 'hit', action: 'status' } }), null, 'a status with no name');
});

test('only EQUIPPED, non-dormant gear gives triggers', () => {
  const inv = {
    equipment: { head: 'h', chest: 'c' },
    dormant: new Set(['c']),
    items: [
      { id: 'h', affixes: [aff('of_the_harvest', 5), aff('of_embers', 8)] },
      { id: 'c', affixes: [aff('of_the_turtle', 20)] },
      { id: 'bag', affixes: [aff('of_the_hunter', 5)] },
    ],
  };
  assert.deepEqual(triggers.equippedTriggers(inv).map((t) => t.key).sort(), ['of_embers', 'of_the_harvest']);
  assert.deepEqual(triggers.equippedTriggers(null), []);
  assert.deepEqual(triggers.equippedTriggers({ equipment: {}, items: [] }), []);
});

test('withTriggerStats turns on-hit statuses into riders and keeps the rest as events, without touching the input', () => {
  const stats = Object.freeze({ hitStatuses: Object.freeze(['chill']), rules: {} });
  const list = [triggers.triggerOf(aff('of_embers', 10)), triggers.triggerOf(aff('of_the_harvest', 5))];
  const out = triggers.withTriggerStats(stats, list);
  assert.deepEqual(out.hitStatuses, ['chill', { status: 'burn', chance: 0.1 }]);
  assert.deepEqual(out.triggers.map((t) => t.key), ['of_the_harvest']);
  assert.deepEqual(stats.hitStatuses, ['chill'], 'the shared stats row is not mutated');
  assert.equal(triggers.withTriggerStats(stats, []), stats, 'nothing to add: the same object');
  assert.equal(triggers.withTriggerStats(null, list), null);
});

// ---------------------------------------------------------------- on hit: riders through applyHitStatuses

test('an on-hit rider stamps its status by chance, exactly like the tree\'s riders', () => {
  for (const [status, key] of [['burn', BURN], ['chill', CHILL], ['shock', SHOCK]]) {
    const hit = { effects: new Map() };
    balance.setRng(() => 0);                      // always under the chance
    const applied = applyHitStatuses(hit, [{ status, chance: 0.1 }], 1000, 'u1');
    assert.deepEqual(applied, [key], status);
    assert.equal(hasEffect(hit, key, 1100), true, status);

    const miss = { effects: new Map() };
    balance.setRng(() => 0.99);                   // never under it
    assert.equal(applyHitStatuses(miss, [{ status, chance: 0.1 }], 1000, 'u1'), null, status);
    assert.equal(hasEffect(miss, key, 1100), false);
  }
});

test('a rider and a plain status can sit side by side, and an unknown rider is skipped, not defaulted', () => {
  balance.setRng(() => 0);
  const t = { effects: new Map() };
  const applied = applyHitStatuses(t, ['chill', { status: 'burn', chance: 1 }, { status: 'nonsense', chance: 1 }], 1000, 'u1');
  assert.deepEqual(applied.sort(), [BURN, CHILL].sort());
});

// ---------------------------------------------------------------- events

test('a kill restores mana and stamina as a share of the maximum, capped at the maximum', () => {
  const p = player({ stats: { triggers: [triggers.triggerOf(aff('of_the_harvest', 8)), triggers.triggerOf(aff('of_the_hunter', 5))] } });
  const fired = triggers.fire(p, 'kill', 1000);
  assert.deepEqual(fired.sort(), ['of_the_harvest', 'of_the_hunter']);
  assert.equal(p.mana, 18);        // 10 + 8% of 100
  assert.equal(p.stamina, 25);     // 20 + 5% of 100
  const full = player({ mana: 99, stats: { triggers: [triggers.triggerOf(aff('of_the_harvest', 8))] } });
  triggers.fire(full, 'kill', 1000);
  assert.equal(full.mana, 100, 'never above the maximum');
});

test('events only run their own triggers: a kill does not fire a "when hit" affix', () => {
  const p = player({ stats: { triggers: [triggers.triggerOf(aff('of_the_phoenix', 100)), triggers.triggerOf(aff('of_the_harvest', 5))] } });
  assert.deepEqual(triggers.fire(p, 'kill', 0), ['of_the_harvest']);
  assert.equal(p.hp, 50);
  assert.deepEqual(triggers.fire(p, 'hurt', 0), ['of_the_phoenix']);
  assert.equal(p.hp, 58);          // + 8% of 100
});

test('a chance is rolled, and a cooldown keeps a trigger from firing again too soon', () => {
  const turtle = triggers.triggerOf(aff('of_the_turtle', 25));
  const p = player({ stats: { triggers: [turtle] } });
  assert.deepEqual(triggers.fire(p, 'hurt', 1000, () => 0.9), [], 'rolled above the 25% chance');
  assert.deepEqual(triggers.fire(p, 'hurt', 1000, () => 0.1), ['of_the_turtle']);
  assert.ok(p.buffs.has('trg_ward'), 'the ward is a real buff the client lists');
  assert.equal(p.buffs.get('trg_ward').durationMs, 4000);
  assert.deepEqual(triggers.fire(p, 'hurt', 5000, () => 0), [], 'still cooling down (8s)');
  assert.deepEqual(triggers.fire(p, 'hurt', 9001, () => 0), ['of_the_turtle'], 'ready again');
});

test('the ward really cuts the damage taken, through the buff the engine already understands', () => {
  const p = player({ stats: { triggers: [triggers.triggerOf(aff('of_the_turtle', 100))] } });
  const before = balance.mitigateIncoming(p, 100, 'physical', 'c:x');
  assert.equal(before, 100);
  triggers.fire(p, 'hurt', 0, () => 0);
  const after = balance.mitigateIncoming(p, 100, 'physical', 'c:x');
  assert.equal(after, 75, '-25% damage taken');
});

test('a dead player triggers nothing, and a player with no triggers costs nothing', () => {
  const dead = player({ hp: 0, stats: { triggers: [triggers.triggerOf(aff('of_the_harvest', 5))] } });
  assert.deepEqual(triggers.fire(dead, 'kill', 0), []);
  assert.deepEqual(triggers.fire(player(), 'kill', 0), []);
  assert.deepEqual(triggers.fire(null, 'kill', 0), []);
  assert.deepEqual(triggers.fire(player({ stats: {} }), 'kill', 0), []);
});

// ---------------------------------------------------------------- "when hit": the queue and the drain

test('a blow on a player with a "when hit" trigger is queued, once per blow, and delivered once per tick', () => {
  const p = player({ stats: { triggers: [triggers.triggerOf(aff('of_the_phoenix', 100))] } });
  balance.mitigateIncoming(p, 10, 'physical', 'c:a');
  balance.mitigateIncoming(p, 10, 'physical', 'c:b');
  assert.equal(p._pendingHurt, 2);
  const fired = triggers.drainHurt(p, 0);
  assert.deepEqual(fired, ['of_the_phoenix'], 'two blows, one evaluation');
  assert.equal(p._pendingHurt, 0);
  assert.deepEqual(triggers.drainHurt(p, 0), [], 'nothing queued: nothing to do');
});

test('a burn tick or an unattributed hit is not "being hit", and a player without the trigger queues nothing', () => {
  const p = player({ stats: { triggers: [triggers.triggerOf(aff('of_the_phoenix', 100))] } });
  p._dotTick = true;
  balance.mitigateIncoming(p, 10, 'fire', 'c:a');
  p._dotTick = false;
  balance.mitigateIncoming(p, 10, 'physical', null);
  assert.ok(!p._pendingHurt);
  const plain = player({ stats: { triggers: [triggers.triggerOf(aff('of_the_harvest', 5))] } });
  balance.mitigateIncoming(plain, 10, 'physical', 'c:a');
  assert.ok(!plain._pendingHurt, 'a kill trigger does not ask for hurt events');
  const bare = player();
  balance.mitigateIncoming(bare, 10, 'physical', 'c:a');
  assert.ok(!bare._pendingHurt);
});

// ---------------------------------------------------------------- wiring (source guards)

const read = (rel) => fs.readFileSync(path.join(__dirname, '../src', rel), 'utf8');

test('the authority wires the three events where every attack goes through', () => {
  const server = read('authority/server.js');
  assert.match(server, /triggers\.withTriggerStats\(derivePlayerStats\(row, classPools\), inv \? triggers\.equippedTriggers\(inv\) : \[\]\)/,
    'the frame boundary folds triggers into the stats');
  assert.match(server, /triggers\.fire\(killer, 'kill', entry\.world\.now\)/, 'every kill is credited through trackQuestKill');
  assert.match(read('authority/world.js'), /if \(p\._pendingHurt\) triggers\.drainHurt\(p, this\.now\)/);
  assert.match(read('authority/skillBalance.js'), /target\._pendingHurt = \(target\._pendingHurt \|\| 0\) \+ 1/);
  assert.match(read('authority/effects.js'), /STATUS_EFFECTS\[s\.status\]/);
});

test('a trigger affix is not also a stat-sheet modifier (no double counting)', () => {
  const src = read('services/gearAffixes.js');
  assert.match(src, /a\.effect\.type === 'trigger'\) continue/);
});
