# P4 Bestiary Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate 292 `entity_types` rows (288 new creatures across 32 lines × 9 rungs, plus 4 existing creatures re-themed to fit the taxonomy) with correct stats, resistances, level band, sprite prompt, gold, and at least one drop rule each — deterministically derived from the umbrella spec's fixed tables, committed as reviewable seed data, with zero schema changes.

**Architecture:** Three pure-function modules (template data, field-derivation rules, drop-item mapping) feed a generator script that emits a committed seed-data file in the existing `entityTypes.js` shape. Legacy creature remapping is a separate, explicit edit to the existing seed file. Both plug into the existing `seed-catalogs.js` pipeline — no new migration, no schema change.

**Tech Stack:** Backend CommonJS, `node:test`/`node:assert`, raw `pg` (only for the final seed-and-verify task).

**Spec:** `docs/superpowers/specs/2026-08-08-p4-bestiary-design.md` (committed `3a12997`)
**Plane item:** SOMET-250

---

## Global Constraints

Every task's requirements implicitly include this section.

### Source of truth

The umbrella spec's two tables are the only source of truth for line and rung data — never
invent a value not traceable to `docs/superpowers/specs/2026-08-06-bestiary-program-design.md`'s
"The 32 lines" and rung table (reproduced in Task 1).

### Database safety — absolute

1. **No test may write to a real catalog row** — not by id, not by name.
2. **No `DELETE FROM` a catalog table, no `TRUNCATE`, no `DROP`, ever, in a test or scratch
   script.**
3. **Test fixtures are `zz`-prefixed and deleted by name, unconditionally, in a `finally`.**
4. `make seed-catalogs` must never cost an admin something they authored by hand.
5. The dev database is **shared**. Assume another session may be using it concurrently.

### No schema changes

This plan touches zero migrations. `creature_behaviors`, `creature_abilities`,
`behavior_drops`, and all 9 rung profiles already exist and are fully wired (P2a/P2b, both
Done). If any task discovers a genuine schema gap, STOP and report it — do not add a migration
without confirming it's actually needed.

### Conventions

- Commits: `type(scope): summary (SOMET-250)`, ending with the `Co-Authored-By: Claude Opus 5
  <noreply@anthropic.com>` trailer.
- Backend tests: `npm test` from `backend/`.
- Scope test runs to what you changed; the full suite runs once at the end of the final task.
- Live-balance changes (Task 5) are disclosed in commit messages and code comments — never
  silent.

### Human review gate

**Task 7 (seeding against the dev database) does not run automatically after Task 6.** The
generated content (Tasks 1-6's output, especially the 288 new creatures' names/colors/prompts
and the 4 legacy remappings) needs a human read-through first, per the spec's explicit review
workflow. Task 6 ends with the generated file committed and ready to read as a diff. Task 7 is a
separate dispatch, only after the human confirms the content reads right.

---

## File Structure

**Created:**
- `backend/scripts/bestiary/template.js` — the umbrella's line table (32 rows) and rung table (9 rows) as structured data, plus their type shapes.
- `backend/scripts/bestiary/derive.js` — pure functions: `deriveResistances(rung, element)`, `deriveLevelBand(tier, rungIndex)`.
- `backend/scripts/bestiary/dropMapping.js` — pure function `pickDropItem(line, rung)` against a snapshot of the current `item_types` catalog.
- `backend/scripts/gen-p4-bestiary.js` — the generator: combines the three modules above into 288 creature rows + drop rows, writes `backend/seeds/data/bestiaryP4.js`.
- `backend/seeds/data/bestiaryP4.js` — **generated output**, committed. Same shape as `entityTypes.js`: exports `BESTIARY_P4_CREATURES` and `BESTIARY_P4_DROPS`.
- Test files named per task (see below).

**Modified:**
- `backend/seeds/data/entityTypes.js` — Wolf/Slime/Skeleton/Bat retuned in place (Task 5).
- `backend/scripts/seed-catalogs.js` — import and seed `bestiaryP4.js`'s two exports alongside the existing `HOSTILE_CREATURES`/`CREATURE_DROPS` (Task 6).
- `backend/tests/creature_drops_db.test.js` and any sibling catalog-wide invariant test — expect 292 creature types instead of 5 (Task 6).

---

## Task 1: The line and rung template data

**Files:**
- Create: `backend/scripts/bestiary/template.js`
- Test: `backend/tests/bestiary_template.test.js`

