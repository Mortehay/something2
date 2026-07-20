const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { applyDamage, ELEMENTS, MIN_DAMAGE } = require('../src/authority/damage.js');
const { ELEMENT_EFFECTS, BURN_MAGNITUDE, BURN_TICK_MS, BURN_DURATION_MS } = require('../src/authority/effects.js');
const { SEED_ROWS } = require('./fixtures/weapon_catalog.js');

// REACHABILITY AND BALANCE INVARIANTS FOR THE ELEMENTAL SYSTEM.
//
// Every other elements test in this directory asks "does the code do what it
// says?". This file asks the question those tests structurally cannot: "does
// what it says MATTER?".
//
// That question is not academic here. This project has twice shipped a feature
// that was fully implemented, fully tested and completely inert — a stamina
// economy whose numbers guaranteed its own gate never engaged, and an entire
// elemental system that did nothing in PvE because creature damage never went
// through the mitigation path. In both cases the unit tests were green and
// correct. They were testing a mechanism; nobody was testing that the
// mechanism could ever be observed by a player.
//
// So every assertion below is written to fail if its subject were made inert
// while remaining "working". Each has been verified by mutation: the mutation
// that neuters the mechanic is named in the comment above the test.

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: err.message };
  }
}

// Elements a weapon can actually be built around. `physical` is excluded from
// the "something must resist it" sweep below only where noted; it is included
// in the per-creature "nothing resists everything" sweep, because a creature
// resisting all five really would be unbeatable.
const ELEMENTAL = ['fire', 'ice', 'lightning'];

// --- Content reachability: the resistances have to EXIST, in the real DB ---
//
// A mocked pool proves nothing here. The claim is about content — rows an
// operator seeded — not about code, and a mock would happily return whatever
// matchup the test wants to see. Same skip-loudly-but-fail-under-CI shape as
// authority_ammo_db.test.js.
//
// MUTATION CHECK: set every creature's resistances to '{}' and this goes RED
// on the `withRes` count.
test('creature resistances are populated AND form a real matchup', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — whether the elemental matchup EXISTS in content is UNVERIFIED on this run`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    const r = await pool.query(
      'SELECT name, resistances FROM entity_types WHERE is_creature = true ORDER BY id');
    const creatures = r.rows;
    assert.ok(creatures.length >= 4,
      `only ${creatures.length} creature types exist — with fewer than a handful, resistances are a flat nerf rather than a choice`);

    // Half one: populated at all.
    const withRes = creatures.filter((c) => Object.keys(c.resistances || {}).length > 0);
    assert.ok(withRes.length >= 3,
      `only ${withRes.length} creature types carry any resistance — element choice cannot change an outcome, which is exactly the inert state this slice exists to remove`);

    // Half two, and this is the load-bearing one. The count above still passes
    // if a future edit makes EVERY creature fire-resistant, or leaves one
    // element resisted by nobody — both of which collapse the matchup back
    // into "always bring X", which is a flat nerf wearing a matchup's clothes.

    // No creature is a wall: each must have at least one clean answer.
    for (const c of creatures) {
      const unresisted = ELEMENTS.filter((e) => !((c.resistances || {})[e] > 0));
      assert.ok(unresisted.length > 0,
        `${c.name} resists all of ${ELEMENTS.join('/')} — no weapon choice can beat it cleanly`);
    }

    // No element is a skeleton key: each of the three RIDER-carrying elements
    // must be resisted by somebody, or it is strictly safe to always bring it.
    for (const el of ELEMENTAL) {
      const resisters = creatures.filter((c) => ((c.resistances || {})[el] > 0));
      assert.ok(resisters.length > 0,
        `no creature resists ${el}, so ${el} is strictly safe to always bring — that is not a matchup`);
    }

    // `arcane` is DELIBERATELY absent from that sweep: nothing resists it, and
    // that is its identity — reliable unresisted damage, paid for by carrying
    // no status rider at all. That exemption is only honest while the second
    // half of the trade is true, so pin it. If someone gives arcane a rider,
    // this fails and forces the exemption to be re-argued rather than
    // inherited.
    assert.equal(ELEMENT_EFFECTS.arcane, undefined,
      'arcane gained a status rider, so its exemption from the "something must resist it" rule above is no longer paid for — either remove the rider or give arcane a resister');
    const arcaneResisters = creatures.filter((c) => ((c.resistances || {}).arcane > 0));
    assert.equal(arcaneResisters.length, 0,
      `${arcaneResisters.map((c) => c.name).join(', ')} resists arcane — arcane's whole identity is that it is never resisted; if that is changing, it needs a rider to compensate`);
  } finally {
    await pool.end().catch(() => {});
  }
});

