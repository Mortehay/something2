# Loot filter

An in-game filter for what drops look like on the ground. Open with **L**; hold **Alt** to reveal
every item, hidden ones included (both rebindable in Settings).

## Rules

A preset is an ordered list of rules. The **top enabled rule that matches wins**; an item no rule
matches is drawn as before. A rule has:

- **Conditions** (all that are set must hold): rarity (normal / magic / rare / unique), type
  (weapon, armor, consumable, stone, currency), specific base items, item level range, affixes
  (any / all of a list).
- **Action**: *Hide* (not drawn), *Show* (normal visibility, rule's style applied), *Emphasize*
  (name plate always shown, style applied).
- **Style**: text colour, plate (background) colour, font size, light beam and its colour.

Gold is not gear: a rule only matches it if it names the `currency` category, so "hide every normal
item" never hides gold or stops it being collected.

## Hide and auto-loot

By default a hidden item is also skipped by auto-loot (per preset: "Auto-loot skips hidden"). It
stays on the ground, and the pickup key still takes it. The server decides this, not the client.

## Presets

Up to 12 per account, one active. Copy, delete (never the last), rename, and a *Starter* preset to
begin from. The filter is account data (table `account_loot_filters`), so it follows the player to
any browser.

## Where the code is

| Piece | File |
| --- | --- |
| Rule engine, validation (server) | `backend/src/authority/lootFilter.js` |
| Storage | `backend/src/authority/lootFilterStore.js`, migration `1714440893774_account_loot_filters.js` |
| Wire | `lootFilterSave` frame in, `lootFilter` / `lootFilterRejected` out; filter + affix catalog in `joined`; ground items carry `lv` (level) and `ax` (affix ids) |
| Evaluator (client, mirrors the server) | `frontend/.../core/lootFilter.js`, held equal by `lootFilterParity.test.js` |
| Editing operations | `frontend/.../core/lootFilterEditor.js` |
| Window: layout + drawing / clicks + keys | `systems/lootFilterPanel.js` / `core/lootFilterUi.js` |
| Drawing on the ground | `RenderSystem.drawGroundItem` |

Not built yet: a drop sound per rule.
