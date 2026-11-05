# Skill balance

Source of truth: [backend/seeds/data/skillSpec.js](../backend/seeds/data/skillSpec.js) (numbers),
[skillEffects.js](../backend/seeds/data/skillEffects.js) (what each skill does),
[skillDescriptions.js](../backend/seeds/data/skillDescriptions.js) (the text the player reads, generated from the two).
Client copy: `frontend/.../core/skillsCatalog.generated.js` (`make skills-sync`).

## Damage

A cast's damage is **what the level's average weapon would do auto-attacking for the skill's
cooldown, times 1.5** (1.25 for very long cooldowns). It is tied to the weapon curve in
`gearLadder.js`, so skills keep pace with gear instead of staying flat.

| | auto-attack | skill (per skill, on its cooldown) |
|---|---|---|
| L1 | ~11 dps | ~13-16 dps |
| L41-60 | 39-52 dps | ~67 dps |

A share of the cast (melee 15%, spell 10%, curse 5%) comes from the weapon actually held: a better
weapon makes skills hit harder, a bare hand loses only that share. Resources (mana/stamina/life)
are what limit how many skills run at once. A multi-hit skill splits the same total over its hits.
A channelled skill is the same ratio per 0.25 s tick.

## Cooldowns

`cd^0.78`, floored at 1 s: 4 -> 3, 8 -> 5, 15 -> 8, 30 -> 14, 90 -> 33. Buffs are not shortened (a
shorter buff cooldown is more uptime); a timed buff's cooldown is at least its duration.

## Costs

HP costs are a **percent of max life** (`costPct`): 3-18% by cooldown, 1% per tick for a channel.
No buff is free: the old free permanent ones (Blood Pact, Mana Shield, Bloodlust, auras...) now cost
a resource and recast no sooner than they end.

## Buff ceilings

Damage dealt x2, speed x1.8, attack speed x2.5, dodge 60%, damage taken never below 35% of the hit.
Druid forms: bear +30% life / -35% damage, hawk +30% speed / 20% dodge, wolf +25% attack / +15% crit.

## Effects

All 239 damaging skills carry their effects in `SKILL_EFFECTS`; the server applies each kind
(stun, root, slow, silence, weaken, vulnerability, armor shred, bleed/poison/burn, shock, fear,
knockback, pull, pierce, execute, conditional bonuses, chain, echo, zone, lifesteal, heals, dash,
cleanse, taunt, summon). Bosses are immune to stun/root/silence/fear. Party-mates and village
residents are never touched by any of it. See `backend/tests/skill_effects_engine.test.js`.

## Allies (`summon`)

Real creatures of an existing type, charmed for the skill's duration, never saved, removed when time
is up or the owner dies. Life is a fraction of the owner's, damage a fraction of one average weapon
hit at the skill's level. They pick their own fights (320 px), kills are credited to the owner, and
a hostile's melee blow lands on a nearer ally instead of the player. Max 8 per owner. Treant and
golem borrow the Skeleton body, clones and the astral spirit the Bat: there is no art for them yet.

## Descriptions

The player-facing description is generated; the original flavour text is kept as `loreEn`/`loreUk`.