// --- Mechanical reachability: the resistances must change a NUMBER ---
//
// The test above proves the content exists. It does not prove a player can
// ever see it, and that gap is precisely where this project's last inert
// feature lived. Two things can silently swallow a resistance before it
// reaches the HP bar: creature `defense` is subtracted BEFORE the resistance
// multiplier, and applyDamage clamps at MIN_DAMAGE. A resistance whose whole
// effect is absorbed by either is content that exists and does nothing.
//
// So: run the REAL catalog damage numbers through the REAL mitigation path
// against the REAL creature rows, and require the element swap to move the
// dealt damage by at least one full point.
//
// MUTATION CHECK: set every creature's resistances to '{}' and this goes RED
// (the resisted and unresisted results become identical).
test('every seeded resistance changes real dealt damage by more than the damage floor', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — whether seeded resistances survive defense and the MIN_DAMAGE floor is UNVERIFIED on this run`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    const r = await pool.query(
      'SELECT name, defense, resistances FROM entity_types WHERE is_creature = true ORDER BY id');

    // A representative real weapon per element, chosen from the catalog rather
    // than invented: the strongest weapon actually carrying that element is
    // the most favourable case for the resistance being visible, so if the
    // swing is invisible even here it is invisible everywhere.
    const weaponDamageFor = (el) => {
      const rows = SEED_ROWS.filter((w) => w.category === 'weapon'
        && (el === 'physical' ? w.element == null : w.element === el));
      assert.ok(rows.length, `the catalog carries no ${el} weapon, so a ${el} resistance is unreachable by construction`);
      return Math.max(...rows.map((w) => w.damage));
    };

    let checked = 0;
    for (const c of r.rows) {
      const resistances = c.resistances || {};
      const mit = { defense: Number(c.defense) || 0, resistances };
      // An element this creature does NOT resist, to compare against. Every
      // creature has one — the test above enforces that.
      const clean = ELEMENTS.find((e) => !(resistances[e] > 0));
      assert.ok(clean, `${c.name} has no unresisted element to compare against`);

      for (const [el, value] of Object.entries(resistances)) {
        if (!(value > 0)) continue;
        // Same raw damage, same defense, same target: the ONLY difference
        // between the two calls is the element label, so any gap is the
        // resistance and nothing else.
        const raw = weaponDamageFor(el);
        const hit = (element) => applyDamage({ hp: 10000 }, raw, element, mit);
        const resisted = hit(el);
        const unresisted = hit(clean);
        assert.ok(unresisted - resisted >= MIN_DAMAGE,
          `${c.name}'s ${el} resistance of ${value} moves a real ${raw}-damage ${el} hit by only `
          + `${(unresisted - resisted).toFixed(2)} (${unresisted} -> ${resisted}) after defense ${mit.defense} `
          + `and the MIN_DAMAGE floor — a swing smaller than one hit point is a resistance the player can never see`);
        checked++;
      }
    }
    // Without this the loop above is vacuously green on an empty creature set,
    // which is the single most likely way this file joins the ten vacuous
    // tests already shipped here.
    assert.ok(checked >= 4,
      `only ${checked} seeded resistance values were exercised — too few for this to be evidence of a matchup`);
  } finally {
    await pool.end().catch(() => {});
  }
});

