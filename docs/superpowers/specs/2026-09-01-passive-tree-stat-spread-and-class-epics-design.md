# Passive tree: stat spread, class epics, and the dead-rule repair

Date: 2026-09-01
Status: approved for planning
Supersedes nothing. Builds on `2026-08-23-progression-passive-tree-design.md` (SOMET-468 / C1).

## 1. Problem

Three defects in the shipped passive tree, found by reading the seed data and
the runtime that consumes it.

### 1.1 The six sectors are stat-locked

Every connective minor in `backend/seeds/data/passiveTree.js` grants
`stat: '@sector'`, which `backend/seeds/generatePassiveTree.js` (`grantsFor`)
substitutes with the sector's own stat. The consequence is absolute: the
constitution sector contains **zero** intelligence nodes, the strength sector
contains zero wisdom nodes, and so on.

Across ~1800 nodes the only cross-stat grants are `not_quickening` (+6 DEX,
available in every sector) and four keystones (`ks_wis_iron_body`,
`ks_str_bulwark`, `ks_con_*`, the three Druid `ks_cha_eternal_*`).

This is wrong because **skills and spells do not read the stat their class
sector is named after**. A Cultist casts with `spellMult`, which
`derivePlayerStats` derives from INTELLIGENCE; the Cultist sector is
constitution and offers no INT at all. A Monk's WIS buys only `manaRegen`.
A Druid's CHA buys only `priceMult` and charm budget. Picking a viable build
therefore means walking out of your own sector immediately, which is the
opposite of what a class-anchored tree is for.

### 1.2 Two rules in the vocabulary are inert

`RULE_KEYS` in the seed data declares four rules. `RULE_COMBINE` in
`backend/src/services/statComposition.js` mirrors them. Two of the four have
**no consumer anywhere in `backend/src/`**:

| rule | consumer | reality |
| --- | --- | --- |
| `lifeCostMultiplier` | `services/lifeCost.js` | LIVE |
| `treeCharmBonus` | `services/charm.js`, `authority/server.js` | LIVE |
| `cooldownFloor` | *claimed:* `services/playerStats.js` | **DEAD** — `derivePlayerStats` floors with the constant `C.MIN_COOLDOWN_MULT` and never reads the rule |
| `regenLifeShare` | *claimed:* `authority/world.js` mana-regen tick | **DEAD** — no reference outside `RULE_COMBINE` |

Both seed-data comments admit it in passing ("wiring is a follow-up"). The
consequences are player-visible:

- The **Archer start node** grants `cooldownFloor 0.38` and therefore grants
  nothing. The Archer begins the game with no class identity at all.
- The **Monk start node** grants `regenLifeShare 0.1` and therefore grants
  nothing. Same.
- `ks_dex_fleet` and `ks_wis_clarity` are inert keystones — two of the thirty
  nodes whose entire purpose is to be worth crossing the tree for.

This is the "green tests over a dead feature" shape this project has shipped
repeatedly. Adding nine more rules on top of a vocabulary where half the
entries are decorative would repeat it at scale, so the repair is a
prerequisite, not a follow-up.

### 1.3 There are no class-flavoured mechanical options

Everything the tree can grant today is a number on an existing scalar: a stat,
a pool, an element multiplier, a resistance, a status. Nothing changes *how*
a class fights. Meanwhile the weapon catalog already carries every knob such
options would need — `cooldown`, `reach`, `arc_width`, `range`,
`projectile_speed`, `projectile_radius`, `pierce` (`authority/items.js`) — and
nothing scales any of them per player.

## 2. Goals

1. Every sector offers a usable amount of every stat, with its own stat still
   clearly dominant.
2. Rare, deep nodes grant large single-stat jumps (+25 / +30).
3. Each class has epic options that change how it fights, with dedicated
   increaser nodes gated behind the epic they increase.
4. No rule enters the vocabulary without a live consumer, and a test makes
   that impossible to regress.

Non-goals: respec tokens, a fourth ring, per-class tree layouts, reworking
the stat→derived-number formulas in `progressionConstants.js`.

## 3. Grant vocabulary

All new mechanics enter as `rule` grants. `statComposition.js` already owns
the combine/identity fold, and `RULE_KEYS` already forces every rule to name
its consumer — both properties are exactly what this work needs.

### 3.1 The rule table after this epic