**Interfaces:**
- Produces: `LINES` (array of 32 `{ name, biome, element, tier }`, `element` is `null` for lines with no primary element), `RUNGS` (array of 9 `{ name, hp, defense, index }` in umbrella order: Swarm, Skirmisher, Line, Ranged, Caster, Brute, Heavy, Champion, Apex — `index` is the rung's position 0-8, used by Task 2 for level-band scaling), `TIER_BANDS` (`{ I: [1,12], II: [8,24], III: [20,36], IV: [32,50] }`).

- [ ] **Step 1: Write the failing shape tests**

```js
const test = require('node:test');
const assert = require('node:assert');
const { LINES, RUNGS, TIER_BANDS } = require('../scripts/bestiary/template');

test('LINES has exactly 32 entries, all unique names', () => {
  assert.strictEqual(LINES.length, 32);
  assert.strictEqual(new Set(LINES.map((l) => l.name)).size, 32);
});

test('every line has a valid tier token', () => {
  const validTiers = new Set(['I', 'II', 'III', 'IV', 'I-II', 'II-III', 'III-IV']);
  for (const l of LINES) {
    assert.ok(validTiers.has(l.tier), `${l.name} has invalid tier "${l.tier}"`);
  }
});

test('every line element is one of the four game elements, or null', () => {
  const valid = new Set(['physical', 'fire', 'ice', 'lightning', null]);
  for (const l of LINES) {
    assert.ok(valid.has(l.element), `${l.name} has invalid element "${l.element}"`);
  }
});

test('RUNGS has exactly 9 entries in umbrella order with sequential index', () => {
  assert.deepEqual(RUNGS.map((r) => r.name),
    ['Swarm', 'Skirmisher', 'Line', 'Ranged', 'Caster', 'Brute', 'Heavy', 'Champion', 'Apex']);
  assert.deepEqual(RUNGS.map((r) => r.index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('RUNGS hp/defense match the umbrella table exactly', () => {
  const byName = Object.fromEntries(RUNGS.map((r) => [r.name, r]));
  assert.deepEqual(
    [byName.Swarm.hp, byName.Swarm.defense], [8, 0]);
  assert.deepEqual(
    [byName.Apex.hp, byName.Apex.defense], [130, 13]);
  assert.deepEqual(
    [byName.Champion.hp, byName.Champion.defense], [85, 9]);
});

test('TIER_BANDS covers all four tiers with the umbrella ranges', () => {
  assert.deepEqual(TIER_BANDS, { I: [1, 12], II: [8, 24], III: [20, 36], IV: [32, 50] });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && node --test tests/bestiary_template.test.js`
Expected: FAIL — `template.js` doesn't exist.

- [ ] **Step 3: Write the template data**

Transcribe `docs/superpowers/specs/2026-08-06-bestiary-program-design.md`'s two tables
verbatim — "The 32 lines" (three sub-tables: Surface 10, Underground 14, Abyssal 8) and the
9-rung table. Use `null` for a line's element when the umbrella lists `—`. Example shape (first
few rows shown, transcribe all 32 lines and all 9 rungs from the umbrella doc):

```js
// backend/scripts/bestiary/template.js
//
// Transcribed verbatim from docs/superpowers/specs/2026-08-06-bestiary-program-design.md
// ("The 32 lines" and the rung table). Do not hand-edit a value here without also updating
// the umbrella doc — this file exists so nothing drifts from it silently.

const RUNGS = [
  { name: 'Swarm', hp: 8, defense: 0, index: 0 },
  { name: 'Skirmisher', hp: 16, defense: 1, index: 1 },
  { name: 'Line', hp: 30, defense: 3, index: 2 },
  { name: 'Ranged', hp: 22, defense: 1, index: 3 },
  { name: 'Caster', hp: 26, defense: 1, index: 4 },
  { name: 'Brute', hp: 48, defense: 5, index: 5 },
  { name: 'Heavy', hp: 60, defense: 8, index: 6 },
  { name: 'Champion', hp: 85, defense: 9, index: 7 },
  { name: 'Apex', hp: 130, defense: 13, index: 8 },
];

const TIER_BANDS = { I: [1, 12], II: [8, 24], III: [20, 36], IV: [32, 50] };

const LINES = [
  // Surface — 10 lines
  { name: 'Beast', biome: 'Meadow', element: null, tier: 'I' },
  { name: 'Woodland', biome: 'Deep Forest', element: null, tier: 'I' },
  { name: 'Desert', biome: 'Arid Dunes', element: 'fire', tier: 'I' },
  { name: 'Tundra', biome: 'Frozen Waste', element: 'ice', tier: 'I-II' },
  { name: 'Swamp', biome: 'Mire', element: 'physical', tier: 'I-II' },
  { name: 'Highland', biome: 'Highlands', element: 'physical', tier: 'II' },
  { name: 'Jungle', biome: 'Verdant Jungle', element: 'lightning', tier: 'II' },
  { name: 'Storm', biome: 'Storm Coast', element: 'lightning', tier: 'II-III' },
  { name: 'Ruin', biome: 'Sunken Ruins', element: 'ice', tier: 'II-III' },
  { name: 'Volcanic', biome: 'Ashfields', element: 'fire', tier: 'II-III' },
  // Underground — 14 lines
  { name: 'Undead', biome: 'Catacombs', element: 'ice', tier: 'I-II' },
  { name: 'Bonelord', biome: 'Ossuary', element: 'ice', tier: 'II-III' },
  { name: 'Cave', biome: 'Cavern', element: 'physical', tier: 'I-II' },
  { name: 'Fungal', biome: 'Fungal Deep', element: 'lightning', tier: 'II' },
  { name: 'Ember', biome: 'Emberdepths', element: 'fire', tier: 'II-III' },
  { name: 'Rime', biome: 'Frostvault', element: 'ice', tier: 'II-III' },
  { name: 'Construct', biome: 'Deepvault', element: 'physical', tier: 'III' },
  { name: 'Hive', biome: 'Hive Warrens', element: 'physical', tier: 'II-III' },
  { name: 'Drowned', biome: 'Sunken Cistern', element: 'ice', tier: 'II-III' },
  { name: 'Umbral', biome: 'Umbral Warren', element: 'physical', tier: 'III-IV' },
  { name: 'Crystal', biome: 'Crystal Hollows', element: 'lightning', tier: 'III' },
  { name: 'Blight', biome: 'Blightworks', element: 'physical', tier: 'II-III' },
  { name: 'Gloom', biome: 'Gloomfen', element: 'ice', tier: 'II' },
  { name: 'Stoneborn', biome: 'Sunken Foundry', element: 'fire', tier: 'III' },
  // Abyssal — 8 lines
  { name: 'Void', biome: 'Abyssal Rift', element: 'physical', tier: 'IV' }, // "all four, partial" — see Task 2
  { name: 'Demonic', biome: 'Infernal Gate', element: 'fire', tier: 'III-IV' },
  { name: 'Chaos', biome: 'Shattered Vault', element: 'lightning', tier: 'IV' },
  { name: 'Fallen', biome: 'Fallen Sanctum', element: 'ice', tier: 'IV' },
  { name: 'Nightmare', biome: 'Dreaming Dark', element: 'physical', tier: 'IV' },
  { name: 'Titan', biome: 'Grave of Titans', element: 'physical', tier: 'IV' },
  { name: 'Plague', biome: 'Pestilent Deep', element: 'fire', tier: 'III-IV' },
  { name: 'Eldritch', biome: 'The Maw', element: 'physical', tier: 'IV' }, // "all four, partial" — see Task 2
];

module.exports = { LINES, RUNGS, TIER_BANDS };
```