// --- Burn must be worth applying ---
//
// Burn is fire's entire reason to exist over arcane: arcane out-damages it per
// hit and is never resisted, so if the DOT is a rounding error there is no
// reason to ever bring fire. 30% of a hit is the floor at which the rider is a
// reason rather than a decoration.
//
// MUTATION CHECK: shrink BURN_MAGNITUDE to 1 or BURN_DURATION_MS to 2000 and
// this goes RED.
test('burn is a meaningful fraction of a flame staff hit, not decoration', () => {
  const flame = SEED_ROWS.find((w) => w.name === 'flame staff');
  assert.ok(flame && flame.element === 'fire',
    'the flame staff must exist and carry fire, or this test is measuring burn against nothing');
  const ticks = BURN_DURATION_MS / BURN_TICK_MS;
  assert.ok(Number.isInteger(ticks) && ticks > 0,
    `burn lasts ${BURN_DURATION_MS}ms on a ${BURN_TICK_MS}ms tick — a non-integer or zero tick count means the last tick may never fire`);
  const total = BURN_MAGNITUDE * ticks;
  assert.ok(total >= flame.damage * 0.3,
    `a full burn deals ${total} against the flame staff's ${flame.damage} hit (${((total / flame.damage) * 100).toFixed(0)}%) — under 30% the rider is decoration and fire has no case against arcane`);
});

// --- Lightning must pay for its riders ---
//
// Shock carries all three riders (vulnerability, mana drain, interrupt). If the
// storm staff were also efficient, lightning would be strictly correct and the
// other staves would be dead content — the "everything is a choice" claim this
// slice makes would be false while every mechanical test stayed green.
//
// MUTATION CHECK: set the storm staff's mana_cost to 14 (making it the best
// dmg/mana in the game) and this goes RED.
test('storm staff pays for its riders: strictly the worst damage-per-mana of any staff', () => {
  const staves = SEED_ROWS.filter((w) => w.category === 'weapon' && w.mana_cost > 0);
  // Guard against the comparison becoming vacuous if the catalog shrinks: with
  // one staff there is nothing to be worse than, and the loop below would pass
  // without executing a single assertion.
  assert.ok(staves.length >= 4,
    `only ${staves.length} mana-costing weapons exist — with this few there is no efficiency ladder for the storm staff to sit at the bottom of`);
  const storm = staves.find((s) => s.name === 'storm staff');
  assert.ok(storm && storm.element === 'lightning',
    'the storm staff must exist and carry lightning');
  const dpm = (s) => s.damage / s.mana_cost;
  for (const s of staves) {
    if (s.name === storm.name) continue;
    assert.ok(dpm(storm) < dpm(s),
      `the storm staff carries all three lightning riders, so it must pay for them — but its `
      + `${dpm(storm).toFixed(3)} dmg/mana is not worse than ${s.name}'s ${dpm(s).toFixed(3)}`);
  }
});

// NOT WRITTEN HERE, DELIBERATELY: a chill reachability test.
//
// The brief specified `PLAYER_SPEED * CHILL_MAGNITUDE <= PLAYER_SPEED * 0.7`.
// PLAYER_SPEED cancels, so that reduces to `CHILL_MAGNITUDE <= 0.7` — a
// comparison between two literals that never touches the movement code and
// would keep passing if chill were never read by anything. It is falsifiable
// only by editing the constant it reads.
//
// The behavioural version already exists: `chill is reachable as a PvP
// mechanic: the speed gap closes real distance` in authority_world.test.js
// (added by Task 7) runs a real 1-second two-player chase through World.tick
// and asserts the chaser closes real distance. That fails if chill stops being
// applied to movement at all — which the literal comparison would not. Adding a
// second, weaker copy here would only add a place for the two to disagree.
