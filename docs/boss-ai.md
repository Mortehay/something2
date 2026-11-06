# Boss AI

Diablo-style bosses for the Spire (and any post boss managed by `DungeonBossManager`).
Code: [backend/src/authority/bossAI.js](../backend/src/authority/bossAI.js).
Tests: `backend/tests/boss_ai.test.js`, `backend/tests/dungeon_boss_spire_fixes.test.js`.

## What it does and does not own

`CreatureSim.tick` already owns movement, targeting and the **telegraph -> wait -> resolve**
pipeline for skills (SOMET-608). The controller does not re-implement any of it. It decides
**what the boss does and when**, and the sim carries it out:

| Hook (creatures.js) | Controller call | Purpose |
|---|---|---|
| top of the per-creature loop | `bossAI.tick(c, {now})` | phase FSM; `true` = mid-transition, boss stays still |
| where a skill is chosen | `bossAI.pick(c, dist, now)` | attack selector; `null` = chase / auto-attack |
| `planSkill` / `_resolveSkill` | — | geometry for the new kinds (`charge`, `blink`, `rain`, multi-hit `nova`) |
| damage funnel (`damage.js`) | `_invulnerableUntil`, `_hpFloor` | invulnerability window; phase gate |

## State machine

```
 IDLE ──first pick──▶ ENGAGED ◀───────────── end of invulnerability ──────────┐
                         │                                                    │
                         └── hp <= next threshold ──▶ TRANSITION ─────────────┘
                                   (invulnerable, still, wind-up cancelled,
                                    adds spawn, arena/announcement event)
```

Between two attacks the boss is in a **recovery gap** (`gapMs`, shortened by later phases)
during which `pick` returns `null`.

## Attack selector (behaviour tree)

`selector( ultimate, far, close, mid, any )` — first child that yields a skill wins:

| Node | Condition | Offers |
|---|---|---|
| ultimate | ready and unlocked (phase 3+) | `cataclysm`: huge AoE, 2.2 s telegraph |
| far (> 420 px) | distance band | `bolt` (ranged), `charge`, `blink` (phase 2+) |
| close (< 170 px) | distance band | `flurry` (3-hit AoE), `quake` (big AoE) |
| mid | distance band | `slam` on the target; `rain` (phase 3+) |
| any | fallback | whatever fits where the target is |

Within a node the choice is weighted-random, **never the same attack twice in a row**
while an alternative exists, and every attack has its own cooldown.

## Telegraphs

Every skill is announced first (`telegraphs` in the state frame) and resolves
`telegraphMs` later at the geometry committed at wind-up:

* circle (`slam`, `nova`, `rain` — one circle per zone)
* **line** for `charge` (`k: 'line'`, end point `ex, ey`) — the lane the boss will run
* `ult: 1` marks an ultimate

Floors: 800 ms for ordinary attacks, 1500 ms for an ultimate, whatever the phase —
late phases tighten wind-ups but never below what a player can read.

## Phases

| | at HP | invulnerable | adds | other |
|---|---|---|---|---|
| 1 Guarded | 100% | — | — | base pool |
| 2 Awakened | 75% | 2.0 s | 2 | charge, blink; cooldowns ×0.9 |
| 3 Unleashed | 50% | 2.5 s | 2 | arena hazards (`rain`), ultimate; ×0.8, damage ×1.1 |
| 4 Enraged | 25% | 2.5 s | 3 | cooldowns ×0.65, telegraph ×0.8, damage ×1.25 |

Elites have three phases (60% / 30%), no ultimate and no hazard rain.

**Phase gate.** `c._hpFloor` holds the boss at the next threshold until that
transition has run, so one burst cannot skip a phase. **Invulnerability** is one check in
`applyDamage` (`c._invulnerableUntil`), so swings, projectiles, blasts, skills, burns and
reflects are all covered by the same line.

## Wire

* `telegraphs[]`: `{ creatureId, skill, x, y, radius, ms, telegraphMs, k?, ex?, ey?, ult? }`
* creature rows (near zone): `bp` (phase), `inv` (true while invulnerable) — the client draws a pulsing ring
* `announcement` frame on every phase change (`<Boss> awakens!`)

## Tuning

`profileFor(row)` builds the kit from tier, element and hitbox size; per-boss overrides go in
`BOSS_OVERRIDES`. Stats scale with the floor's level through `scaleCreature` (world-tier
bosses excepted — `bossBalance` tunes those by hand).
