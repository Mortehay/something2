# Item affixes

Items roll modifiers ("affixes") when they drop, the way Path of Exile does it: **which** modifiers an item
has is what makes it worth picking up.

- Catalog: [backend/seeds/data/affixTypes.js](../backend/seeds/data/affixTypes.js), inserted by migrations
  `1714440876000_affix_expansion` and `1714440877000_affix_triggers` (fill-only, so editing a row in the admin
  API survives).
- Rolling: [backend/src/authority/affixes.js](../backend/src/authority/affixes.js). Pure; the dice are injected.
- Effects in play: [backend/src/services/gearAffixes.js](../backend/src/services/gearAffixes.js) folds the
  equipped items' affixes into the character's stats; [backend/src/authority/triggers.js](../backend/src/authority/triggers.js)
  runs the ones that fire on an event.
- Tooltip and item name: [itemDisplay.js](../frontend/src/games/something2/src/js/systems/itemDisplay.js).
  Ukrainian text: [i18n/uk/affixes.js](../frontend/src/games/something2/src/js/i18n/uk/affixes.js)
  (a test fails when an affix of the catalog has no translation).

## How an item rolls

1. Rarity decides the count: blue 1, yellow 3-6, foxy 3-9 -- capped by the item, which carries at most
   **three prefixes and three suffixes**.
2. The catalog is narrowed to what suits the item: its **slot**, its **family tags**, its item level, its rarity.
   Families (derived from the item type, never stored): `melee_weapon`, `ranged_weapon` (bows, crossbows,
   slings), `caster_weapon` (staves, wands, scepters), `armor`, `ring`, plus `one_handed`/`two_handed` and the slot.
3. Draws are by weight; two affixes of one **group** (two kinds of attack speed, two cost reductions...) never
   share an item.
4. Each draw picks a **tier** the item level unlocks (T1 is the best, and the rarest; a foxy item leans toward
   the top tiers) and a value inside it. Item level 1 / 20 / 40 / 60 / 80 unlock T5 .. T1.

A prefix reads as an adjective, a suffix starts with "of": an item is named "Brutal Iron Sword of Celerity".

## What an affix can do (`effect`)

| type | meaning |
|---|---|
| `stat`, `resource`, `damage`, `resist` | added as rolled (+12 STR, +80 life, +30% fire damage...) |
| `rule` `{ rule, base, scale }` | the very rules the passive tree grants (attack speed, cast speed, crit, projectiles, area, cooldowns, regeneration...), consumed by the same combat code. The roll is in player units: `rule value = base + roll * scale`, so a roll of 12 on `{ base: 1, scale: 0.01 }` is the multiplier 1.12. |
| `trigger` `{ on, action, ... }` | fires on an event: `hit` (a status rider: "12% chance to ignite"), `kill` (restore mana/stamina, a buff), `hurt` (a ward, a heal). |
| `status` | the old always-on rider ("your hits chill"). |

`effect.text` is the tooltip line (`{v}` = the roll), `effect.tiers` the tier table, `effect.int` rounds the roll.
`spellLevelBonus` (a `rule`) adds levels to every spell; each is worth 5% (`bonusLevelPower` in
`services/skillLeveling.js`), against 1% for a level bought from the smith.

## Adding an affix

1. Add it to `NEW_AFFIXES` (or `TRIGGER_AFFIXES`) in `affixTypes.js` and give it a new migration that inserts it
   (copy 1714440877000). It must name a rule that exists in `RULE_COMBINE` (`services/statComposition.js`).
2. Add its tooltip line and label to `i18n/uk/affixes.js`.
3. `npm test` in the backend runs `affix_expansion.test.js`, which checks the whole catalog: valid effects, sane
   rule values at both ends of the range, labels matching their placement, runnable triggers.

Admin API: `POST/PUT /api/affix-types` accepts all of the above (`placement`, `allowed_tags`, `group_key`,
`effect.tiers`...) and refuses what the engine could not run.

## Not done (yet)

- Triggers on a **crit** or on **dodge/block**: only `hit`, `kill` and `hurt` are wired.
- A named, fixed-roll **unique** item. The catalog supports the ingredients; the items themselves are not authored.
- Crafting (rerolling, adding a modifier). Rolls are fixed at drop, as before.