Note the two `// "all four, partial"` comments on Void and Eldritch — the umbrella describes
these two lines as resisting all four elements partially rather than one primary element
strongly. `element: 'physical'` here is a placeholder *for this table's shape only* (every line
needs exactly one primary-element slot to satisfy the shape test); Task 2's
`deriveResistances` special-cases these two names to apply the "all four, partial" rule instead
of the normal primary-element rule. This is not a deferred decision — it's resolved concretely
in Task 2, flagged here so the two special-cased names are visible where they're introduced.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/bestiary_template.test.js`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/bestiary/template.js backend/tests/bestiary_template.test.js
git commit -m "feat(bestiary): add the P4 line and rung template data (SOMET-250)"
```

---

## Task 2: Resistance and level-band derivation

**Files:**
- Create: `backend/scripts/bestiary/derive.js`
- Test: `backend/tests/bestiary_derive.test.js`

**Interfaces:**
- Consumes: `RUNGS`, `TIER_BANDS` from Task 1's `template.js`.
- Produces: `deriveResistances(rungName, element)` → `{ [element]: number, ... }`. `deriveLevelBand(tier, rungIndex)` → `{ min, max }` (a two-level band, not the tier's whole range — see Step 3).

- [ ] **Step 1: Write the failing tests**

```js
const test = require('node:test');
const assert = require('node:assert');
const { deriveResistances, deriveLevelBand } = require('../scripts/bestiary/derive');

test('Swarm and Skirmisher get no resistance or one weak one', () => {
  const r = deriveResistances('Swarm', 'fire');
  assert.deepEqual(r, {});
  const r2 = deriveResistances('Skirmisher', 'fire');
  assert.deepEqual(r2, { fire: 0.2 });
});

test('Line/Ranged/Caster get the primary element at .4-.7', () => {
  const r = deriveResistances('Line', 'ice');
  assert.strictEqual(r.ice, 0.55);
  assert.strictEqual(Object.keys(r).length, 1);
});

test('Brute/Heavy/Champion/Apex get the primary element strong plus partial physical', () => {
  const r = deriveResistances('Apex', 'lightning');
  assert.deepEqual(r, { lightning: 0.8, physical: 0.3 });
});

test('a null-element line (Beast, Woodland) gets no resistance at any rung', () => {
  assert.deepEqual(deriveResistances('Line', null), {});
  assert.deepEqual(deriveResistances('Apex', null), {});
});

test('Void and Eldritch resist all four elements, partially, at every rung', () => {
  const r = deriveResistances('Line', 'physical', { allFourPartial: true });
  assert.deepEqual(r, { physical: 0.3, fire: 0.3, ice: 0.3, lightning: 0.3 });
  const r2 = deriveResistances('Apex', 'physical', { allFourPartial: true });
  assert.deepEqual(r2, { physical: 0.5, fire: 0.5, ice: 0.5, lightning: 0.5 });
});

test('deriveLevelBand scales within a tier by rung index, Swarm near floor Apex near ceiling', () => {
  const swarmBand = deriveLevelBand('I', 0); // Swarm, tier I (1-12)
  const apexBand = deriveLevelBand('I', 8);  // Apex, tier I (1-12)
  assert.ok(swarmBand.min < apexBand.min, 'Apex should sit higher in the band than Swarm');
  assert.ok(swarmBand.min >= 1 && apexBand.max <= 12, 'band must stay inside the tier range');
});