| rule | combine | identity | consumer |
| --- | --- | --- | --- |
| `lifeCostMultiplier` | product | 1 | `services/lifeCost.js` (unchanged) |
| `treeCharmBonus` | sum | 0 | `services/charm.js` (unchanged) |
| `cooldownFloor` | min | null | `services/playerStats.js` `derivePlayerStats` — **repaired** |
| `regenLifeShare` | sum | 0 | `authority/world.js` mana-regen tick — **repaired** |
| `attackSpeedMult` | product | 1 | `authority/world.js` `applyAttackCooldown`, melee branch |
| `castSpeedMult` | product | 1 | `authority/world.js` `applyAttackCooldown`, projectile branch |
| `meleeReachBonus` | sum | 0 | `authority/world.js` melee arc scan |
| `meleeArcBonus` | sum | 0 | `authority/world.js` melee arc scan |
| `projectileCount` | sum | 0 | `authority/world.js` projectile branch |
| `projectileSpeedMult` | product | 1 | `authority/projectiles.js` `spawn` |
| `pierceBonus` | sum | 0 | `authority/projectiles.js` `spawn` |
| `auraLeech` | sum | 0 | `authority/world.js` aura tick (new) |
| `auraRadius` | sum | 0 | `authority/world.js` aura tick (new) |

`RULE_COMBINE` (runtime) and `RULE_KEYS` (seed) must agree; `passive_rules.test.js`
already asserts this and the assertion extends to the new keys for free.

### 3.2 How rules reach the runtime

`derivePlayerStats` gains ONE new field on its bundle:

```js
rules: rulesOf(progression)   // the whole composeStats(...).rules object
```

carried through unchanged, defaulted to a frozen identity map when the
progression row has no tree context. This mirrors exactly how SOMET-495
carried `damageMult`, `resists` and `hitStatuses` — passthrough aggregates the
authority applies, not numbers this module derives.

`lifeCostMultiplier` keeps its existing named field. It is the one pre-495
rule with a named accessor and removing it would touch call sites this epic
has no business in; the duplication is deliberate and documented.

Nine named fields were considered and rejected: the passthrough object is one
seam, and `stats` is already the bundle every re-derive path refreshes (join,
level-up, chest XP, socket, allocate, respec), so an allocated rule is live
the instant `applyDerivedStats` runs and a respec that drops it takes effect
immediately.

### 3.3 The anti-inertness guard

A new test asserts that **every key in `RULE_COMBINE` is read somewhere under
`backend/src/` outside `statComposition.js` itself**. It reads source text,
the way the admin-styleguide source gate does.

This is the single highest-value test in the epic. It is precisely the test
that would have caught `cooldownFloor` and `regenLifeShare` sitting dead
through two shipped epics, and it costs about fifteen lines. A rule that
names a consumer in a comment but has none in code is a node the player
cannot tell apart from a working one.

## 4. Stat spread

### 4.1 The `@other` substitution

`grantsFor(template, sector)` today resolves one token. It gains a second:

- `@sector` — the sector's own stat (unchanged).
- `@other` — one of the other five stats, chosen **deterministically by node
  index**, round-robin through `STAT_KEYS` order with the sector's own stat
  skipped.

Determinism is load-bearing: the generator is contractually
`Math.random()`-free and byte-identical across runs, so a tree change stays a
reviewable diff. The round-robin also delivers the even distribution chosen
for this design — over a sector's ~295 nodes each of the other five stats
receives close to a fifth of the off-stat budget.

### 4.2 The 70/30 ratio, enforced not asserted in prose

Templates gain a `weight` field (default 1). `templatePool()` expands the pool
by weight before the generator's `pool[i % pool.length]` selection, so the
realized mix of own-stat and off-stat nodes is a property of the authored
weights rather than an accident of how many template objects happen to be in
the array.

A guard test counts realized `stat` grants per sector across the generated
tree and asserts own-stat lands at **70% ± 3%** of all stat-granting nodes.
Without that test the ratio is a comment, and the next balance pass silently
drifts it.

Ring-0 core nodes are excluded from the count — they have no sector and grant
no stats.

### 4.3 What this buys

Every sector becomes buildable from home. A Cultist who casts finds INT in
the constitution sector; a Monk who wants melee finds STR in the wisdom
sector. Sector identity survives because 70% is still overwhelming dominance
— walking a strength sector still makes you mostly stronger.

## 5. Greater notables and epic clusters

### 5.1 The `greater` kind

A fourth node kind beside `minor` / `notable` / `keystone`, placed on ring 3
only. `ringKinds()` gains a count for it, laid out with the same
spread-and-stagger the keystones use so the greaters do not stack on one
radial line.

A greater grants **+25 or +30 of a single stat**, own or off. This is the
"sometimes huger ones" ask, and ring 3 is where it belongs: a +30 INT for a
Cultist should be a genuine cross-map commitment, not a freebie two nodes
from the start.

The database `kind` column and the frontend node renderer both need the new
value; a kind the client does not know must render as *something*, never as
an invisible node.

### 5.2 Clusters: an epic plus its increasers

A cluster template declares a **hub** and either 2 or 4 **satellites**. The
generator places the hub at a ring-3 grid position and the satellites on its
immediate free neighbours, wiring edges **hub↔satellite only** — no satellite
connects to the rest of the graph.

That wiring is the whole point: `isAllocatable` walks the undirected
adjacency from the start node, so a satellite is unreachable until its hub is
allocated. An increaser cannot be taken without the epic it increases, by
construction rather than by a rule someone has to remember to write.

A test asserts, for every cluster satellite, that its adjacency list contains
exactly its own hub.

### 5.3 The authored clusters

| sector / class | hub | satellites |
| --- | --- | --- |
| strength / Warrior | **Cleaving Reach** — `meleeReachBonus` +32px (≈0.5 tile) | 2 × +16px |
| strength / Warrior | **Whirlwind** — `meleeArcBonus` to full circle | 4 × `attackSpeedMult` 1.10 |
| dexterity / Archer | **Volley** — `projectileCount` +1 | 2 × `projectileCount` +1 (→ +3 total) |
| dexterity / Archer | **Swiftshot** — `projectileSpeedMult` 1.25 | 4 × `projectileSpeedMult` 1.10 |
| intelligence / Mage | **Quickcast** — `castSpeedMult` 1.20 | 4 × `castSpeedMult` 1.08 |
| intelligence / Mage | **Spellpierce** — `pierceBonus` +2 | 2 × `pierceBonus` +1 |
| constitution / Cultist | **Sanguine Aura** — `auraLeech` +2 | 2 × `auraLeech` +1, 2 × `auraRadius` +40 |
| wisdom / Monk | **Clarity** — `regenLifeShare` +0.20 | 4 × `regenLifeShare` +0.05 |
| charisma / Druid | **Beast Bond** — `treeCharmBonus` +5 | 2 × `treeCharmBonus` +1 |

Reach and radius are authored in **pixels**, not metres, because that is the
unit `w.reach` and every world coordinate already use. A tile is 64px, so
"+0.5m" in the brief is +32px.

`ks_wis_clarity` and `ks_cha_beast_bond` already exist as keystones granting
these rules. The Monk and Druid clusters replace those keystones rather than
duplicating them, so a sector still has five keystones plus its clusters.

## 6. The aura

New subsystem, and the only part of this epic with real unknowns.

A player whose composed `rules.auraLeech` is above zero is on a per-second
aura tick in `authority/world.js`:

```
radius  = AURA_BASE_RADIUS + rules.auraRadius
counted = min(AURA_MAX_TARGETS, living hostile creatures within radius)
heal    = auraLeech * counted            // clamped to maxHp
```

Decisions:

- **It heals, it does not drain.** There is no life cost and no death risk.
  This makes the aura a sustain option rather than a sacrificial one, and it
  removes an entire class of edge cases (an aura that kills its owner while
  they are AFK, an aura that fights out-of-combat regeneration).
- **Always on.** No toggle, no new client input, no toggle state on the wire.
  Allocating the hub turns it on permanently.