test('deriveLevelBand handles a two-tier span like "I-II" by using the wider combined range', () => {
  const band = deriveLevelBand('I-II', 8); // Apex at a I-II line: tier I (1-12) + tier II (8-24) combined = 1-24
  assert.ok(band.max <= 24);
  assert.ok(band.min >= 1);
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd backend && node --test tests/bestiary_derive.test.js`
Expected: FAIL — `derive.js` doesn't exist.

- [ ] **Step 3: Implement**

```js
// backend/scripts/bestiary/derive.js
const { TIER_BANDS } = require('./template');

// Rung tiers per the umbrella's resistance rule. Index into this by rung name.
const RESISTANCE_TIER = {
  Swarm: 'none', Skirmisher: 'weak',
  Line: 'primary', Ranged: 'primary', Caster: 'primary',
  Brute: 'strong', Heavy: 'strong', Champion: 'strong', Apex: 'strong',
};

// Primary-tier resistance value scales from .4 (Line) to .7 (Caster) across the three
// primary-tier rungs, matching the umbrella's ".4-.7" range without picking one flat number.
const PRIMARY_VALUE = { Line: 0.4, Ranged: 0.55, Caster: 0.7 };
const STRONG_VALUE = { Brute: 0.6, Heavy: 0.65, Champion: 0.7, Apex: 0.8 };
const STRONG_PHYSICAL_PARTIAL = { Brute: 0.2, Heavy: 0.25, Champion: 0.3, Apex: 0.3 };

function deriveResistances(rungName, element, opts = {}) {
  if (opts.allFourPartial) {
    // Void/Eldritch: all four elements, partial, scaling the same way a single primary
    // element would (weak at low rungs, up to .5 at Apex — half of a normal Apex's .8, since
    // the "budget" is spread across four elements instead of one).
    const tier = RESISTANCE_TIER[rungName];
    const value = tier === 'none' ? 0 : tier === 'weak' ? 0.15
      : tier === 'primary' ? 0.25 : { Brute: 0.35, Heavy: 0.4, Champion: 0.45, Apex: 0.5 }[rungName];
    if (value === 0) return {};
    return { physical: value, fire: value, ice: value, lightning: value };
  }
  if (element == null) return {};
  const tier = RESISTANCE_TIER[rungName];
  if (tier === 'none') return {};
  if (tier === 'weak') return { [element]: 0.2 };
  if (tier === 'primary') return { [element]: PRIMARY_VALUE[rungName] };
  // strong
  return { [element]: STRONG_VALUE[rungName], physical: STRONG_PHYSICAL_PARTIAL[rungName] };
}

function deriveLevelBand(tierToken, rungIndex) {
  // A tier token is either a single tier ("I") or a span ("I-II"). Combine the referenced
  // tiers' ranges into one [min, max], then place this rung within it — Swarm (index 0) near
  // the floor, Apex (index 8) near the ceiling, linear across the 9 rungs.
  const tiers = tierToken.split('-');
  const ranges = tiers.map((t) => TIER_BANDS[t]);
  const min = Math.min(...ranges.map((r) => r[0]));
  const max = Math.max(...ranges.map((r) => r[1]));
  const span = max - min;
  const bandFloor = Math.round(min + (span * rungIndex) / 8);
  const bandCeil = Math.min(max, bandFloor + Math.max(1, Math.round(span / 9)));
  return { min: bandFloor, max: bandCeil };
}

module.exports = { deriveResistances, deriveLevelBand };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/bestiary_derive.test.js`
Expected: PASS, all 7 tests. If the exact literal values in a test don't match your reading of
the umbrella's ranges, adjust the implementation's constants (not the test) to match the
umbrella doc, and note the specific values you chose in your task report — the umbrella gives
ranges (".4-.7", "strong") not single numbers, so the exact split is a documented judgment call,
not a fixed spec value.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/bestiary/derive.js backend/tests/bestiary_derive.test.js
git commit -m "feat(bestiary): derive per-rung resistances and level bands (SOMET-250)"
```

---

## Task 3: Drop-item mapping

**Files:**
- Create: `backend/scripts/bestiary/dropMapping.js`
- Test: `backend/tests/bestiary_drop_mapping.test.js`

**Interfaces:**
- Produces: `pickDropItem(lineElement, tierToken)` → `{ item: string, chance: number, min_qty: number, max_qty: number }`.

- [ ] **Step 1: Write the failing tests**

```js
const test = require('node:test');
const assert = require('node:assert');
const { pickDropItem } = require('../scripts/bestiary/dropMapping');

test('a tier-I line with no element picks a low-damage neutral melee item', () => {
  const d = pickDropItem(null, 'I');
  assert.ok(['knife', 'stick', 'dagger'].includes(d.item), `unexpected item: ${d.item}`);
});

test('a fire-element line picks the flame staff when the tier supports it', () => {
  const d = pickDropItem('fire', 'III');
  assert.strictEqual(d.item, 'flame staff');
});

test('an ice-element line picks the frost staff', () => {
  const d = pickDropItem('ice', 'II-III');
  assert.strictEqual(d.item, 'frost staff');
});

test('a lightning-element line picks the storm staff', () => {
  const d = pickDropItem('lightning', 'III');
  assert.strictEqual(d.item, 'storm staff');
});

test('a tier-IV line picks a high-damage item regardless of element', () => {
  const d = pickDropItem('physical', 'IV');
  assert.ok(['two-handed sword', 'scythe', 'pike', 'archmage staff'].includes(d.item));
});

test('every returned drop rule has a valid chance and quantity range', () => {
  const d = pickDropItem('physical', 'II');
  assert.ok(d.chance > 0 && d.chance <= 1);
  assert.ok(d.min_qty >= 1 && d.max_qty >= d.min_qty);
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd backend && node --test tests/bestiary_drop_mapping.test.js`
Expected: FAIL — `dropMapping.js` doesn't exist.

- [ ] **Step 3: Implement**

Snapshot of the live `item_types` catalog as of this plan (verified against the dev database
2026-08-08 — if seeding later shows a name here no longer exists, that's a real drift to report,
not to silently work around):

```js
// backend/scripts/bestiary/dropMapping.js
//
// Snapshot of item_types (backend/seeds/data — melee/projectile weapons), damage as a tier
// proxy since the catalog has no explicit tier column. Verified against the live dev database
// 2026-08-08. If a name here no longer exists in item_types when this runs against a real
// database, that's real catalog drift — report it, don't silently substitute.
const MELEE_BY_DAMAGE = [
  { item: 'stick', damage: 7 }, { item: 'knife', damage: 6 }, { item: 'dagger', damage: 8 },
  { item: 'club', damage: 10 }, { item: 'short sword', damage: 11 }, { item: 'mid club', damage: 14 },
  { item: 'long sword', damage: 15 }, { item: 'morning star', damage: 17 }, { item: 'pike', damage: 19 },
  { item: 'scythe', damage: 20 }, { item: 'two-handed sword', damage: 22 }, { item: 'halberd', damage: 18 },
].sort((a, b) => a.damage - b.damage);

const ELEMENT_STAFF = { fire: 'flame staff', ice: 'frost staff', lightning: 'storm staff' };
// Arcane items (apprentice staff, archmage staff, magic-bolt) exist in the catalog but have no
// matching line element in the umbrella's four-element system — they're not used by this
// mapping. A physical-element (or no-element) line never needs "arcane": pickDropItem only
// looks up ELEMENT_STAFF for fire/ice/lightning.

const TIER_ORDER = { I: 0, II: 1, III: 2, IV: 3 };

function tierIndex(tierToken) {
  // A span like "II-III" uses its HIGHER tier for drop-power purposes — a line that reaches
  // into a deeper tier should be able to drop that tier's gear at its higher rungs.
  const tiers = tierToken.split('-');
  return Math.max(...tiers.map((t) => TIER_ORDER[t]));
}

function pickDropItem(element, tierToken) {
  const idx = tierIndex(tierToken); // 0-3
  if (element && ELEMENT_STAFF[element]) {
    // Element-themed lines always drop their matching staff — a fire-line creature drops a
    // flame staff regardless of tier, since the theme match matters more than power scaling
    // for a per-type flavour drop (the rung-level gold/loot fallback from P2b already covers
    // power scaling).
    return { item: ELEMENT_STAFF[element], chance: 0.2, min_qty: 1, max_qty: 1 };
  }
  // physical or null element: pick a melee weapon whose damage bucket matches the tier.
  const bucketSize = Math.ceil(MELEE_BY_DAMAGE.length / 4);
  const bucket = MELEE_BY_DAMAGE.slice(idx * bucketSize, (idx + 1) * bucketSize);
  const pick = bucket[0] || MELEE_BY_DAMAGE[MELEE_BY_DAMAGE.length - 1];
  return { item: pick.item, chance: 0.2, min_qty: 1, max_qty: 1 };
}

module.exports = { pickDropItem };
```

Note: `pickDropItem(null, 'I')`'s bucket-0 (`stick`, `knife`, `dagger`, `club`) satisfies Step
1's test. `pickDropItem('physical', 'IV')`'s bucket-3 by this bucketing scheme lands on
`{two-handed sword, halberd, ...}` depending on exact bucket math — run the test and adjust
`bucketSize`/slicing if the literal bucket contents don't match Step 1's expected set; the test
is the source of truth for "high-damage", the bucketing arithmetic is just one way to get there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/bestiary_drop_mapping.test.js`
Expected: PASS, all 6 tests. Fix the bucketing constants (not the tests) if a bucket boundary
lands wrong.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/bestiary/dropMapping.js backend/tests/bestiary_drop_mapping.test.js
git commit -m "feat(bestiary): map lines/tiers to drop items from the existing catalog (SOMET-250)"
```

---

## Task 4: The generator

**Files:**
- Create: `backend/scripts/gen-p4-bestiary.js`
- Test: `backend/tests/gen_p4_bestiary.test.js`

**Interfaces:**
- Consumes: `LINES`, `RUNGS` (Task 1); `deriveResistances`, `deriveLevelBand` (Task 2); `pickDropItem` (Task 3).
- Produces: a `generateBestiary()` function returning `{ creatures: [...], drops: [...] }`, and a CLI entry point that writes `backend/seeds/data/bestiaryP4.js`.

- [ ] **Step 1: Write the failing tests**

```js
const test = require('node:test');
const assert = require('node:assert');
const { generateBestiary } = require('../scripts/gen-p4-bestiary');

test('generates exactly 288 creatures, all unique names', () => {
  const { creatures } = generateBestiary();
  assert.strictEqual(creatures.length, 288);
  assert.strictEqual(new Set(creatures.map((c) => c.name)).size, 288);
});

test('every creature has all required fields with valid types', () => {
  const { creatures } = generateBestiary();
  for (const c of creatures) {
    assert.strictEqual(typeof c.name, 'string');
    assert.strictEqual(typeof c.color, 'string');
    assert.ok(/^#[0-9a-f]{6}$/i.test(c.color), `${c.name} has invalid color ${c.color}`);
    assert.strictEqual(typeof c.hp, 'number');
    assert.strictEqual(c.max_hp, c.hp);
    assert.strictEqual(typeof c.defense, 'number');
    assert.strictEqual(typeof c.resistances, 'object');
    assert.strictEqual(typeof c.prompt, 'string');
    assert.ok(c.prompt.length > 0);
    assert.strictEqual(typeof c.behavior_name, 'string'); // resolved to behavior_id at seed time, see Task 6
    assert.strictEqual(typeof c.level_min, 'number');
    assert.strictEqual(typeof c.level_max, 'number');
    assert.ok(c.level_min <= c.level_max);
  }
});

test('every creature\'s behavior_name is one of the 9 real rung profiles', () => {
  const { creatures } = generateBestiary();
  const valid = new Set(['Swarm', 'Skirmisher', 'Line', 'Ranged', 'Caster', 'Brute', 'Heavy', 'Champion', 'Apex']);
  for (const c of creatures) {
    assert.ok(valid.has(c.behavior_name), `${c.name} has invalid behavior_name ${c.behavior_name}`);
  }
});

test('generates exactly one drop row per creature, each pointing at the matching creature name', () => {
  const { creatures, drops } = generateBestiary();
  assert.strictEqual(drops.length, 288);
  const creatureNames = new Set(creatures.map((c) => c.name));
  for (const d of drops) {
    assert.ok(creatureNames.has(d.creature), `drop row references unknown creature ${d.creature}`);
  }
});

test('a Void-line creature resists all four elements partially (the allFourPartial special case)', () => {
  const { creatures } = generateBestiary();
  const voidApex = creatures.find((c) => c.name.startsWith('Void') && c.behavior_name === 'Apex');
  assert.ok(voidApex, 'expected a generated Void Apex creature');
  assert.deepEqual(Object.keys(voidApex.resistances).sort(), ['fire', 'ice', 'lightning', 'physical']);
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd backend && node --test tests/gen_p4_bestiary.test.js`
Expected: FAIL — `gen-p4-bestiary.js` doesn't exist.

- [ ] **Step 3: Implement**

```js
// backend/scripts/gen-p4-bestiary.js
const fs = require('fs');
const path = require('path');
const { LINES, RUNGS } = require('./bestiary/template');
const { deriveResistances, deriveLevelBand } = require('./bestiary/derive');
const { pickDropItem } = require('./bestiary/dropMapping');

// Deterministic color per line, shade per rung — every creature in a line shares a hue family,
// darker/more saturated at higher rungs (bigger, tougher). Placeholder-quality; the spec's own
// review pass (Task 6's commit, before Task 7 seeds it) is where colors get hand-polished.
function colorFor(lineIndex, rungIndex) {
  const hue = Math.round((lineIndex / 32) * 360);
  const lightness = 55 - rungIndex * 3; // higher rung = darker
  return hslToHex(hue, 55, Math.max(20, lightness));
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function promptFor(line, rung) {
  const sizeWord = ['tiny', 'small', 'lean', 'armed', 'skilled', 'hulking', 'armoured', 'commanding', 'towering'][rung.index];
  const elementWord = line.element ? `${line.element}-touched ` : '';
  return `a ${sizeWord} ${elementWord}${line.name.toLowerCase()} creature`;
}

function generateBestiary() {
  const creatures = [];
  const drops = [];
  LINES.forEach((line, lineIndex) => {
    RUNGS.forEach((rung) => {
      const allFourPartial = line.name === 'Void' || line.name === 'Eldritch';
      const resistances = deriveResistances(rung.name, line.element, { allFourPartial });
      const band = deriveLevelBand(line.tier, rung.index);
      const name = `${line.name} ${rung.name}`;
      creatures.push({
        name,
        color: colorFor(lineIndex, rung.index),
        walkable: true,
        spawn_tiles: [],
        chance: 0.1,
        hp: rung.hp,
        max_hp: rung.hp,
        defense: rung.defense,
        resistances,
        prompt: promptFor(line, rung),
        level_min: band.min,
        level_max: band.max,
        behavior_name: rung.name, // resolved to a real behavior_id at seed time (Task 6)
      });
      const drop = pickDropItem(line.element, line.tier);
      drops.push({ creature: name, item: drop.item, chance: drop.chance, min_qty: drop.min_qty, max_qty: drop.max_qty });
    });
  });
  return { creatures, drops };
}

function writeOutput() {
  const { creatures, drops } = generateBestiary();
  const out = `// GENERATED by backend/scripts/gen-p4-bestiary.js — do not hand-edit generated
// fields (color/prompt may be hand-polished after generation; everything else should be
// regenerated by re-running the script if the template/derive/dropMapping rules change).
// See docs/superpowers/specs/2026-08-08-p4-bestiary-design.md.
const BESTIARY_P4_CREATURES = ${JSON.stringify(creatures, null, 2)};

const BESTIARY_P4_DROPS = ${JSON.stringify(drops, null, 2)};

module.exports = { BESTIARY_P4_CREATURES, BESTIARY_P4_DROPS };
`;
  fs.writeFileSync(path.join(__dirname, '../seeds/data/bestiaryP4.js'), out);
  console.log(`Wrote ${creatures.length} creatures, ${drops.length} drops.`);
}

module.exports = { generateBestiary };
if (require.main === module) writeOutput();
```

- [ ] **Step 4: Run tests, then run the generator**

Run: `cd backend && node --test tests/gen_p4_bestiary.test.js`
Expected: PASS, all 5 tests.

Then run: `cd backend && node scripts/gen-p4-bestiary.js`
Expected: `Wrote 288 creatures, 288 drops.` and a new `backend/seeds/data/bestiaryP4.js` file.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/gen-p4-bestiary.js backend/tests/gen_p4_bestiary.test.js backend/seeds/data/bestiaryP4.js
git commit -m "feat(bestiary): generate the 288-creature P4 bestiary (SOMET-250)"
```

---

## Task 5: Legacy creature remapping

**Files:**
- Modify: `backend/seeds/data/entityTypes.js`
- Test: `backend/tests/entity_types_seed.test.js` (extend if it exists, else create)

**Interfaces:**
- Consumes: nothing from earlier tasks — this edits existing, hand-authored data, not generated output.

This is a **live-balance change**, disclosed per the spec — do not treat it as a mechanical
edit. Read the existing comment block at the top of `entityTypes.js` (the Wolf-recovery
history) before editing; match its documentation density for these four changes.

- [ ] **Step 1: Write the failing tests**

```js
const test = require('node:test');
const assert = require('node:assert');
const { HOSTILE_CREATURES } = require('../seeds/data/entityTypes');

test('Wolf is retuned to the Beast/Meadow Line-rung template (hp 30, def 3, no resistance)', () => {
  const wolf = HOSTILE_CREATURES.find((c) => c.name === 'Wolf');
  assert.deepEqual([wolf.hp, wolf.max_hp, wolf.defense], [30, 30, 3]);
  assert.deepEqual(wolf.resistances, {});
});

test('Skeleton is retuned to the Undead/Catacombs Line-rung template (hp 30, def 3, ice .4)', () => {
  const skeleton = HOSTILE_CREATURES.find((c) => c.name === 'Skeleton');
  assert.deepEqual([skeleton.hp, skeleton.max_hp, skeleton.defense], [30, 30, 3]);
  assert.deepEqual(skeleton.resistances, { ice: 0.4 });
});

test('Bat is retuned to the Fungal/Fungal Deep Line-rung template (hp 30, def 3, lightning .4)', () => {
  const bat = HOSTILE_CREATURES.find((c) => c.name === 'Bat');
  assert.deepEqual([bat.hp, bat.max_hp, bat.defense], [30, 30, 3]);
  assert.deepEqual(bat.resistances, { lightning: 0.4 });
});

test('Slime is retuned to the Desert/Arid Dunes Line-rung template (hp 30, def 3, fire .4)', () => {
  const slime = HOSTILE_CREATURES.find((c) => c.name === 'Slime');
  assert.deepEqual([slime.hp, slime.max_hp, slime.defense], [30, 30, 3]);
  assert.deepEqual(slime.resistances, { fire: 0.4 });
});

test('all four legacy creatures carry a behavior_name of Line (matching their new rung)', () => {
  for (const name of ['Wolf', 'Skeleton', 'Bat', 'Slime']) {
    const c = HOSTILE_CREATURES.find((x) => x.name === name);
    assert.strictEqual(c.behavior_name, 'Line');
  }
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd backend && node --test tests/entity_types_seed.test.js`
Expected: FAIL — current Wolf/Skeleton/Bat/Slime values don't match the new template (e.g. Wolf's current `hp: 12`, Skeleton's current `resistances: { ice: 0.6, physical: 0.2 }`).

- [ ] **Step 3: Edit `entityTypes.js`**

For each of the four entries in `HOSTILE_CREATURES`, update `hp`/`max_hp` to `30`, `defense` to
`3` (the Line rung's template values from Task 1), `resistances` to the single-element .4 value
from Task 2's `PRIMARY_VALUE.Line` (Wolf gets `{}` since Beast has no primary element), add a
`behavior_name: 'Line'` field, and update `prompt` to reflect the new line theme (e.g. Wolf: `'a
grey meadow wolf'`; Skeleton: keep close to its existing "undead skeleton warrior" framing since
it already fits Undead; Bat: incorporate the Fungal Deep theme; Slime: incorporate the Desert/
molten theme). Add a comment above each changed entry explaining the remapping, following the
file's existing documentation style:

```js
// Retuned 2026-08-08 for P4 (SOMET-250): folded into the Beast line (Meadow, no primary
// element) at the Line rung, per docs/superpowers/specs/2026-08-08-p4-bestiary-design.md.
// Wolf has zero live placements today, so this is a free change — no live balance impact.
{
  name: 'Wolf',
  color: '#c0392b',
  walkable: true,
  spawn_tiles: [],
  chance: 0.1,
  hp: 30,
  max_hp: 30,
  defense: 3,
  resistances: {},
  prompt: 'a grey meadow wolf',
  gold_min: 1,
  gold_max: 3,
  behavior_name: 'Line',
},
```

Apply the equivalent for Skeleton (Undead), Bat (Fungal), Slime (Desert) — each with its own
comment disclosing the live-placement count (25/12/4 respectively) and that this is an
intentional balance change, not a side effect.

Also update `CREATURE_DROPS` if any of the four creatures' existing drop item no longer fits
their new theme — use `pickDropItem` from Task 3 (`element` from the line they're now assigned
to, `tier` = `'I'` for all four) to pick a thematically-consistent replacement, or keep the
existing drop if it already fits (Wolf's existing dagger drop, for instance, has no strong
thematic tie either way and can stay).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/entity_types_seed.test.js`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/seeds/data/entityTypes.js backend/tests/entity_types_seed.test.js
git commit -m "feat(bestiary): fold Wolf/Skeleton/Bat/Slime into the P4 taxonomy (SOMET-250)

Live-balance change: Skeleton (25 live placements), Bat (12), Slime (4) are
retuned to their assigned line's Line-rung template. Wolf (0 placements) is
a free change. See docs/superpowers/specs/2026-08-08-p4-bestiary-design.md."
```

---

## Task 6: Wire into the seeder, fix catalog-wide invariants

**Files:**
- Modify: `backend/scripts/seed-catalogs.js`
- Modify: `backend/tests/creature_drops_db.test.js` and any sibling catalog-wide invariant test that assumes 5 creature types

**Interfaces:**
- Consumes: `BESTIARY_P4_CREATURES`, `BESTIARY_P4_DROPS` (Task 4's generated output); `HOSTILE_CREATURES`, `CREATURE_DROPS` (Task 5's retuned legacy data).

- [ ] **Step 1: Find every catalog-wide invariant that hardcodes or assumes the current 5-creature catalog**

Run: `cd backend && grep -rln "is_creature" tests/ | xargs grep -l "COUNT\|every\|all creature"`

Read each match. `creature_drops_db.test.js:44`'s invariant ("every hostile creature type has a
drop rule") is expected to still pass by construction once Task 5/6 land (every generated
creature gets a drop row) — no change needed there beyond the count going from ~5 to 292. Any
test asserting an exact count (e.g. `assert.strictEqual(rows.length, 5)`) needs updating to
`292`. Any test iterating "every creature type" generically needs no change — it'll just see
more rows.

- [ ] **Step 2: Update `seed-catalogs.js`**

Find where `HOSTILE_CREATURES`/`CREATURE_DROPS` are currently imported and looped over
(`seedOneCreatureType`-style function, or inline). Add an import of
`BESTIARY_P4_CREATURES`/`BESTIARY_P4_DROPS` from `../seeds/data/bestiaryP4`, and extend the
existing seeding loop to also process them — same function, same NOT-EXISTS-guarded upsert
pattern, just a longer list. Resolve `behavior_name` → `behavior_id` by querying
`creature_behaviors WHERE name = $1` before the upsert (the generated data carries the rung
*name*, not its id, since the id isn't stable/known at generation time).

- [ ] **Step 3: Update any count-hardcoded catalog-wide invariant test found in Step 1**

Change the specific literal count assertions to `292` (or `>= 292` if the test's intent is "at
least this many," matching whatever the existing test's actual assertion style is — read it
before changing it).

- [ ] **Step 4: Run the full backend suite**

Run: `cd backend && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm test -- --test-timeout=20000`
Expected: green. This does NOT seed the new creatures into the dev database yet (that's Task
7) — these tests exercise the seeding *function* against fresh/scratch state or assert on the
static data shape, not the live dev DB's current row count. If any test unexpectedly touches
the live dev DB's row count here, STOP and report — that would mean Task 7's gate is being
skipped.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/seed-catalogs.js backend/tests/creature_drops_db.test.js
git commit -m "feat(bestiary): wire the P4 bestiary into seed-catalogs, update catalog invariants (SOMET-250)"
```

---

## Task 7: Seed and verify (human review gate — do not dispatch automatically after Task 6)

**Only start this task after a human has read the generated content** — `backend/seeds/data/bestiaryP4.js` and the Task 5 diff to `entityTypes.js` — as a diff and confirmed it reads right (names, colors, prompts, the four legacy remappings). This is not a formality; it's the review pass the spec's whole design exists to require.

**Files:**
- None created/modified — this task seeds and verifies only.

- [ ] **Step 1: Seed against the dev database**

Run: `cd backend && DATABASE_URL="postgres://user:password@localhost:15432/game_db" node scripts/seed-catalogs.js`
Expected: reports 292 (or close to it, accounting for the 4 retuned-not-inserted legacy rows) creature types processed, 0 errors.

- [ ] **Step 2: Verify idempotency**

Run the same command again immediately.
Expected: second run reports 0 new insertions (NOT-EXISTS guards catch everything), confirming
a re-run doesn't duplicate content or cost an admin a hand-authored edit.

- [ ] **Step 3: Spot-check via SQL**

```bash
docker compose --project-directory . --env-file .env -f compose/docker-compose.yml exec -T db psql -U user -d game_db -c "
SELECT count(*) FROM entity_types WHERE is_creature = true;
"
```
Expected: 292 (or 293 including Village Guard, which is structural and outside the 32-line
taxonomy — confirm the exact expected number against what Task 6 actually seeded).

- [ ] **Step 4: Full backend suite one more time, against the now-seeded dev DB**

Run: `cd backend && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm test -- --test-timeout=20000`
Expected: green, including `creature_drops_db.test.js`'s catalog-wide invariant now checked
against the real, fully-seeded 292-creature catalog.

- [ ] **Step 5: Report**

This is the final task — no commit (nothing new to commit; Tasks 1-6 already committed
everything). Report the final creature count, confirm idempotency held, and confirm the full
suite is green against the real seeded state.

---