- **`AURA_MAX_TARGETS` is mandatory, not a nicety.** A world can hold
  12-creature packs (`world.js`'s own comment). Uncapped, `auraLeech × 12`
  inside a pack is unkillable sustain, which is the balance failure this
  design is most exposed to. Six is the proposed cap and it is a tunable in
  `progressionConstants.js`, not a literal.
- The heal is applied through the same path other heals use, so it cannot
  exceed `maxHp` and it participates in whatever the death check already does.

The frame carries the player's aura radius (0 when they have none) so the
client can draw a ring. Radius travels resolved, for the same reason
`attackLift` does: the client must never need the passive catalog.

## 7. Combat wiring

Each of these is a single seam. They are listed with the exact site because
"there is one place this is read" is a property the codebase currently has and
must keep.

### 7.1 Attack and cast speed

`applyAttackCooldown` (`world.js`) is documented as the ONLY place the
weapon's `cooldown` field is read, and a test asserts the source contains
exactly one reference. It becomes:

```js
function applyAttackCooldown(p, w) {
  const r = p.stats.rules || {};
  const speed = w.kind === 'melee' ? r.attackSpeedMult : r.castSpeedMult;
  p._attackCd = w.cooldown * p.stats.cooldownMult / (speed > 0 ? speed : 1);
}
```

The branch on `w.kind` is what makes "attack speed" and "cast speed" two
different stats rather than one wearing two labels — a Warrior's attack-speed
cluster must not accelerate a socketed spell stone.

The result is floored by the same `cooldownFloor` rule §3.1 repairs, so no
stack of speed nodes can drive an attack interval to zero.

### 7.2 Melee reach and arc

The melee branch calls `this.creatures.meleeArcScan(cx, cy, nx, ny, w.reach,
w.arc_width, pacifiedFrom)` and separately `inArc(...)` for the player sweep,
and reports `reach` / `arc` on the attack descriptor for rendering. All four
must read the same adjusted pair, resolved ONCE per attack beside
`originLift` and `pacifiedFrom`:

```js
const reach = w.reach + (r.meleeReachBonus || 0);
const arc   = Math.min(TAU, w.arc_width + (r.meleeArcBonus || 0));
```

Resolving once is not a style preference: the descriptor's `reach`/`arc` are
what the client draws the swing with, and a client drawing the catalog's arc
while the server hit-tests a wider one is a swing that connects outside its
own animation.

**Balance risk, flagged.** A full-circle arc at extended reach hits everything
around the player and may be strictly better than any alternative melee
option. The Whirlwind cluster should be tuned or gated after live play, and
the ticket says so.

### 7.3 Projectile count, speed and pierce

The projectile branch spawns exactly one projectile (`this.projectiles.spawn`).
It becomes `1 + (rules.projectileCount || 0)` spawns, fanned symmetrically
about the aim vector by a fixed per-shot angle so three projectiles are
centre/left/right rather than three stacked on one line.

Resource cost and cooldown are paid ONCE for the volley, not per projectile —
`spendResources(p, w)` stays where it is, above the spawn.

`projectileSpeedMult` scales `weapon.projectile_speed` and `pierceBonus` adds
to `pierce`. Both are applied where `spawn` already reads them, and both must
respect the existing merged-state pierce clamp: a detonating projectile may
not also pierce, and `pierceBonus` must not reintroduce pierce on an AoE shot
that `spawn` deliberately clamped to zero.

## 8. Rollout

### 8.1 Free full respec

A plain `make seed-passive-tree` **preserves existing `grants`** — the upsert's
`CASE WHEN $10 ... ELSE passive_nodes.grants END` only writes grants under
`--force` or for start nodes. So this retune requires `--force`, which
rewrites labels, kinds and grants under nodes players have already allocated,
and prunes nodes the generator no longer produces.

A migration therefore refunds every allocated point:

- count `character_passives` rows per character,
- add that exact count to `player_progression.passive_points`,
- delete the rows.

Counted, never assumed. A refund derived from the character's level rather
than from the rows would be a second source of truth for the wallet, which is
the drift `passiveRules.js` explicitly refuses elsewhere.

### 8.2 Order

The migration must run BEFORE the forced reseed, so the prune cannot delete
`character_passives` rows the refund still needed to count.

### 8.3 Verification

Static tests cannot show that a rule reaches the player. Each combat slice is
verified in a real browser: allocate the node, observe the mechanic, respec,
observe it revert. Specifically — swing rate visibly changes, three
projectiles leave the bow, the melee arc visibly widens, life ticks up
standing in a pack.

## 9. Testing strategy

| test | what it prevents |
| --- | --- |
| rule-consumer source gate | a rule with no runtime reader (§3.3) |
| `RULE_COMBINE` ↔ `RULE_KEYS` agreement (exists) | the two tables drifting |
| own/off stat ratio per sector | the 70/30 spread silently drifting |
| cluster satellite adjacency | an increaser reachable without its epic |
| `greater` kind renders | an invisible node kind on the client |
| single-site cooldown read (exists) | a second `w.cooldown` reader |
| descriptor reach/arc equals hit-test reach/arc | a swing that connects outside its animation |
| volley pays cost once | a per-projectile resource drain |
| aura cap | unkillable sustain inside a pack |
| respec refund count | a wallet that drifts from the rows |
| browser verification per slice | every one of the above passing over a dead feature |

## 10. Slices

- **A — foundation.** Repair `cooldownFloor` and `regenLifeShare`; add the
  rule-consumer source gate; carry `rules` onto the derived bundle.
  *Prerequisite for everything.*
- **B — spread.** `@other` and weights in the generator with the 70/30 guard;
  author the rebalanced templates.
- **C — structure.** The `greater` kind and the +25/+30 nodes; cluster
  hub/satellite generation with the reachability test.
- **D — combat knobs.** Attack/cast speed; melee reach and arc; projectile
  count, speed and pierce.
- **E — aura.** Server tick, wire field and cap; client ring render.
- **F — rollout.** Respec migration and forced reseed; live browser pass.

D depends on A. E depends on A and on C (the aura's only source is the
Sanguine Aura cluster). F depends on all of B, C, D, E.
