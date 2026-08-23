# Character Sheet Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the standalone `CharacterSheet.jsx` level popup with a Character tab inside the canvas inventory panel that shows class, level, XP, the six stats itemised as `STR 42 = 5 base + 33 tree + 4 gear`, the derived-stat block, strong/weak points, and every active modifier with its source.

**Architecture:** All formatting and layout live in a new PURE module `systems/characterTab.js` (no canvas, no DOM, no fetch); `inventoryPanel.js` gains a fifth entry in its existing `TABS` array and delegates the right-hand pane to `layoutCharacterTab`; `drawCharacterTab` is the only function that touches a 2D context. Progression data reaches the tab through the existing websocket `progression` frame — which stays the **single writer** of `Game.progression` (the F1 lesson) — plus a **latched, one-shot** HTTP seed from `GET /api/progression` for the level-dependent `xpFloor`/`xpToNext`/`respecCost` and for `sources`/`modifiers`/`stats` before the first socket push arrives (the F2 lesson: never recompute a backend formula client-side).

**Tech Stack:** Plain ES modules under `frontend/src/games/something2/src/js`, vitest (node environment, `src/**/*.test.js`), canvas 2D.

**Spec:** docs/superpowers/specs/2026-08-23-progression-passive-tree-design.md
**Contract:** docs/superpowers/plans/2026-08-23-progression-shared-contract.md

---

## Global Constraints

Copied verbatim from the contract's §5:

- **Backend:** CommonJS, Express, raw `pg` queries, inline routes. See `.ai/styleguides/backend.md`.
- **Frontend admin:** React 19, styled-components, `--s2-*` tokens only, TanStack Query for data. See `.ai/styleguides/frontend.md`.
- **Game client:** plain ES modules under `frontend/src/games/something2/src/js`. Layout/maths live in testable functions separate from canvas draw calls, as `inventoryPanel.js` already does.
- **Tests:** backend `npm test` from `backend/`; frontend `npx vitest run` from `frontend/`. Any DB-touching test run MUST set both `DATABASE_URL` and `TEST_DATABASE_URL` to a per-branch scratch database, seeded with the map specs. Unset `TEST_DATABASE_URL` silently targets the SHARED DEV DATABASE.
- **Never** run a destructive statement against the shared dev database. No `DELETE FROM`, `TRUNCATE` or `DROP` outside a scratch DB.
- **No vacuous tests.** A test must not derive its expected value by calling the same function or constant the code under test uses. XP-curve, affix-roll and stat-composition expectations are hand-written literals.
- **Worktrees:** several sessions share this checkout. Every task runs in its own `git worktree`; never `checkout`, `stash` or `branch` in the shared working directory. Stage by explicit path.
- **Commits:** branch `feat/<slug>`; subject `type(scope): summary (SOMET-NNN)`; end the message with the `Co-Authored-By: Claude Opus 5 (1M context)` trailer.

**This task adds no migration.** Contract §1 lists T15 among the tasks with no slot.

---

## Dependencies, and the two contract gaps this plan closes without inventing wire fields

T15 depends on **C/T7** (`composeStats`, and `sources`/`modifiers`/`passivePoints`/`allocatedNodeIds` on the `progression` frame and on `GET /api/progression`) and **D/T12** (affixes, which is what puts `source: 'gear'` entries into `modifiers`).

Two things the tab needs that the contract does **not** name. Neither is invented here as a new wire field; both are satisfied from data that already exists:

1. **Derived stats** (`maxHp`, `maxMana`, `meleeMult`, `spellMult`, `cooldownMult`, `manaRegen`, `priceMult` — `backend/src/services/playerStats.js:39-61`). The `progression` frame carries `stats` **only** on the `refreshPlayerStats` path (`backend/src/authority/server.js:2879`); the kill-XP and death pushes (`server.js:796`, `server.js:928`) and the `joined` frame (`server.js:1515-1537`) do not. Resolution: `GET /api/progression` already returns `stats` (`backend/src/api/progressionRoutes.js`), so the client seeds from the HTTP bundle **once**, and every later socket frame that carries `stats` overwrites it. No backend change.
2. **`className` / `mainStat`.** `className` is already on the client: `listCharacters` selects `e.name AS class_name` (`backend/src/services/characters.js:42-43`) and `GameShell.jsx:562` holds it as `activeCharacter.className`. `mainStat` is B/T3's `entity_types.main_stat`. Both are threaded down through `Game.initChunked` options rather than added to the wire. **`mainStat` is allowed to be `null`** — Task 15a pins the fallback (tie-breaks fall back to `CHAR_STAT_KEYS` order), so Group E builds, tests and ships green whether or not T3 has landed.

Report both to the epic coordinator so the contract can record them.

## The two lessons this plan is required to preserve

- **F1 (single writer).** `CharacterSheet.jsx:12-51` documents a race fixed by making the websocket `progression` handler the only writer of progression state. `Game.js:489` is that writer and stays exactly as it is for `this.progression`. The new HTTP seed **never** assigns `this.progression`, and its `sources`/`modifiers`/`stats` write is **latched off** the moment any socket frame has carried those fields (Task 15d, `mergeSeedExtras`). `Game.applyGoldResult` (`Game.js:706`) keeps its narrowed, gold-only shape.
- **F2 (no client-side reimplementation).** `CharacterSheet.jsx:53-76`: `xpCurve.js` re-declared `XP_BASE`/`MAX_LEVEL`/`RESPEC_BASE` and drifted. `characterTab.js` declares **no** progression constant and computes **no** curve: `xpFloor`, `xpToNext` and `respecCost` are read from the server bundle, and the stat breakdown is rendered from `composeStats().sources` rather than recomputed. Task 15a ships a standing source-text guard for this, migrated from `characterSheet.test.js:307-331`.

One deliberate, narrow exception, called out so review can argue with it: **the displayed stat total is the sum `base + tree + gear` of the server's own `sources` entry**, not a second number. Adding three integers the server sent is not a formula reimplementation, and it makes it structurally impossible for the headline number and its breakdown to disagree — which is the actual UI failure mode. Task 15a pins it with literals.

## The `C` key: freed, then reused

`CharacterSheet.jsx:313-323` is the only handler for `C` today; `Game.js:1051` maps `KeyC: 'c'` in `CODE_TO_KEY` but `Game.js` has **no** `isKey('c')` branch (grep `isKey(` — the claims are `i`, `escape`, `e`, `b`, `f`, `g`, `m`, `t`). So deleting the popup frees `C` outright.

**Decision: reuse it.** `C` opens the inventory panel directly on the Character tab (and closes it if it is already open on that tab). Muscle memory survives, the key stays claimed by exactly one handler, and `KeyC: 'c'` in `CODE_TO_KEY` stops being dead.

**Gotcha this creates, pinned in Task 15e:** `__tests__/hotkeyRegistry.test.js:109` asserts `expect(listeners.length).toBeGreaterThanOrEqual(4)`. Exactly four files register a window `keydown` listener today (`Minimap.jsx`, `CharacterSheet.jsx`, `WaypointTravel.jsx`, `core/Game.js`). Deleting the popup takes that to three and turns that assertion red. The bound is lowered to 3 **with the reason written next to it**, never deleted.

---

## File Structure

| File | Created / Modified | Its ONE responsibility |
|---|---|---|
| `frontend/src/games/something2/src/js/systems/characterTab.js` | Create (15a, 15b) | PURE formatting + layout for the Character pane. No canvas, no fetch, no constants copied from the backend. |
| `frontend/src/games/something2/src/js/systems/__tests__/characterTab.test.js` | Create (15a, 15b) | Tests for every pure function and the pane layout. |
| `frontend/src/games/something2/src/js/systems/inventoryPanel.js` | Modify (15b: `TABS`/`visibleItems`/`layoutInventory`; 15c: `drawInventory`) | Own the panel's tab set and delegate the right-hand pane. |
| `frontend/src/games/something2/src/js/systems/__tests__/inventoryPanel.test.js` | Modify (15b) | Pin the fifth tab and that it feeds the grid nothing. |
| `frontend/src/games/something2/src/js/systems/__tests__/characterTabDraw.test.js` | Create (15c) | Assert the strings and rects `drawCharacterTab` writes to a recording context. |
| `frontend/src/games/something2/src/js/core/progressionExtras.js` | Create (15d) | PURE merge rules for the progression side-channel + the view object the panel consumes. |
| `frontend/src/games/something2/src/js/core/__tests__/progressionExtras.test.js` | Create (15d) | Pin the single-writer latch and the view builder. |
| `frontend/src/games/something2/src/js/core/Game.js` | Modify (15d: state + wiring + click routing; 15e: the `C` binding) | Hold the live state and route clicks/keys. |
| `frontend/src/games/something2/src/js/systems/RenderSystem.js` | Modify (15d) | Pass `character`/`modPage` through to `layoutInventory`. |
| `frontend/src/games/something2/GameShell.jsx` | Modify (15d) | Thread `className`/`mainStat` from `activeCharacter` into `initChunked`. |
| `frontend/src/games/something2/CharacterSheet.jsx` | **Delete** (15e) | — |
| `frontend/src/games/something2/GameView.jsx` | Modify (15e) | Stop mounting the deleted popup. |
| `frontend/src/games/something2/src/js/__tests__/characterSheet.test.js` | **Delete** (15e) | — |
| `frontend/src/games/something2/src/js/net/__tests__/progressionClient.test.js` | Create (15e) | Home for the `progressionClient` tests that outlive the popup. |
| `frontend/src/games/something2/__tests__/hotkeyRegistry.test.js` | Modify (15e) | Keep the collision guard honest with one fewer listener file. |
| `frontend/src/games/something2/src/js/core/__tests__/progressionSnapshot.test.js` | Modify (15e) | Update the two comments that name the deleted component. |
| `frontend/src/games/something2/src/js/net/progressionClient.js` | Modify (15e, comment only) | Update the header that names `CharacterSheet`. |

---

### Task 15a: Pure formatting — breakdown, strong/weak, derived, modifiers, XP

**Files:**
- Create: `frontend/src/games/something2/src/js/systems/characterTab.js`
- Create: `frontend/src/games/something2/src/js/systems/__tests__/characterTab.test.js`

**Interfaces:**
- Consumes: `composeStats().sources` — `{ <statKey>: { base: n, tree: n, gear: n } }` — and `composeStats().modifiers` — `[{ label, value, source, kind, detail }]`, `source` in `'tree'|'gear'`, `kind` in `'stat'|'resource'|'damage'|'resist'|'status'` (contract §2, `statComposition.js`). Consumes `derivePlayerStats()`'s bundle: `{ maxHp, maxMana, meleeMult, spellMult, cooldownMult, manaRegen, priceMult }` (`backend/src/services/playerStats.js:39-61`). Consumes `xpFloor`/`xpToNext` off the server bundle (contract §3).
- Produces:
  - `CHAR_STAT_KEYS: string[6]`, `STAT_ABBR: Record<string,string>`
  - `statTotal(entry: {base,tree,gear}|null) -> number|null`
  - `formatStatBreakdown(statKey: string, entry) -> string`
  - `strongAndWeak(sources, mainStat: string|null) -> { strong: string|null, weak: string|null }`
  - `formatHighlights(sources, mainStat) -> string`
  - `formatHeader({className, level}) -> string`
  - `derivedRows(stats|null) -> string[7]`
  - `formatModifier(mod) -> string`
  - `modifierRows(modifiers) -> [{ text: string, source: string|null }]`
  - `xpBar({experience, xpFloor, xpToNext}) -> { into, need, pct }`
  - `formatXpLabel({into, need}, loaded: boolean) -> string`
  - `formatPoints(passivePoints) -> string`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/systems/__tests__/characterTab.test.js`:

```js
// Pure formatting for the Character tab (SOMET-NNN, spec §10.2). Every
// expectation below is a hand-written literal string or number. Nothing here
// calls the function under test to build its own expectation, and nothing
// here re-implements a backend formula -- xpFloor/xpToNext arrive as data
// (see the F2 guard at the bottom of this file).
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CHAR_STAT_KEYS, statTotal, formatStatBreakdown, strongAndWeak, formatHighlights,
  formatHeader, derivedRows, formatModifier, modifierRows, xpBar, formatXpLabel,
  formatPoints,
} from "../characterTab.js";

// A level-7 Warrior deep into the strength sector, wearing one +4 STR item.
const RICH_SOURCES = {
  strength:     { base: 5, tree: 33, gear: 4 },
  dexterity:    { base: 5, tree: 6,  gear: 0 },
  constitution: { base: 8, tree: 4,  gear: 2 },
  intelligence: { base: 5, tree: 0,  gear: 0 },
  wisdom:       { base: 6, tree: 2,  gear: 0 },
  charisma:     { base: 5, tree: 0,  gear: 0 },
};

// A brand-new level-1 character: class base only, no tree, no gear.
const FRESH_SOURCES = {
  strength:     { base: 5, tree: 0, gear: 0 },
  dexterity:    { base: 5, tree: 0, gear: 0 },
  constitution: { base: 5, tree: 0, gear: 0 },
  intelligence: { base: 5, tree: 0, gear: 0 },
  wisdom:       { base: 5, tree: 0, gear: 0 },
  charisma:     { base: 5, tree: 0, gear: 0 },
};

describe("CHAR_STAT_KEYS", () => {
  it("lists all six stats in the backend's whitelist order", () => {
    expect(CHAR_STAT_KEYS).toEqual([
      "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma",
    ]);
  });
});

describe("statTotal", () => {
  it("adds the server's own three parts", () => {
    expect(statTotal({ base: 5, tree: 33, gear: 4 })).toBe(42);
  });
  it("treats a missing part as zero", () => {
    expect(statTotal({ base: 8 })).toBe(8);
  });
  it("is null when the server sent no breakdown for this stat", () => {
    expect(statTotal(null)).toBeNull();
    expect(statTotal(undefined)).toBeNull();
  });
});

describe("formatStatBreakdown", () => {
  it("itemises a stat that has all three parts", () => {
    expect(formatStatBreakdown("strength", RICH_SOURCES.strength))
      .toBe("STR 42 = 5 base + 33 tree + 4 gear");
  });

  it("omits a zero part rather than printing '+ 0 gear'", () => {
    expect(formatStatBreakdown("constitution", { base: 8, tree: 0, gear: 2 }))
      .toBe("CON 10 = 8 base + 2 gear");
    expect(formatStatBreakdown("dexterity", { base: 5, tree: 6, gear: 0 }))
      .toBe("DEX 11 = 5 base + 6 tree");
  });

  it("keeps the base part even when it is the only one (a fresh level-1 character)", () => {
    expect(formatStatBreakdown("intelligence", { base: 5, tree: 0, gear: 0 }))
      .toBe("INT 5 = 5 base");
  });

  it("shows an em dash, not a zero, when the breakdown has not arrived", () => {
    expect(formatStatBreakdown("wisdom", null)).toBe("WIS —");
  });
});

describe("strongAndWeak", () => {
  it("picks the highest and the lowest effective stat", () => {
    // strength 42 is the clear max. intelligence 5 and charisma 5 tie for the
    // minimum; neither is the Warrior's main stat, so declaration order wins.
    expect(strongAndWeak(RICH_SOURCES, "strength"))
      .toEqual({ strong: "strength", weak: "intelligence" });
  });

  it("breaks a tie for STRONGEST toward the class main stat", () => {
    // A Mage whose strength and intelligence both total 20. Declaration order
    // would say strength; the main stat wins instead.
    const tied = {
      strength:     { base: 5, tree: 15, gear: 0 },
      dexterity:    { base: 5, tree: 0,  gear: 0 },
      constitution: { base: 5, tree: 0,  gear: 0 },
      intelligence: { base: 5, tree: 15, gear: 0 },
      wisdom:       { base: 5, tree: 0,  gear: 0 },
      charisma:     { base: 5, tree: 0,  gear: 0 },
    };
    expect(strongAndWeak(tied, "intelligence").strong).toBe("intelligence");
  });

  it("breaks a tie for WEAKEST toward the class main stat too (spec §10.2, read literally)", () => {
    // A Druid (charisma) who has poured everything into constitution. dexterity
    // and charisma both sit at 5; the main stat wins the tie.
    const tied = {
      strength:     { base: 7, tree: 0,  gear: 0 },
      dexterity:    { base: 5, tree: 0,  gear: 0 },
      constitution: { base: 6, tree: 20, gear: 0 },
      intelligence: { base: 6, tree: 0,  gear: 0 },
      wisdom:       { base: 6, tree: 0,  gear: 0 },
      charisma:     { base: 5, tree: 0,  gear: 0 },
    };
    expect(strongAndWeak(tied, "charisma").weak).toBe("charisma");
  });

  it("falls back to declaration order when the class main stat is unknown", () => {
    // mainStat is null until B/T3 exposes entity_types.main_stat. The tab must
    // still render rather than throw or show nothing.
    expect(strongAndWeak(RICH_SOURCES, null))
      .toEqual({ strong: "strength", weak: "intelligence" });
  });

  it("reports NO weak point when every stat is equal (a fresh level-1 character)", () => {
    // Six identical numbers have no lowest one. Naming the same stat as both
    // strong and weak reads as a bug, so weak is null and the line says so.
    expect(strongAndWeak(FRESH_SOURCES, "strength"))
      .toEqual({ strong: "strength", weak: null });
  });

  it("is all-null when no breakdown has arrived", () => {
    expect(strongAndWeak(null, "strength")).toEqual({ strong: null, weak: null });
  });
});

describe("formatHighlights", () => {
  it("names both points with their totals", () => {
    expect(formatHighlights(RICH_SOURCES, "strength"))
      .toBe("Strong: STR 42    Weak: INT 5");
  });
  it("dashes the weak point on a flat spread", () => {
    expect(formatHighlights(FRESH_SOURCES, "strength"))
      .toBe("Strong: STR 5    Weak: —");
  });
});

describe("formatHeader", () => {
  it("names the class and the level", () => {
    expect(formatHeader({ className: "Warrior", level: 7 })).toBe("Warrior — Level 7");
  });
  it("says so rather than printing 'undefined' when the class is unknown", () => {
    expect(formatHeader({ className: null, level: 1 })).toBe("Unknown class — Level 1");
  });
});

describe("derivedRows", () => {
  it("renders the seven derived numbers in a fixed order and column", () => {
    expect(derivedRows({
      maxHp: 140, maxMana: 100, meleeMult: 1.15, spellMult: 1,
      cooldownMult: 0.8696, manaRegen: 10, priceMult: 0.55,
    })).toEqual([
      "Max HP        140",
      "Max mana      100",
      "Melee         x1.15",
      "Spell         x1.00",
      "Cooldown      x0.87",
      "Mana regen    10",
      "Sell price    x0.55",
    ]);
  });

  it("dashes every value when the derived bundle has not arrived yet", () => {
    expect(derivedRows(null)).toEqual([
      "Max HP        —",
      "Max mana      —",
      "Melee         —",
      "Spell         —",
      "Cooldown      —",
      "Mana regen    —",
      "Sell price    —",
    ]);
  });

  it("keeps a fractional regen readable without trailing zeros", () => {
    expect(derivedRows({
      maxHp: 100, maxMana: 100, meleeMult: 1, spellMult: 1,
      cooldownMult: 1, manaRegen: 12.5, priceMult: 0.5,
    })[5]).toBe("Mana regen    12.5");
  });
});

describe("formatModifier", () => {
  it("signs a positive value and appends the unit suffix", () => {
    expect(formatModifier({
      label: "Increased Projectile Damage", value: 12, source: "tree", kind: "damage", detail: "%",
    })).toBe("Increased Projectile Damage  +12%");
  });

  it("renders a plain stat grant with no suffix", () => {
    expect(formatModifier({ label: "Strength", value: 4, source: "gear", kind: "stat" }))
      .toBe("Strength  +4");
  });

  it("signs a negative value", () => {
    expect(formatModifier({ label: "Cooldown", value: -8, source: "tree", kind: "damage", detail: "%" }))
      .toBe("Cooldown  -8%");
  });

  it("survives a modifier with no numeric value (a keystone that changes a rule)", () => {
    expect(formatModifier({ label: "Blood Pact", value: null, source: "tree", kind: "status" }))
      .toBe("Blood Pact");
  });
});

describe("modifierRows", () => {
  it("keeps gear and tree entries in the server's own order, each tagged with its source", () => {
    // Deliberately interleaved: the client does not re-sort, so what the player
    // reads is what composeStats() actually produced.
    expect(modifierRows([
      { label: "Increased Projectile Damage", value: 12, source: "tree", kind: "damage", detail: "%" },
      { label: "Strength", value: 4, source: "gear", kind: "stat" },
      { label: "Chill on Hit", value: 8, source: "gear", kind: "status", detail: "% chance" },
      { label: "Blood Pact", value: null, source: "tree", kind: "status" },
    ])).toEqual([
      { text: "Increased Projectile Damage  +12%", source: "tree" },
      { text: "Strength  +4", source: "gear" },
      { text: "Chill on Hit  +8% chance", source: "gear" },
      { text: "Blood Pact", source: "tree" },
    ]);
  });

  it("says so when a character has neither passives nor affixes", () => {
    expect(modifierRows([])).toEqual([
      { text: "No modifiers yet — allocate passives or equip gear.", source: null },
    ]);
    expect(modifierRows(null)).toEqual([
      { text: "No modifiers yet — allocate passives or equip gear.", source: null },
    ]);
  });
});

describe("xpBar", () => {
  it("reports the position inside the current level from the server's own numbers", () => {
    // Wire values, not a local curve: a level-3 character under the new curve
    // has xpFloor 63 and xpToNext 78 (spec §4). 102 XP is 39 into that 78-wide
    // band -> 50%. Literal expectations; this function never computes a curve.
    expect(xpBar({ experience: 102, xpFloor: 63, xpToNext: 78 }))
      .toEqual({ into: 39, need: 78, pct: 50 });
  });

  it("does not divide by null at max level -- JSON encodes Infinity as null", () => {
    expect(xpBar({ experience: 900000, xpFloor: 900000, xpToNext: null }))
      .toEqual({ into: 0, need: 0, pct: 100 });
  });

  it("returns an empty (not full) bar while the bundle is still loading", () => {
    expect(xpBar({ experience: 0, xpFloor: null, xpToNext: null }))
      .toEqual({ into: 0, need: 0, pct: 0 });
  });

  it("stays finite past the max-level floor", () => {
    const r = xpBar({ experience: 999999, xpFloor: 900000, xpToNext: null });
    expect(r).toEqual({ into: 99999, need: 0, pct: 100 });
    expect(Number.isFinite(r.into)).toBe(true);
  });
});

describe("formatXpLabel", () => {
  it("shows progress toward the next level", () => {
    expect(formatXpLabel({ into: 39, need: 78, pct: 50 }, true)).toBe("39 / 78 XP");
  });
  it("shows MAX LEVEL when nothing more is needed", () => {
    expect(formatXpLabel({ into: 0, need: 0, pct: 100 }, true)).toBe("MAX LEVEL");
  });
  it("shows a loading state rather than a false MAX LEVEL", () => {
    expect(formatXpLabel({ into: 0, need: 0, pct: 0 }, false)).toBe("Loading…");
  });
});

describe("formatPoints", () => {
  it("names the unspent passive points", () => {
    expect(formatPoints(3)).toBe("Passive points: 3");
  });
  it("shows zero rather than nothing", () => {
    expect(formatPoints(0)).toBe("Passive points: 0");
    expect(formatPoints(null)).toBe("Passive points: 0");
  });
});

// SOURCE-TEXT ONLY, migrated from characterSheet.test.js's F2 block, which is
// deleted along with the popup in Task 15e. The lesson it guards outlives the
// component: a client-side copy of a backend progression constant drifts the
// first time the backend's copy moves. This is NOT behavioural evidence; it is
// a standing prohibition.
describe("F2: the Character tab declares no backend progression constant", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../characterTab.js", import.meta.url)), "utf8",
  );

  it("declares no XP_BASE / MAX_LEVEL / RESPEC_BASE of its own", () => {
    expect(source).not.toMatch(/const\s+XP_BASE/);
    expect(source).not.toMatch(/const\s+MAX_LEVEL/);
    expect(source).not.toMatch(/const\s+RESPEC_BASE/);
  });

  it("computes no power/curve arithmetic -- xpFloor and xpToNext arrive as data", () => {
    expect(source).not.toMatch(/Math\.pow/);
    expect(source).not.toMatch(/\*\*/);
  });

  it("xpCurve.js, the deleted local reimplementation, still does not exist", () => {
    const xpCurvePath = fileURLToPath(new URL("../../core/xpCurve.js", import.meta.url));
    expect(existsSync(xpCurvePath)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/markunn/worker/coding/jsgame/something2/frontend && npx vitest run src/games/something2/src/js/systems/__tests__/characterTab.test.js`

Expected: FAIL with `Failed to resolve import "../characterTab.js" from "src/games/something2/src/js/systems/__tests__/characterTab.test.js". Does the file exist?`

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/src/games/something2/src/js/systems/characterTab.js`:

```js
// Character tab: PURE formatting for the inventory panel's fifth tab
// (SOMET-NNN, spec §10.2). Same split inventoryPanel.js already uses -- this
// module computes strings and rects and never touches a canvas, which is what
// makes every line below a unit test rather than a screenshot.
//
// F2 RULE (CharacterSheet.jsx's deleted header, kept alive by the source-text
// guard in this module's test file): NOTHING here re-implements a backend
// formula. xpFloor, xpToNext, respecCost and the six-stat breakdown all
// arrive as data from the server -- composeStats().sources for the breakdown,
// GET /api/progression (or the websocket frame) for the curve numbers. The
// one arithmetic this module does perform is summing the server's OWN three
// parts (base + tree + gear) for the headline total, precisely so the total
// and its breakdown cannot disagree.

export const CHAR_STAT_KEYS = [
  "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma",
];

export const STAT_ABBR = {
  strength: "STR", dexterity: "DEX", constitution: "CON",
  intelligence: "INT", wisdom: "WIS", charisma: "CHA",
};

const DASH = "—";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Integers print bare; a fraction keeps up to 2dp with no trailing zeros, so
// a mana regen of 12.50 reads "12.5" and one of 10 reads "10".
function trimNumber(n) {
  if (!Number.isFinite(n)) return DASH;
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

function mult(n) {
  return Number.isFinite(n) ? `x${n.toFixed(2)}` : DASH;
}

export function statTotal(entry) {
  if (!entry || typeof entry !== "object") return null;
  return num(entry.base) + num(entry.tree) + num(entry.gear);
}

export function formatStatBreakdown(statKey, entry) {
  const abbr = STAT_ABBR[statKey] || String(statKey || "?").slice(0, 3).toUpperCase();
  const total = statTotal(entry);
  if (total === null) return `${abbr} ${DASH}`;
  // The base part is always shown, even at 0, because "where did this number
  // come from" is the whole point of the line. A zero tree/gear part is noise.
  const parts = [`${num(entry.base)} base`];
  if (num(entry.tree) !== 0) parts.push(`${num(entry.tree)} tree`);
  if (num(entry.gear) !== 0) parts.push(`${num(entry.gear)} gear`);
  return `${abbr} ${total} = ${parts.join(" + ")}`;
}

// Highest and lowest effective stat. Ties break toward the class main stat, as
// spec §10.2 states for both ends. When every stat is equal there is no lowest
// one -- returning the same key for both would read as a bug, so weak is null
// and the caller renders a dash.
export function strongAndWeak(sources, mainStat) {
  if (!sources) return { strong: null, weak: null };
  const totals = CHAR_STAT_KEYS
    .map((k) => ({ key: k, total: statTotal(sources[k]) }))
    .filter((e) => e.total !== null);
  if (totals.length === 0) return { strong: null, weak: null };

  const max = Math.max(...totals.map((e) => e.total));
  const min = Math.min(...totals.map((e) => e.total));
  const pick = (value) => {
    const tied = totals.filter((e) => e.total === value).map((e) => e.key);
    return tied.includes(mainStat) ? mainStat : tied[0];
  };
  return { strong: pick(max), weak: max === min ? null : pick(min) };
}

function labelled(sources, key) {
  if (!key) return DASH;
  return `${STAT_ABBR[key]} ${statTotal(sources[key])}`;
}

export function formatHighlights(sources, mainStat) {
  const { strong, weak } = strongAndWeak(sources, mainStat);
  return `Strong: ${labelled(sources, strong)}    Weak: ${labelled(sources, weak)}`;
}

export function formatHeader(character) {
  const className = (character && character.className) || null;
  const level = character && character.level != null ? character.level : DASH;
  return `${className || "Unknown class"} — Level ${level}`;
}

const DERIVED_FIELDS = [
  ["Max HP", "maxHp", trimNumber],
  ["Max mana", "maxMana", trimNumber],
  ["Melee", "meleeMult", mult],
  ["Spell", "spellMult", mult],
  ["Cooldown", "cooldownMult", mult],
  ["Mana regen", "manaRegen", trimNumber],
  ["Sell price", "priceMult", mult],
];

export function derivedRows(stats) {
  return DERIVED_FIELDS.map(([label, key, fmt]) => {
    const raw = stats ? Number(stats[key]) : NaN;
    return `${label.padEnd(14)}${Number.isFinite(raw) ? fmt(raw) : DASH}`;
  });
}

// `detail` is a unit suffix and is glued straight onto the value ("%",
// "% chance"), so a percentage does not render as "+12 %". A modifier with no
// numeric value is a keystone that changes a rule rather than adding a number;
// it prints its label alone.
export function formatModifier(mod) {
  const label = String((mod && mod.label) || "unknown");
  const raw = Number(mod && mod.value);
  if (!Number.isFinite(raw)) return label;
  const sign = raw < 0 ? "-" : "+";
  const detail = (mod && mod.detail) ? String(mod.detail) : "";
  return `${label}  ${sign}${trimNumber(Math.abs(raw))}${detail}`;
}

export const NO_MODIFIERS_TEXT = "No modifiers yet — allocate passives or equip gear.";

// Server order is preserved deliberately: re-sorting client-side would make
// the list disagree with the composeStats() output it claims to be showing.
export function modifierRows(modifiers) {
  const list = Array.isArray(modifiers) ? modifiers : [];
  if (list.length === 0) return [{ text: NO_MODIFIERS_TEXT, source: null }];
  return list.map((m) => ({ text: formatModifier(m), source: (m && m.source) || null }));
}

// Position inside the current level. `xpToNext` is Infinity at max level on the
// backend and serialises as null over JSON, so this checks Number.isFinite
// against the raw field and never coerces it through Number() first (that
// would turn null into 0 and silently divide by it). Two distinct "nothing to
// show" cases, deliberately not conflated: no xpFloor at all (still loading)
// gives an EMPTY bar, not "MAX LEVEL".
export function xpBar(character) {
  const experience = num(character && character.experience);
  const floorRaw = character ? character.xpFloor : null;
  if (typeof floorRaw !== "number") return { into: 0, need: 0, pct: 0 };
  const into = Math.max(0, experience - floorRaw);
  const toNext = character.xpToNext;
  if (!Number.isFinite(toNext)) return { into, need: 0, pct: 100 };
  const pct = toNext > 0 ? Math.round((into / toNext) * 100) : 0;
  return { into, need: toNext, pct };
}

export function xpLoaded(character) {
  return !!character && typeof character.xpFloor === "number";
}

export function formatXpLabel(bar, loaded) {
  if (!loaded) return "Loading…";
  return bar.need > 0 ? `${bar.into} / ${bar.need} XP` : "MAX LEVEL";
}

export function formatPoints(passivePoints) {
  return `Passive points: ${num(passivePoints)}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/markunn/worker/coding/jsgame/something2/frontend && npx vitest run src/games/something2/src/js/systems/__tests__/characterTab.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/characterTab.js frontend/src/games/something2/src/js/systems/__tests__/characterTab.test.js
git commit -m "$(cat <<'EOF'
feat(sheet): pure formatting for the character tab (SOMET-NNN)

Itemised stat breakdowns, strong/weak selection with the main-stat tie-break,
the derived-stat block, the combined modifier list and the XP bar -- all pure,
all fed from the server's own sources/modifiers/xpFloor/xpToNext. Carries
CharacterSheet.jsx's F2 source-text guard forward so no backend progression
constant can be reintroduced client-side.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15b: The Character pane layout, and the fifth tab

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/characterTab.js` (append `layoutCharacterTab` + its constants)
- Modify: `frontend/src/games/something2/src/js/systems/inventoryPanel.js:53-70` (`TABS`, `visibleItems`), `:72-182` (`layoutInventory`)
- Modify: `frontend/src/games/something2/src/js/systems/__tests__/inventoryPanel.test.js:126-162`
- Test: `frontend/src/games/something2/src/js/systems/__tests__/characterTab.test.js` (append)

**Interfaces:**
- Consumes: everything Task 15a produced, plus `PANEL_W`/`PANEL_H`/`GRID_COLS`/`CELL`/`GUTTER` from `inventoryPanel.js:8-17`.
- Produces:
  - `CHAR_LINE_H = 16`, `CHAR_MOD_ROWS = 7`
  - `layoutCharacterTab({ character, x, y, w, h, modPage }) -> { x, y, w, h, loading, header, xp, statLines, highlight, points, derived, modifiers, hitAreas }`
  - `layoutInventory` return gains `character: <pane>|null`; `TABS` gains a `character` entry with `pane: "character"`.
  - New hit-area kind: `{ kind: "charmodpage", id: <pageIndex> }`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/games/something2/src/js/systems/__tests__/characterTab.test.js`:

```js
import { layoutCharacterTab, CHAR_MOD_ROWS } from "../characterTab.js";
import { layoutInventory, visibleItems, TABS } from "../inventoryPanel.js";

const PANE = { x: 300, y: 200, w: 528, h: 340 };

const RICH_CHARACTER = {
  className: "Warrior",
  mainStat: "strength",
  level: 7,
  experience: 102,
  xpFloor: 63,
  xpToNext: 78,
  passivePoints: 3,
  sources: RICH_SOURCES,
  modifiers: [
    { label: "Increased Projectile Damage", value: 12, source: "tree", kind: "damage", detail: "%" },
    { label: "Strength", value: 4, source: "gear", kind: "stat" },
  ],
  stats: {
    maxHp: 140, maxMana: 100, meleeMult: 1.15, spellMult: 1,
    cooldownMult: 0.8696, manaRegen: 10, priceMult: 0.55,
  },
};

const FRESH_CHARACTER = {
  className: "Mage",
  mainStat: "intelligence",
  level: 1,
  experience: 0,
  xpFloor: 0,
  xpToNext: 18,
  passivePoints: 0,
  sources: FRESH_SOURCES,
  modifiers: [],
  stats: { maxHp: 100, maxMana: 100, meleeMult: 1, spellMult: 1, cooldownMult: 1, manaRegen: 10, priceMult: 0.5 },
};

describe("layoutCharacterTab", () => {
  it("lays out the header, the six itemised stats and the seven derived rows", () => {
    const l = layoutCharacterTab({ ...PANE, character: RICH_CHARACTER });
    expect(l.header.text).toBe("Warrior — Level 7");
    expect(l.statLines.map((s) => s.text)).toEqual([
      "STR 42 = 5 base + 33 tree + 4 gear",
      "DEX 11 = 5 base + 6 tree",
      "CON 14 = 8 base + 4 tree + 2 gear",
      "INT 5 = 5 base",
      "WIS 8 = 6 base + 2 tree",
      "CHA 5 = 5 base",
    ]);
    expect(l.derived.map((d) => d.text)).toEqual([
      "Max HP        140",
      "Max mana      100",
      "Melee         x1.15",
      "Spell         x1.00",
      "Cooldown      x0.87",
      "Mana regen    10",
      "Sell price    x0.55",
    ]);
    expect(l.highlight.text).toBe("Strong: STR 42    Weak: INT 5");
    expect(l.points.text).toBe("Passive points: 3");
    expect(l.xp.label).toBe("39 / 78 XP");
  });

  it("marks the strong and weak stat lines so the draw can tint them", () => {
    const l = layoutCharacterTab({ ...PANE, character: RICH_CHARACTER });
    expect(l.statLines[0].strong).toBe(true);   // strength
    expect(l.statLines[0].weak).toBe(false);
    expect(l.statLines[3].weak).toBe(true);     // intelligence
    expect(l.statLines[3].strong).toBe(false);
    expect(l.statLines.filter((s) => s.strong)).toHaveLength(1);
    expect(l.statLines.filter((s) => s.weak)).toHaveLength(1);
  });

  it("renders a fresh level-1 character with zero passives and zero affixes", () => {
    const l = layoutCharacterTab({ ...PANE, character: FRESH_CHARACTER });
    expect(l.statLines.map((s) => s.text)).toEqual([
      "STR 5 = 5 base", "DEX 5 = 5 base", "CON 5 = 5 base",
      "INT 5 = 5 base", "WIS 5 = 5 base", "CHA 5 = 5 base",
    ]);
    expect(l.highlight.text).toBe("Strong: INT 5    Weak: —");
    expect(l.points.text).toBe("Passive points: 0");
    expect(l.modifiers.rows).toEqual([
      { text: "No modifiers yet — allocate passives or equip gear.", source: null, x: PANE.x, y: l.modifiers.rows[0].y },
    ]);
    expect(l.modifiers.pageCount).toBe(1);
    expect(l.modifiers.prev).toBeNull();
    expect(l.modifiers.next).toBeNull();
    expect(l.hitAreas).toEqual([]);
  });

  it("keeps every element inside the pane it was given", () => {
    const l = layoutCharacterTab({ ...PANE, character: RICH_CHARACTER });
    const boxes = [l.xp.track, ...l.modifiers.rows, ...l.statLines, ...l.derived];
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(PANE.x);
      expect(b.y).toBeGreaterThanOrEqual(PANE.y);
      expect(b.y).toBeLessThanOrEqual(PANE.y + PANE.h);
    }
  });

  it("pages a long modifier list and registers arrow hit areas", () => {
    const many = [];
    for (let i = 0; i < CHAR_MOD_ROWS + 2; i += 1) {
      many.push({ label: `Mod ${i}`, value: i, source: "tree", kind: "stat" });
    }
    const p0 = layoutCharacterTab({ ...PANE, character: { ...RICH_CHARACTER, modifiers: many } });
    expect(p0.modifiers.pageCount).toBe(2);
    expect(p0.modifiers.rows).toHaveLength(CHAR_MOD_ROWS);
    expect(p0.modifiers.rows[0].text).toBe("Mod 0  +0");
    expect(p0.modifiers.prev).toBeNull();
    expect(p0.hitAreas).toContainEqual({ ...p0.modifiers.next, kind: "charmodpage", id: 1 });

    const p1 = layoutCharacterTab({ ...PANE, character: { ...RICH_CHARACTER, modifiers: many }, modPage: 1 });
    expect(p1.modifiers.rows).toHaveLength(2);
    expect(p1.modifiers.rows[0].text).toBe(`Mod ${CHAR_MOD_ROWS}  +${CHAR_MOD_ROWS}`);
    expect(p1.modifiers.next).toBeNull();
    expect(p1.hitAreas).toContainEqual({ ...p1.modifiers.prev, kind: "charmodpage", id: 0 });
  });

  it("clamps a modifier page past the end", () => {
    const l = layoutCharacterTab({ ...PANE, character: RICH_CHARACTER, modPage: 9 });
    expect(l.modifiers.page).toBe(0);
    expect(l.modifiers.rows[0].text).toBe("Increased Projectile Damage  +12%");
  });

  it("says it is loading when no character view has arrived", () => {
    const l = layoutCharacterTab({ ...PANE, character: null });
    expect(l.loading.text).toBe("Loading character…");
    expect(l.statLines).toEqual([]);
    expect(l.header).toBeNull();
    expect(l.hitAreas).toEqual([]);
  });
});

describe("the Character tab inside the inventory panel", () => {
  function inv() {
    return { types: new Map(), items: [], equipment: {}, ammoCounts: new Map(), capacity: 48 };
  }

  it("offers Character as the fifth tab, after the four item filters", () => {
    expect(TABS.map((t) => t.key)).toEqual(["all", "equip", "supply", "stones", "character"]);
    const l = layoutInventory({ inventory: inv() });
    expect(l.tabs.map((t) => t.label)).toEqual(["All", "Equip", "Supply", "Stones", "Character"]);
    const last = l.tabs[4];
    expect(last.x + last.w).toBeLessThanOrEqual(l.panel.x + l.panel.w);
    expect(l.hitAreas).toContainEqual({ x: last.x, y: last.y, w: last.w, h: last.h, kind: "invtab", id: "character" });
  });

  it("feeds the item grid nothing at all on the Character tab", () => {
    // Without this the tab would inherit `categories: null` ("show everything")
    // and paint the item grid straight through the character pane.
    const i = inv();
    i.types = new Map([[1, { id: 1, name: "short sword", category: "weapon", slot: "main_hand" }]]);
    i.items = [{ id: "w", typeId: 1, quantity: 1 }];
    expect(visibleItems(i, "character")).toEqual([]);
    const l = layoutInventory({ inventory: i, tab: "character" });
    expect(l.cells.every((c) => c.item === null)).toBe(true);
    expect(l.hitAreas.some((a) => a.kind === "item")).toBe(false);
    expect(l.pages.count).toBe(1);
    expect(l.pages.prev).toBeNull();
    expect(l.pages.next).toBeNull();
  });

  it("builds the character pane only on the Character tab", () => {
    expect(layoutInventory({ inventory: inv(), tab: "all", character: RICH_CHARACTER }).character).toBeNull();
    const l = layoutInventory({ inventory: inv(), tab: "character", character: RICH_CHARACTER });
    expect(l.character).not.toBeNull();
    expect(l.character.header.text).toBe("Warrior — Level 7");
  });

  it("hoists the pane's hit areas onto the panel so clicks route", () => {
    const many = [];
    for (let i = 0; i < CHAR_MOD_ROWS + 2; i += 1) {
      many.push({ label: `Mod ${i}`, value: i, source: "tree", kind: "stat" });
    }
    const l = layoutInventory({
      inventory: inv(), tab: "character",
      character: { ...RICH_CHARACTER, modifiers: many },
    });
    expect(l.hitAreas.some((a) => a.kind === "charmodpage" && a.id === 1)).toBe(true);
  });

  it("keeps the paperdoll and the footer on the Character tab", () => {
    // The left column is character-shaped already; only the right-hand grid is
    // replaced. Losing the equipment boxes here would be a regression.
    const l = layoutInventory({ inventory: inv(), tab: "character", character: RICH_CHARACTER });
    expect(l.slots).toHaveLength(8);
    expect(l.footer.autoLoot).not.toBeNull();
    expect(l.character.x).toBeGreaterThan(l.preview.x + l.preview.w);
  });
});
```

Also update the two existing assertions in `inventoryPanel.test.js` that pin four tabs. Replace `inventoryPanel.test.js:127-132`:

```js
  it("offers exactly the five tabs, All first and active by default", () => {
    const l = layoutInventory({ inventory: inv() });
    expect(l.tabs.map((t) => t.key)).toEqual(["all", "equip", "supply", "stones", "character"]);
    expect(l.tabs[0].active).toBe(true);
    for (const t of l.tabs) expect(l.hitAreas).toContainEqual({ x: t.x, y: t.y, w: t.w, h: t.h, kind: "invtab", id: t.key });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/markunn/worker/coding/jsgame/something2/frontend && npx vitest run src/games/something2/src/js/systems/__tests__/characterTab.test.js src/games/something2/src/js/systems/__tests__/inventoryPanel.test.js`

Expected: FAIL with `SyntaxError: The requested module '../characterTab.js' does not provide an export named 'layoutCharacterTab'`, and in `inventoryPanel.test.js` `expected [ 'all', 'equip', 'supply', 'stones' ] to deeply equal [ 'all', 'equip', 'supply', 'stones', 'character' ]`.

- [ ] **Step 3: Write the minimal implementation**

Append to `frontend/src/games/something2/src/js/systems/characterTab.js`:

```js
// --- Pane layout -----------------------------------------------------------
// Same contract as layoutInventory: rects and strings only, no context. The
// caller hands in the rectangle the panel has free (see inventoryPanel.js) and
// gets back everything drawCharacterTab needs to paint, plus the hit areas the
// panel must hoist so clicks route.

export const CHAR_LINE_H = 16;
export const CHAR_MOD_ROWS = 7;
const XP_TRACK_W = 300;
const XP_TRACK_H = 10;
const DERIVED_COL_DX = 300;
const STATS_DY = 52;
const HIGHLIGHT_DY = 152;
const POINTS_DY = 168;
const MODS_TITLE_DY = 190;
const MODS_DY = 208;
const ARROW_W = 24;
const ARROW_H = 16;

export function layoutCharacterTab({ character, x, y, w, h, modPage = 0 }) {
  const hitAreas = [];
  const empty = {
    x, y, w, h, loading: null, header: null, xp: null,
    statLines: [], highlight: null, points: null, derived: [], modifiers: null, hitAreas,
  };
  if (!character) {
    return { ...empty, loading: { text: "Loading character…", x, y } };
  }

  const header = { text: formatHeader(character), x, y };

  const loaded = xpLoaded(character);
  const bar = xpBar(character);
  const xp = {
    track: { x, y: y + 20, w: XP_TRACK_W, h: XP_TRACK_H },
    fillW: Math.round((XP_TRACK_W * Math.max(0, Math.min(100, bar.pct))) / 100),
    pct: bar.pct,
    label: formatXpLabel(bar, loaded),
    labelX: x,
    labelY: y + 34,
  };

  const { strong, weak } = strongAndWeak(character.sources, character.mainStat || null);
  const statLines = CHAR_STAT_KEYS.map((key, i) => ({
    key,
    text: formatStatBreakdown(key, character.sources ? character.sources[key] : null),
    x,
    y: y + STATS_DY + i * CHAR_LINE_H,
    strong: key === strong,
    weak: key === weak,
  }));

  const highlight = {
    text: formatHighlights(character.sources, character.mainStat || null),
    x, y: y + HIGHLIGHT_DY,
  };
  const points = { text: formatPoints(character.passivePoints), x, y: y + POINTS_DY };

  const derived = derivedRows(character.stats).map((text, i) => ({
    text, x: x + DERIVED_COL_DX, y: y + STATS_DY + i * CHAR_LINE_H,
  }));

  const allRows = modifierRows(character.modifiers);
  const pageCount = Math.max(1, Math.ceil(allRows.length / CHAR_MOD_ROWS));
  // Clamped rather than trusted, exactly as the item grid's page is: the page
  // survives an equipment change that shortened the list under it, and an
  // unclamped index would render an empty pane the player cannot page out of.
  const page = Math.min(Math.max(0, Math.floor(Number(modPage) || 0)), pageCount - 1);
  const rows = allRows
    .slice(page * CHAR_MOD_ROWS, page * CHAR_MOD_ROWS + CHAR_MOD_ROWS)
    .map((r, i) => ({ text: r.text, source: r.source, x, y: y + MODS_DY + i * CHAR_LINE_H }));

  const arrowY = y + MODS_DY + CHAR_MOD_ROWS * CHAR_LINE_H + 2;
  const prev = page > 0 ? { x, y: arrowY, w: ARROW_W, h: ARROW_H } : null;
  const next = page < pageCount - 1 ? { x: x + ARROW_W + 8, y: arrowY, w: ARROW_W, h: ARROW_H } : null;
  if (prev) hitAreas.push({ ...prev, kind: "charmodpage", id: page - 1 });
  if (next) hitAreas.push({ ...next, kind: "charmodpage", id: page + 1 });

  return {
    x, y, w, h,
    loading: null,
    header,
    xp,
    statLines,
    highlight,
    points,
    derived,
    modifiers: {
      title: { text: "Modifiers", x, y: y + MODS_TITLE_DY },
      rows, page, pageCount, prev, next,
    },
    hitAreas,
  };
}
```

Now edit `frontend/src/games/something2/src/js/systems/inventoryPanel.js`.

Add the import at the top, beside the existing ones (`inventoryPanel.js:5-6`):

```js
import { layoutCharacterTab } from "./characterTab.js";
```

Replace `TABS` (`inventoryPanel.js:53-58`):

```js
// `categories: null` means "everything not hidden" — an item whose category
// is new server-side lands under All rather than becoming invisible.
// `pane: "character"` marks the one tab that is NOT an item filter: it replaces
// the grid entirely (spec §10.2), so it must feed the grid an empty list rather
// than inherit `categories: null`'s "show everything".
export const TABS = [
  { key: "all", label: "All", categories: null },
  { key: "equip", label: "Equip", categories: ["weapon", "armor"] },
  { key: "supply", label: "Supply", categories: ["ammo", "consumable"] },
  { key: "stones", label: "Stones", categories: ["stone"] },
  { key: "character", label: "Character", categories: null, pane: "character" },
];
```

Add one line at the top of `visibleItems`'s filter (`inventoryPanel.js:60-70`), right after the `tab` lookup:

```js
export function visibleItems(inventory, tabKey) {
  const tab = TABS.find((t) => t.key === tabKey) || TABS[0];
  if (tab.pane === "character") return [];
  const types = (inventory && inventory.types) || new Map();
```

In `layoutInventory`, destructure the two new state fields (`inventoryPanel.js:72-81`):

```js
export function layoutInventory(state) {
  const {
    inventory,
    selectedItemId = null,
    gold = 0,
    autoLoot = false,
    tab = "all",
    page = 0,
    drag = null,
    character = null,
    modPage = 0,
  } = state;
```

Then, immediately before the `return` block (`inventoryPanel.js:172`), build the pane:

```js
  // The Character pane (spec §10.2) occupies exactly the rectangle the item
  // grid and its page arrows would have. Built here rather than in the draw so
  // its geometry and its strings are testable without a context, and so its
  // page arrows can be hoisted into the same hitAreas list every other control
  // uses. `shown` is empty on this tab (see visibleItems), so the grid loop
  // above has already produced 48 empty cells and no item hit areas.
  const characterPane = TABS.find((t) => t.key === activeTab).pane === "character"
    ? layoutCharacterTab({
        character,
        x: rightX,
        y: gridTop,
        w: PANEL_W - (rightX - px) - PAD,
        h: footerY - gridTop - 8,
        modPage,
      })
    : null;
  if (characterPane) for (const a of characterPane.hitAreas) hitAreas.push(a);

  return {
    panel, title, close, preview, slots,
    tabs,
    cells,
    character: characterPane,
    pages: { count: pageCount, page: pageIdx, prev, next, arrowY, x: rightX },
```

(the rest of the return object is unchanged).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/markunn/worker/coding/jsgame/something2/frontend && npx vitest run src/games/something2/src/js/systems/__tests__/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/characterTab.js frontend/src/games/something2/src/js/systems/inventoryPanel.js frontend/src/games/something2/src/js/systems/__tests__/characterTab.test.js frontend/src/games/something2/src/js/systems/__tests__/inventoryPanel.test.js
git commit -m "$(cat <<'EOF'
feat(sheet): character pane layout and the fifth inventory tab (SOMET-NNN)

layoutCharacterTab returns rects and strings only, matching layoutInventory's
existing pure-layout/canvas-draw split. The Character tab feeds the item grid
an empty list rather than inheriting "show everything", and its modifier pager
hoists its hit areas into the panel's own list.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15c: Draw the pane

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/characterTab.js` (append `drawCharacterTab`)
- Modify: `frontend/src/games/something2/src/js/systems/inventoryPanel.js:279-316` (guard the grid + arrows behind `!layout.character`, dispatch the pane)
- Test: `frontend/src/games/something2/src/js/systems/__tests__/characterTabDraw.test.js`

**Interfaces:**
- Consumes: `layoutCharacterTab`'s return value.
- Produces: `drawCharacterTab(ctx, pane)` — writes only; returns nothing.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/systems/__tests__/characterTabDraw.test.js`:

```js
// drawCharacterTab only ever writes to a context, so a recording stub is the
// whole test surface -- the same convention inventoryPanelDraw.test.js uses.
import { describe, it, expect } from "vitest";
import { layoutInventory, drawInventory } from "../inventoryPanel.js";
import { layoutCharacterTab, drawCharacterTab } from "../characterTab.js";

function stubCtx() {
  const fillRects = [], texts = [], images = [];
  return {
    fillRects, texts, images,
    save() {}, restore() {},
    fillRect(x, y, w, h) { fillRects.push({ x, y, w, h }); },
    strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
    fillText(text, x, y) { texts.push({ text, x, y }); },
    drawImage(img, x, y, w, h) { images.push({ x, y, w, h }); },
    measureText(t) { return { width: String(t).length * 6 }; },
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set font(_v) {},
    set lineWidth(_v) {}, set textAlign(_v) {}, set textBaseline(_v) {},
    set globalAlpha(_v) {},
  };
}

function inv() {
  return { types: new Map(), items: [], equipment: {}, ammoCounts: new Map(), capacity: 48 };
}

const CHARACTER = {
  className: "Warrior",
  mainStat: "strength",
  level: 7,
  experience: 102,
  xpFloor: 63,
  xpToNext: 78,
  passivePoints: 3,
  sources: {
    strength:     { base: 5, tree: 33, gear: 4 },
    dexterity:    { base: 5, tree: 6,  gear: 0 },
    constitution: { base: 8, tree: 4,  gear: 2 },
    intelligence: { base: 5, tree: 0,  gear: 0 },
    wisdom:       { base: 6, tree: 2,  gear: 0 },
    charisma:     { base: 5, tree: 0,  gear: 0 },
  },
  modifiers: [
    { label: "Increased Projectile Damage", value: 12, source: "tree", kind: "damage", detail: "%" },
    { label: "Strength", value: 4, source: "gear", kind: "stat" },
  ],
  stats: {
    maxHp: 140, maxMana: 100, meleeMult: 1.15, spellMult: 1,
    cooldownMult: 0.8696, manaRegen: 10, priceMult: 0.55,
  },
};

const FRESH = {
  className: "Mage", mainStat: "intelligence", level: 1, experience: 0,
  xpFloor: 0, xpToNext: 18, passivePoints: 0,
  sources: {
    strength: { base: 5, tree: 0, gear: 0 }, dexterity: { base: 5, tree: 0, gear: 0 },
    constitution: { base: 5, tree: 0, gear: 0 }, intelligence: { base: 5, tree: 0, gear: 0 },
    wisdom: { base: 5, tree: 0, gear: 0 }, charisma: { base: 5, tree: 0, gear: 0 },
  },
  modifiers: [],
  stats: { maxHp: 100, maxMana: 100, meleeMult: 1, spellMult: 1, cooldownMult: 1, manaRegen: 10, priceMult: 0.5 },
};

describe("drawCharacterTab", () => {
  it("writes the header, every itemised stat, the derived block and the modifier list", () => {
    const ctx = stubCtx();
    drawCharacterTab(ctx, layoutCharacterTab({ x: 300, y: 200, w: 528, h: 340, character: CHARACTER }));
    const said = ctx.texts.map((t) => t.text);
    expect(said).toContain("Warrior — Level 7");
    expect(said).toContain("STR 42 = 5 base + 33 tree + 4 gear");
    expect(said).toContain("CHA 5 = 5 base");
    expect(said).toContain("Max HP        140");
    expect(said).toContain("Sell price    x0.55");
    expect(said).toContain("Strong: STR 42    Weak: INT 5");
    expect(said).toContain("Passive points: 3");
    expect(said).toContain("39 / 78 XP");
    expect(said).toContain("Increased Projectile Damage  +12%");
    expect(said).toContain("Strength  +4");
    expect(said).toContain("tree");
    expect(said).toContain("gear");
  });

  it("draws the XP fill proportional to progress, inside the track", () => {
    const pane = layoutCharacterTab({ x: 300, y: 200, w: 528, h: 340, character: CHARACTER });
    const ctx = stubCtx();
    drawCharacterTab(ctx, pane);
    const fill = ctx.fillRects.find((r) => r.y === pane.xp.track.y && r.w === pane.xp.fillW);
    expect(fill).toBeDefined();                 // 50% of a 300px track
    expect(pane.xp.fillW).toBe(150);
    expect(fill.x + fill.w).toBeLessThanOrEqual(pane.xp.track.x + pane.xp.track.w);
  });

  it("renders a fresh level-1 character with no passives and no affixes", () => {
    const ctx = stubCtx();
    drawCharacterTab(ctx, layoutCharacterTab({ x: 300, y: 200, w: 528, h: 340, character: FRESH }));
    const said = ctx.texts.map((t) => t.text);
    expect(said).toContain("Mage — Level 1");
    expect(said).toContain("INT 5 = 5 base");
    expect(said).toContain("Strong: INT 5    Weak: —");
    expect(said).toContain("No modifiers yet — allocate passives or equip gear.");
    expect(said).not.toContain("tree");
    expect(said).not.toContain("gear");
  });

  it("says it is loading when no character view has arrived", () => {
    const ctx = stubCtx();
    drawCharacterTab(ctx, layoutCharacterTab({ x: 300, y: 200, w: 528, h: 340, character: null }));
    expect(ctx.texts.map((t) => t.text)).toEqual(["Loading character…"]);
  });
});

describe("drawInventory dispatch", () => {
  it("paints the character pane, and no item grid, on the Character tab", () => {
    const i = inv();
    i.types = new Map([[1, { id: 1, name: "short sword", category: "weapon", slot: "main_hand" }]]);
    i.items = [{ id: "w", typeId: 1, quantity: 1 }];
    const state = { inventory: i, tab: "character", character: CHARACTER };
    const ctx = stubCtx();
    drawInventory(ctx, layoutInventory(state), state);
    const said = ctx.texts.map((t) => t.text);
    expect(said).toContain("Warrior — Level 7");
    expect(said).not.toContain("SH");   // the sword cell's initials
  });

  it("still paints the item grid on every other tab", () => {
    const i = inv();
    i.types = new Map([[1, { id: 1, name: "short sword", category: "weapon", slot: "main_hand" }]]);
    i.items = [{ id: "w", typeId: 1, quantity: 1 }];
    const state = { inventory: i, tab: "all", character: CHARACTER };
    const ctx = stubCtx();
    drawInventory(ctx, layoutInventory(state), state);
    const said = ctx.texts.map((t) => t.text);
    expect(said).toContain("SH");
    expect(said).not.toContain("Warrior — Level 7");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/markunn/worker/coding/jsgame/something2/frontend && npx vitest run src/games/something2/src/js/systems/__tests__/characterTabDraw.test.js`

Expected: FAIL with `SyntaxError: The requested module '../characterTab.js' does not provide an export named 'drawCharacterTab'`

- [ ] **Step 3: Write the minimal implementation**

Append to `frontend/src/games/something2/src/js/systems/characterTab.js`:

```js
// --- Draw ------------------------------------------------------------------
// The ONLY function in this module that touches a context. It decides nothing:
// every string and every rect it paints came out of layoutCharacterTab.
// Palette matches the panel's (inventoryPanel.js) rather than the admin
// tokens -- the game canvas is deliberately hardcoded dark, per
// .ai/styleguides/frontend.md.

const TEXT = "#e5e7eb";
const MUTED = "#9ca3af";
const STRONG_COLOR = "#86efac";
const WEAK_COLOR = "#fca5a5";
const ACCENT = "#4a9eff";
const SOURCE_COLOR = { tree: "#c4b5fd", gear: "#fcd34d" };

export function drawCharacterTab(ctx, pane) {
  if (!pane) return;

  if (pane.loading) {
    ctx.font = "12px monospace";
    ctx.fillStyle = MUTED;
    ctx.fillText(pane.loading.text, pane.loading.x, pane.loading.y);
    return;
  }

  ctx.font = "14px monospace";
  ctx.fillStyle = TEXT;
  ctx.fillText(pane.header.text, pane.header.x, pane.header.y);

  // XP bar: track then fill, so a 0% fill paints nothing over the track.
  const t = pane.xp.track;
  ctx.fillStyle = "rgba(25,25,38,0.9)";
  ctx.fillRect(t.x, t.y, t.w, t.h);
  ctx.strokeStyle = "#3a3a4e";
  ctx.strokeRect(t.x, t.y, t.w, t.h);
  if (pane.xp.fillW > 0) {
    ctx.fillStyle = ACCENT;
    ctx.fillRect(t.x, t.y, pane.xp.fillW, t.h);
  }
  ctx.font = "11px monospace";
  ctx.fillStyle = MUTED;
  ctx.fillText(pane.xp.label, pane.xp.labelX, pane.xp.labelY);

  for (const line of pane.statLines) {
    ctx.fillStyle = line.strong ? STRONG_COLOR : line.weak ? WEAK_COLOR : TEXT;
    ctx.fillText(line.text, line.x, line.y);
  }

  ctx.fillStyle = MUTED;
  for (const row of pane.derived) ctx.fillText(row.text, row.x, row.y);

  ctx.fillStyle = TEXT;
  ctx.fillText(pane.highlight.text, pane.highlight.x, pane.highlight.y);
  ctx.fillStyle = "#facc15";
  ctx.fillText(pane.points.text, pane.points.x, pane.points.y);

  const m = pane.modifiers;
  ctx.fillStyle = MUTED;
  ctx.fillText(m.title.text, m.title.x, m.title.y);
  for (const row of m.rows) {
    ctx.fillStyle = TEXT;
    ctx.fillText(row.text, row.x, row.y);
    if (row.source) {
      // The source tag is the point of the list (spec §10.2: "every active
      // modifier WITH ITS SOURCE"), so it gets its own colour and a fixed
      // right-hand column rather than being appended to the text.
      ctx.fillStyle = SOURCE_COLOR[row.source] || MUTED;
      ctx.fillText(row.source, pane.x + pane.w - 44, row.y);
    }
  }

  for (const [rect, label] of [[m.prev, "<"], [m.next, ">"]]) {
    if (!rect) continue;
    ctx.fillStyle = "rgba(40,40,60,0.85)";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = ACCENT;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = TEXT;
    ctx.fillText(label, rect.x + 8, rect.y + 3);
  }
  if (m.pageCount > 1) {
    ctx.fillStyle = MUTED;
    ctx.fillText(`page ${m.page + 1}/${m.pageCount}`, pane.x + 64, m.rows.length
      ? m.rows[m.rows.length - 1].y + CHAR_LINE_H + 5
      : m.title.y);
  }
}
```

Add the import to `inventoryPanel.js` (extend the line added in 15b):

```js
import { layoutCharacterTab, drawCharacterTab } from "./characterTab.js";
```

In `drawInventory`, wrap the grid and the page arrows and dispatch the pane. Replace `inventoryPanel.js:279-316` (the `// Grid.` block through the `page N/M` label) with:

```js
  // Grid, or the Character pane in its place. `layout.character` is non-null
  // only on the Character tab, and on that tab `layout.cells` is already all
  // empty and both page arrows are already null -- the branch is here so a
  // reader does not have to derive that, not because the loops would misbehave.
  if (layout.character) {
    drawCharacterTab(ctx, layout.character);
  } else {
    for (const c of layout.cells) {
      const dragged = drag && c.item && drag.itemId === c.item.id;
      ctx.fillStyle = c.item ? (CATEGORY_TINT[c.type && c.type.category] || "rgba(55,55,70,0.9)") : "rgba(25,25,38,0.9)";
      ctx.globalAlpha = dragged ? 0.3 : 1;
      ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.strokeStyle = c.selected ? "#4a9eff" : "#2a2a3a";
      ctx.strokeRect(c.x, c.y, c.w, c.h);
      if (c.item) {
        ctx.fillStyle = "#e5e7eb";
        ctx.font = "14px monospace";
        ctx.fillText(initials(c.type && c.type.name), c.x + 8, c.y + 14);
        // Only a real STACK is badged: a "1" on every single item is noise, and
        // the reference screenshot badges the same way.
        if (c.item.quantity > 1) {
          ctx.font = "10px monospace";
          ctx.fillStyle = "#fde68a";
          ctx.fillText(String(c.item.quantity), c.x + c.w - 16, c.y + c.h - 12);
        }
      }
      ctx.globalAlpha = 1;
    }

    // Page arrows.
    ctx.font = "12px monospace";
    for (const [rect, label] of [[layout.pages.prev, "<"], [layout.pages.next, ">"]]) {
      if (!rect) continue;
      ctx.fillStyle = "rgba(40,40,60,0.85)";
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.strokeStyle = "#4a9eff";
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = "#e5e7eb";
      ctx.fillText(label, rect.x + 12, rect.y + 6);
    }
    if (layout.pages.count > 1) {
      ctx.fillStyle = "#9ca3af";
      ctx.fillText(`page ${layout.pages.page + 1}/${layout.pages.count}`, layout.pages.x + 84, layout.pages.arrowY + 6);
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/markunn/worker/coding/jsgame/something2/frontend && npx vitest run src/games/something2/src/js/systems/__tests__/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/characterTab.js frontend/src/games/something2/src/js/systems/inventoryPanel.js frontend/src/games/something2/src/js/systems/__tests__/characterTabDraw.test.js
git commit -m "$(cat <<'EOF'
feat(sheet): draw the character pane (SOMET-NNN)

drawCharacterTab paints only what layoutCharacterTab returned and decides
nothing itself. drawInventory dispatches to it on the Character tab in place
of the item grid and its page arrows.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15d: Wire the extended websocket frame into the panel

**Files:**
- Create: `frontend/src/games/something2/src/js/core/progressionExtras.js`
- Create: `frontend/src/games/something2/src/js/core/__tests__/progressionExtras.test.js`
- Modify: `frontend/src/games/something2/src/js/core/Game.js` — `:95-124` (constructor state), `:311` (`initChunked` signature), `:355-375` (join reset), `:489` (`onProgression`), `:879-887` (`inventoryView`), `:956-1005` (`_handleInventoryClick`)
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js:1213-1231`
- Modify: `frontend/src/games/something2/GameShell.jsx:415-423`

**Interfaces:**
- Consumes: the `progression` websocket frame (contract §4: gains `passivePoints`, `allocatedNodeIds`, `sources`, `modifiers`; carries `stats` on the `refreshPlayerStats` path), and the `GET /api/progression` bundle (contract §3: `progression`, `stats`, `xpFloor`, `xpToNext`, `respecCost`, plus the four new fields) through the existing `fetchProgression` in `src/js/net/progressionClient.js:35`.
- Produces:
  - `emptyExtras() -> { sources, modifiers, stats, passivePoints, allocatedNodeIds, xpFloor, xpToNext, respecCost }`
  - `frameCarriesExtras(msg) -> boolean`
  - `mergeFrameExtras(extras, msg) -> extras`
  - `mergeSeedExtras(extras, bundle, latched) -> extras`
  - `mergeLevelInfo(extras, bundle) -> extras`
  - `buildCharacterView({ progression, extras, className, mainStat }) -> characterView|null`
  - `Game.characterModPage`, `Game._refreshProgressionBundle()`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/core/__tests__/progressionExtras.test.js`:

```js
// The progression side-channel (SOMET-NNN). CharacterSheet.jsx's F1 header
// documented a race that was fixed by making the websocket 'progression'
// handler the SINGLE writer of progression state, and F2 documented a deleted
// xpCurve.js that re-implemented backend formulas client-side.
//
// This module is where both lessons are enforced now:
//  - progression itself is never written here at all (Game's onProgression
//    still owns it outright);
//  - the HTTP bundle may SEED sources/modifiers/stats exactly once, and is
//    latched off permanently the moment any socket frame has carried them, so
//    a late HTTP response can never overwrite a newer push;
//  - xpFloor/xpToNext/respecCost are copied from the server, never computed.
import { describe, it, expect } from "vitest";
import {
  emptyExtras, frameCarriesExtras, mergeFrameExtras, mergeSeedExtras,
  mergeLevelInfo, buildCharacterView,
} from "../progressionExtras.js";

const SOURCES = {
  strength:     { base: 5, tree: 33, gear: 4 },
  dexterity:    { base: 5, tree: 6,  gear: 0 },
  constitution: { base: 8, tree: 4,  gear: 2 },
  intelligence: { base: 5, tree: 0,  gear: 0 },
  wisdom:       { base: 6, tree: 2,  gear: 0 },
  charisma:     { base: 5, tree: 0,  gear: 0 },
};
const STATS = {
  maxHp: 140, maxMana: 100, meleeMult: 1.15, spellMult: 1,
  cooldownMult: 0.8696, manaRegen: 10, priceMult: 0.55,
};

describe("emptyExtras", () => {
  it("starts with nothing known and no curve numbers invented", () => {
    expect(emptyExtras()).toEqual({
      sources: null, modifiers: [], stats: null, passivePoints: 0,
      allocatedNodeIds: [], xpFloor: null, xpToNext: null, respecCost: null,
    });
  });
});

describe("frameCarriesExtras", () => {
  it("is false for a bare kill-XP push", () => {
    expect(frameCarriesExtras({ type: "progression", progression: { level: 2 }, awarded: 30 })).toBe(false);
  });
  it("is true once the frame carries any of the four new fields", () => {
    expect(frameCarriesExtras({ progression: {}, sources: SOURCES })).toBe(true);
    expect(frameCarriesExtras({ progression: {}, modifiers: [] })).toBe(true);
    expect(frameCarriesExtras({ progression: {}, passivePoints: 0 })).toBe(true);
    expect(frameCarriesExtras({ progression: {}, allocatedNodeIds: [] })).toBe(true);
  });
  it("is true for the allocate/respec push, which also carries derived stats", () => {
    expect(frameCarriesExtras({ progression: {}, stats: STATS })).toBe(true);
  });
});

describe("mergeFrameExtras", () => {
  it("takes every field the frame carried", () => {
    const merged = mergeFrameExtras(emptyExtras(), {
      progression: { level: 7 },
      sources: SOURCES,
      modifiers: [{ label: "Strength", value: 4, source: "gear", kind: "stat" }],
      passivePoints: 3,
      allocatedNodeIds: [11, 12],
      stats: STATS,
    });
    expect(merged.sources).toEqual(SOURCES);
    expect(merged.modifiers).toEqual([{ label: "Strength", value: 4, source: "gear", kind: "stat" }]);
    expect(merged.passivePoints).toBe(3);
    expect(merged.allocatedNodeIds).toEqual([11, 12]);
    expect(merged.stats).toEqual(STATS);
  });

  it("keeps what a partial frame did not mention", () => {
    // A kill-XP push carries no `stats` (server.js:796) -- the last known
    // bundle must survive it rather than blanking the derived-stat block.
    const seeded = mergeFrameExtras(emptyExtras(), { progression: {}, sources: SOURCES, stats: STATS });
    const after = mergeFrameExtras(seeded, { progression: { level: 8 }, passivePoints: 4 });
    expect(after.stats).toEqual(STATS);
    expect(after.sources).toEqual(SOURCES);
    expect(after.passivePoints).toBe(4);
  });

  it("never invents a curve number", () => {
    const merged = mergeFrameExtras(emptyExtras(), { progression: { level: 7 }, sources: SOURCES });
    expect(merged.xpFloor).toBeNull();
    expect(merged.xpToNext).toBeNull();
  });
});

describe("mergeSeedExtras (F1: the HTTP bundle seeds ONCE and is latched off)", () => {
  const BUNDLE = {
    progression: { level: 1, experience: 0 },
    sources: SOURCES, modifiers: [], passivePoints: 2,
    allocatedNodeIds: [1], stats: STATS,
    xpFloor: 63, xpToNext: 78, respecCost: 350,
  };

  it("seeds everything when no socket frame has carried extras yet", () => {
    const seeded = mergeSeedExtras(emptyExtras(), BUNDLE, false);
    expect(seeded.sources).toEqual(SOURCES);
    expect(seeded.stats).toEqual(STATS);
    expect(seeded.passivePoints).toBe(2);
    expect(seeded.allocatedNodeIds).toEqual([1]);
  });

  it("is a NO-OP once a socket frame has carried extras -- the exact F1 race", () => {
    // The reviewer's own reproduction, transposed: the player allocates a
    // node; before the HTTP response lands, the server's websocket push
    // arrives with the POST-allocation breakdown. The late HTTP response then
    // tries to apply a PRE-allocation snapshot. It must not win.
    const fromSocket = mergeFrameExtras(emptyExtras(), {
      progression: { level: 7 },
      sources: SOURCES, passivePoints: 3, allocatedNodeIds: [11, 12, 13],
    });
    const stale = mergeSeedExtras(fromSocket, {
      sources: { strength: { base: 5, tree: 0, gear: 0 } },
      passivePoints: 99, allocatedNodeIds: [], stats: null,
    }, true);
    expect(stale.sources).toEqual(SOURCES);
    expect(stale.passivePoints).toBe(3);
    expect(stale.allocatedNodeIds).toEqual([11, 12, 13]);
  });

  it("never carries a progression row of its own", () => {
    const seeded = mergeSeedExtras(emptyExtras(), BUNDLE, false);
    expect(seeded.progression).toBeUndefined();
  });
});

describe("mergeLevelInfo (F2: the curve numbers come from the server, always)", () => {
  it("applies xpFloor/xpToNext/respecCost even when the seed is latched off", () => {
    // These three are a function of LEVEL and no websocket frame carries them,
    // so there is no second writer to race -- unlike sources/modifiers/stats.
    const latched = mergeFrameExtras(emptyExtras(), { progression: {}, sources: SOURCES });
    const after = mergeLevelInfo(latched, { xpFloor: 63, xpToNext: 78, respecCost: 350 });
    expect(after.xpFloor).toBe(63);
    expect(after.xpToNext).toBe(78);
    expect(after.respecCost).toBe(350);
    expect(after.sources).toEqual(SOURCES);
  });

  it("keeps null for a max-level xpToNext, which JSON encodes as null", () => {
    const after = mergeLevelInfo(emptyExtras(), { xpFloor: 900000, xpToNext: null, respecCost: 7500 });
    expect(after.xpFloor).toBe(900000);
    expect(after.xpToNext).toBeNull();
  });
});

describe("buildCharacterView", () => {
  it("is null before the first join lands", () => {
    expect(buildCharacterView({ progression: null, extras: emptyExtras(), className: "Warrior", mainStat: "strength" }))
      .toBeNull();
  });

  it("assembles exactly what the panel's layout consumes", () => {
    const extras = mergeLevelInfo(
      mergeFrameExtras(emptyExtras(), {
        progression: {}, sources: SOURCES, modifiers: [], passivePoints: 3,
        allocatedNodeIds: [11], stats: STATS,
      }),
      { xpFloor: 63, xpToNext: 78, respecCost: 350 },
    );
    expect(buildCharacterView({
      progression: { level: 7, experience: 102 },
      extras, className: "Warrior", mainStat: "strength",
    })).toEqual({
      className: "Warrior",
      mainStat: "strength",
      level: 7,
      experience: 102,
      xpFloor: 63,
      xpToNext: 78,
      passivePoints: 3,
      sources: SOURCES,
      modifiers: [],
      stats: STATS,
    });
  });

  it("tolerates an unknown main stat (B/T3 has not landed yet)", () => {
    const view = buildCharacterView({
      progression: { level: 1, experience: 0 },
      extras: emptyExtras(), className: "Warrior", mainStat: undefined,
    });
    expect(view.mainStat).toBeNull();
    expect(view.className).toBe("Warrior");
  });
});
```

Append to `frontend/src/games/something2/src/js/core/__tests__/progressionSnapshot.test.js`:

```js
// Task 15d: the Character tab's click targets and its own state, exercised
// against a hand-built `this` for the same reason the snapshot tests above
// are -- constructing a full Game needs a canvas.
describe("Character tab click routing", () => {
  function makeGame() {
    globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
    const g = new Game();
    g.state = "playing";
    g.chunked = true;
    g.inventoryOpen = true;
    g.renderSystem = { _invHitAreas: [] };
    // The HTTP seed is fire-and-forget and irrelevant to routing; stub it so
    // these cases never touch the network.
    g._refreshProgressionBundle = () => {};
    return g;
  }

  it("turns the modifier list's page", () => {
    const g = makeGame();
    g.renderSystem._invHitAreas = [{ x: 0, y: 0, w: 10, h: 10, kind: "charmodpage", id: 1 }];
    g._handleInventoryClick(1, 1);
    expect(g.characterModPage).toBe(1);
  });

  it("resets the modifier page when the tab changes", () => {
    const g = makeGame();
    g.characterModPage = 3;
    g.renderSystem._invHitAreas = [{ x: 0, y: 0, w: 10, h: 10, kind: "invtab", id: "stones" }];
    g._handleInventoryClick(1, 1);
    expect(g.characterModPage).toBe(0);
  });

  it("starts with an empty extras bundle and no invented curve numbers", () => {
    const g = makeGame();
    expect(g.progressionExtras).toEqual({
      sources: null, modifiers: [], stats: null, passivePoints: 0,
      allocatedNodeIds: [], xpFloor: null, xpToNext: null, respecCost: null,
    });
    expect(g.characterModPage).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/markunn/worker/coding/jsgame/something2/frontend && npx vitest run src/games/something2/src/js/core/__tests__/progressionExtras.test.js src/games/something2/src/js/core/__tests__/progressionSnapshot.test.js`

Expected: FAIL with `Failed to resolve import "../progressionExtras.js"`, and `expected undefined to be 1` for `g.characterModPage`.

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/src/games/something2/src/js/core/progressionExtras.js`:

```js
// The progression side-channel the Character tab reads (SOMET-NNN). PURE:
// no fetch, no clock, no Game -- every rule below is a unit test.
//
// WHY THIS IS A SEPARATE MODULE FROM Game.progression.
// CharacterSheet.jsx's F1 header (deleted with the popup; the reasoning is
// reproduced here because it is still load-bearing) documented a real,
// browser-reproduced race: the HTTP allocate response travels on a brand-new
// connection with NO ordering guarantee against a websocket push sent moments
// earlier, so a late, stale HTTP response overwrote a newer level-up. It was
// fixed by removing the second writer, not by guessing an ordering predicate
// -- and NOT by an "only apply if experience increased" guard, because death
// LOWERS experience, so that predicate is wrong in the other direction.
//
// `progression` itself still has exactly one writer (Game's onProgression).
// This module governs the FIELDS AROUND it, and applies the same rule in the
// only shape that works for them:
//   - sources / modifiers / stats / passivePoints / allocatedNodeIds have TWO
//     possible sources (the socket frame and the HTTP bundle), so the HTTP one
//     is a one-shot SEED that is latched off forever once a socket frame has
//     carried them. After the latch there is exactly one writer again.
//   - xpFloor / xpToNext / respecCost have exactly ONE source (the HTTP
//     bundle -- no websocket frame carries them), so there is nothing to race
//     and they are applied unconditionally. They are COPIED, never computed:
//     that is the F2 lesson, and the reason xpCurve.js was deleted.

export function emptyExtras() {
  return {
    sources: null,
    modifiers: [],
    stats: null,
    passivePoints: 0,
    allocatedNodeIds: [],
    xpFloor: null,
    xpToNext: null,
    respecCost: null,
  };
}

const EXTRA_FIELDS = ["sources", "modifiers", "stats", "passivePoints", "allocatedNodeIds"];

export function frameCarriesExtras(msg) {
  if (!msg) return false;
  return EXTRA_FIELDS.some((k) => msg[k] !== undefined);
}

// Field-by-field, so a partial frame (a kill-XP push carries no `stats`)
// leaves the last known value in place instead of blanking the block.
function take(extras, src) {
  const next = { ...extras };
  for (const k of EXTRA_FIELDS) {
    if (src[k] !== undefined) next[k] = src[k];
  }
  return next;
}

export function mergeFrameExtras(extras, msg) {
  return take(extras || emptyExtras(), msg || {});
}

export function mergeSeedExtras(extras, bundle, latched) {
  const base = extras || emptyExtras();
  if (latched || !bundle) return base;
  return take(base, bundle);
}

export function mergeLevelInfo(extras, bundle) {
  const base = extras || emptyExtras();
  if (!bundle) return base;
  return {
    ...base,
    xpFloor: bundle.xpFloor !== undefined ? bundle.xpFloor : base.xpFloor,
    xpToNext: bundle.xpToNext !== undefined ? bundle.xpToNext : base.xpToNext,
    respecCost: bundle.respecCost !== undefined ? bundle.respecCost : base.respecCost,
  };
}

// The one object the inventory panel's Character pane consumes. Null before
// the first join lands, so the pane renders its own "Loading character…".
export function buildCharacterView({ progression, extras, className, mainStat }) {
  if (!progression) return null;
  const e = extras || emptyExtras();
  return {
    className: className || null,
    mainStat: mainStat || null,
    level: progression.level,
    experience: progression.experience,
    xpFloor: e.xpFloor,
    xpToNext: e.xpToNext,
    passivePoints: e.passivePoints,
    sources: e.sources,
    modifiers: e.modifiers,
    stats: e.stats,
  };
}
```

Now edit `frontend/src/games/something2/src/js/core/Game.js`.

Add to the import block at the top of the file:

```js
import {
  emptyExtras, frameCarriesExtras, mergeFrameExtras, mergeSeedExtras,
  mergeLevelInfo, buildCharacterView,
} from './progressionExtras.js';
import { fetchProgression } from '../net/progressionClient.js';
```

Replace the constructor's progression block (`Game.js:119-124`):

```js
        // Progression (SOMET-242, extended by SOMET-NNN): the raw
        // player_progression row (level, experience, the six class-base stat
        // columns) -- set from `joined.progression` and refreshed by
        // `progression` push messages (kill XP, level-up, death, allocate,
        // respec). null until the first join lands. EXACTLY ONE WRITER: the
        // websocket handler in initChunked. See progressionExtras.js for why.
        this.progression = null;
        // Everything the Character tab shows AROUND that row: the itemised
        // sources/modifiers from composeStats, the derived-stat bundle, the
        // passive-point total, and the server's own xpFloor/xpToNext/
        // respecCost. Never computed here -- see progressionExtras.js.
        this.progressionExtras = emptyExtras();
        // Latched true the first time a websocket frame carries the extras,
        // after which the HTTP bundle may no longer seed them (the F1 race).
        this._extrasFromSocket = false;
        this._progressionBundleBusy = false;
        // The Character tab's own paging state, beside inventoryTab/Page.
        this.characterModPage = 0;
        // Class identity for the Character tab's header and its strong/weak
        // tie-break. Supplied by GameShell from the resolved activeCharacter
        // rather than the wire: listCharacters already sends both.
        this.className = null;
        this.mainStat = null;
```

Extend `initChunked`'s options (`Game.js:311`):

```js
    async initChunked({ worldId, characterId, chunkSize, tileTypes, vfxEffects = null, entityTypes = null, spawnX = 0, spawnY = 0, className = null, mainStat = null }) {
```

In the join reset block, replace `Game.js:375` (`this.progression = null;`) with:

```js
        this.progression = null;
        this.progressionExtras = emptyExtras();
        this._extrasFromSocket = false;
        this.characterModPage = 0;
        this.className = className;
        this.mainStat = mainStat;
```

Replace the `onProgression` handler (`Game.js:489`):

```js
                // Kill XP / level-up / death / allocate / respec pushes. This
                // is still the SINGLE writer of this.progression -- an
                // unconditional overwrite on the one channel that has a real
                // ordering guarantee (see progressionExtras.js's header, and
                // applyGoldResult's below).
                //
                // The extras ride the same frame when the server has them
                // (contract §4) and latch the HTTP seed off once they do.
                // A level change triggers ONE targeted refetch of the
                // level-dependent xpFloor/xpToNext/respecCost -- a level-up
                // is a real event, not the no-op push the original sheet was
                // required not to refetch on.
                onProgression: (msg) => {
                    if (!msg || !msg.progression) return;
                    const prevLevel = this.progression ? this.progression.level : null;
                    this.progression = msg.progression;
                    if (frameCarriesExtras(msg)) {
                        this.progressionExtras = mergeFrameExtras(this.progressionExtras, msg);
                        this._extrasFromSocket = true;
                    }
                    if (msg.progression.level !== prevLevel) this._refreshProgressionBundle();
                },
```

Add the fetch helper next to `applyGoldResult` (after `Game.js:708`):

```js
    // One HTTP read of GET /api/progression, fired when the Character tab is
    // opened and again when the level actually changes. It writes ONLY
    // progressionExtras -- never this.progression, which would reintroduce the
    // F1 race this file's applyGoldResult comment describes. The
    // sources/modifiers/stats half is additionally latched off once a socket
    // frame has carried them (mergeSeedExtras), so a late response can never
    // overwrite a newer push. xpFloor/xpToNext/respecCost have no websocket
    // sender at all, so they are applied unconditionally.
    _refreshProgressionBundle() {
        if (this._progressionBundleBusy) return;
        this._progressionBundleBusy = true;
        fetchProgression()
            .then((bundle) => {
                if (!bundle) return;
                this.progressionExtras = mergeLevelInfo(this.progressionExtras, bundle);
                this.progressionExtras = mergeSeedExtras(
                    this.progressionExtras, bundle, this._extrasFromSocket,
                );
            })
            .catch(() => { /* the next tab-open or level-up retries */ })
            .finally(() => { this._progressionBundleBusy = false; });
    }
```

Extend the `inventoryView` payload (`Game.js:881-888`):

```js
                inventoryView: {
                    tab: this.inventoryTab,
                    page: this.inventoryPage,
                    gold: this.gold,
                    drag: this.inventoryDrag,
                    hoverX: this._cursorX ?? null,
                    hoverY: this._cursorY ?? null,
                    character: buildCharacterView({
                        progression: this.progression,
                        extras: this.progressionExtras,
                        className: this.className,
                        mainStat: this.mainStat,
                    }),
                    modPage: this.characterModPage,
                },
```

In `_handleInventoryClick`, extend the `invtab` branch and add the pager (`Game.js:984-988`):

```js
        if (hit.kind === 'invtab') {
            // Page resets with the tab: page 3 of All is very likely past the
            // end of Stones, and the layout would clamp it to 0 anyway — doing
            // it here keeps the state and the render agreeing. The Character
            // tab's own modifier page resets for the same reason.
            this.inventoryTab = hit.id;
            this.inventoryPage = 0;
            this.characterModPage = 0;
            if (hit.id === 'character') this._refreshProgressionBundle();
            return;
        }
        if (hit.kind === 'invpage') { this.inventoryPage = hit.id; return; }
        if (hit.kind === 'charmodpage') { this.characterModPage = hit.id; return; }
```

Extend `RenderSystem.renderInventory`'s state (`RenderSystem.js:1215-1226`), adding two lines:

```js
      hoverY: v.hoverY ?? null,
      character: v.character || null,
      modPage: v.modPage || 0,
      playerImage: this.imageManager ? this.imageManager.get("player") : null,
```

Extend the `initChunked` call in `GameShell.jsx:415-423`:

```js
      await gameRef.current.initChunked({
        worldId,
        characterId: activeCharacter.id,
        // The Character tab's header and its strong/weak tie-break. Already on
        // the resolved character (listCharacters selects e.name AS class_name;
        // mainStat arrives with B/T3's entity_types.main_stat and is null-safe
        // until then), so neither needs a wire field of its own.
        className: activeCharacter.className || null,
        mainStat: activeCharacter.mainStat || null,
        chunkSize,
        tileTypes: mapTiles,
        vfxEffects: vfxEffects || null,
        entityTypes: mapConfig?.entityTypes || null,
        spawnX: spawn,
        spawnY: spawn,
      });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/markunn/worker/coding/jsgame/something2/frontend && npx vitest run src/games/something2/src/js/core/__tests__/ src/games/something2/src/js/systems/__tests__/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/core/progressionExtras.js frontend/src/games/something2/src/js/core/__tests__/progressionExtras.test.js frontend/src/games/something2/src/js/core/__tests__/progressionSnapshot.test.js frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/src/js/systems/RenderSystem.js frontend/src/games/something2/GameShell.jsx
git commit -m "$(cat <<'EOF'
feat(sheet): feed the character tab from the progression frame (SOMET-NNN)

sources/modifiers/passivePoints/allocatedNodeIds and the derived-stat bundle
ride the existing websocket 'progression' frame, which stays the single writer
of Game.progression. GET /api/progression seeds them ONCE and is latched off
the moment a socket frame carries them, so the F1 cross-channel race cannot
come back; xpFloor/xpToNext/respecCost are copied from the server, never
recomputed (F2).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15e: Delete the popup, migrate its tests, rebind `C`

**Files:**
- Delete: `frontend/src/games/something2/CharacterSheet.jsx`
- Delete: `frontend/src/games/something2/src/js/__tests__/characterSheet.test.js`
- Create: `frontend/src/games/something2/src/js/net/__tests__/progressionClient.test.js`
- Modify: `frontend/src/games/something2/GameView.jsx:13` and `:256`
- Modify: `frontend/src/games/something2/src/js/core/Game.js:1066-1072` (add the `C` branch)
- Modify: `frontend/src/games/something2/__tests__/hotkeyRegistry.test.js:105-113`
- Modify: `frontend/src/games/something2/src/js/core/__tests__/progressionSnapshot.test.js` (comments at `:1-5` and `:102-106`)
- Modify: `frontend/src/games/something2/src/js/net/progressionClient.js:16` (comment)

**What happens to each describe in `characterSheet.test.js`, individually:**

| Describe (line) | Fate | Why |
|---|---|---|
| `xpProgress` (`:42-79`) | **Migrated** to `characterTab.test.js`'s `xpBar` block in Task 15a | Same behaviour, same two "nothing to show" cases kept distinct, new home. |
| `respecDisabled` (`:81-93`) | **Deleted** | Spec §10.2 lists no respec control on the Character tab; respec is a passive-tree action (§5.4), so the predicate belongs to C/T8's overlay. Leaving it here would be a test with no caller. Flag to T8. |
| `respecDisabled fed the API bundle's respecCost` (`:104-116`) | **Deleted**, same reason | Its F2 lesson is preserved instead by the source-text guard in `characterTab.test.js` and by `mergeLevelInfo`'s test in 15d, both of which prove `respecCost` is copied from the bundle. |
| `progressionChanged` (`:118-151`) | **Deleted** | It existed solely to stop a 500ms React poll from re-rendering on a no-op push. The canvas tab has no poll and no re-render: `Game` state is read fresh every frame. The single-writer guarantee it sat next to is already covered by `progressionSnapshot.test.js`. |
| `STAT_KEYS` (`:166-170`) | **Migrated** to `characterTab.test.js`'s `CHAR_STAT_KEYS` block in Task 15a | Same assertion, same order, new export. |
| `progressionClient.fetchProgression` (`:172-206`) | **Moved verbatim** to `net/__tests__/progressionClient.test.js` | `progressionClient.js` outlives the popup — `Game._refreshProgressionBundle` is now its caller. |
| `progressionClient.allocateStat` (`:208-231`) | **Moved** if `allocateStat` still exists; otherwise dropped (A/T2 removes stat points) | Step 1 below checks which exports survive before writing the file. |
| `progressionClient.respec` (`:233-255`) | **Moved** if `respec` still exists; otherwise dropped (C/T7 replaces the respec route) | Same check. |
| `CharacterSheet keyboard toggle (source-text)` (`:261-278`) | **Deleted** | It asserts against a file that no longer exists. The claim it protected — that `C` is owned by exactly one handler — moves to `hotkeyRegistry.test.js`, which is a stronger test. |
| `CharacterSheet placement (source-text)` (`:289-305`) | **Deleted** | Pins CSS on a deleted DOM overlay. The pane is inside the canvas panel now; the D2 occlusion it guarded cannot recur because the panel is centred, not corner-pinned. |
| `F2: no local backend-constant duplication (source-text)` (`:310-331`) | **Migrated** to `characterTab.test.js` in Task 15a, retargeted at `characterTab.js` and widened (also bans `Math.pow`/`**`) | The prohibition outlives the file it was written against — this is the whole point of F2. |

- [ ] **Step 1: Write the failing test**

First establish which `progressionClient` exports still exist:

```bash
grep -n '^export async function' /home/markunn/worker/coding/jsgame/something2/frontend/src/games/something2/src/js/net/progressionClient.js
```

If the output is the current three (`fetchProgression`, `allocateStat`, `respec`), write the file exactly as below. If A/T2 or C/T7 has already removed `allocateStat` and/or `respec`, delete the corresponding `describe` block and its name from the `import` line before saving — nothing else changes.

Create `frontend/src/games/something2/src/js/net/__tests__/progressionClient.test.js`:

```js
// progressionClient against a stubbed fetch. Moved out of
// src/js/__tests__/characterSheet.test.js when the standalone level popup was
// deleted (SOMET-NNN): the client outlived its first caller -- Game's
// _refreshProgressionBundle is what reads GET /api/progression now.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchProgression, allocateStat, respec } from '../progressionClient.js';
import { writeActiveCharacterId, clearActiveCharacterId }
  from '../../../../characterSession.js';

afterEach(() => vi.restoreAllMocks());

// SOMET-257 made progression per character, so every one of these endpoints
// needs a character_id and progressionClient reads it from the session store --
// the same place GameShell writes it. Without this the tab asks for nobody's
// progression and renders "character_id is required" where the stats belong;
// that is exactly what shipped once, and only the browser showed it.
const TEST_CHARACTER_ID = 77;
globalThis.localStorage = globalThis.localStorage || (() => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
})();
writeActiveCharacterId(TEST_CHARACTER_ID);

describe('progressionClient.fetchProgression', () => {
  it('GETs /api/progression and returns the bundle', async () => {
    const body = {
      progression: { level: 1, experience: 0 },
      stats: { maxHp: 100 },
      sources: { strength: { base: 5, tree: 0, gear: 0 } },
      modifiers: [],
      passivePoints: 0,
      allocatedNodeIds: [],
      xpFloor: 0,
      xpToNext: 18,
      respecCost: 50,
    };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    const res = await fetchProgression('http://x');
    expect(global.fetch).toHaveBeenCalledWith(
      `http://x/api/progression?character_id=${TEST_CHARACTER_ID}`, expect.any(Object));
    expect(res).toEqual(body);
  });

  it("refuses to ask for nobody's progression", async () => {
    clearActiveCharacterId();
    global.fetch = vi.fn();
    try {
      await expect(fetchProgression('http://x')).rejects.toThrow(/No character selected/);
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      writeActiveCharacterId(TEST_CHARACTER_ID);
    }
  });

  it('throws the server error message on a non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
    await expect(fetchProgression('http://x')).rejects.toThrow(/boom/);
  });
});

describe('progressionClient.allocateStat', () => {
  it('posts the stat and count, and returns the new bundle', async () => {
    const body = { progression: { level: 1, experience: 0, constitution: 6 }, stats: { maxHp: 110 } };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    const res = await allocateStat('constitution', 1, 'http://x');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('http://x/api/progression/allocate');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      stat: 'constitution', count: 1, character_id: TEST_CHARACTER_ID,
    });
    expect(res).toEqual(body);
  });

  it('throws the server error message on a 400 (bad allocation)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'not enough points' }) });
    await expect(allocateStat('constitution', 5, 'http://x')).rejects.toThrow(/not enough points/);
  });
});

describe('progressionClient.respec', () => {
  it('POSTs /api/progression/respec and returns the refunded bundle', async () => {
    const body = { progression: { level: 3, experience: 450 }, stats: { maxHp: 100 }, gold: 50 };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    const res = await respec('http://x');
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('http://x/api/progression/respec');
    expect(opts.method).toBe('POST');
    // A respec charges the ACCOUNT's gold but refunds the CHARACTER's points,
    // so the server needs both identities and gets the character one from here.
    expect(JSON.parse(opts.body)).toEqual({ character_id: TEST_CHARACTER_ID });
    expect(res).toEqual(body);
  });

  it('throws the server error message on a 402 (cannot afford)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 402, json: async () => ({ error: 'not enough gold', cost: 150 }) });
    await expect(respec('http://x')).rejects.toThrow(/not enough gold/);
  });
});
```

Replace `hotkeyRegistry.test.js:105-113` with:

```js
  it('finds the files that bind keys at all', () => {
    // If the discovery walk breaks -- a moved directory, a renamed extension --
    // every assertion below passes over an empty list. This is the fixed point
    // that makes the rest mean something.
    //
    // The bound was 4 until SOMET-NNN deleted CharacterSheet.jsx, the standalone
    // level popup, and moved its C binding into Game.js's own handler. Three
    // files register a window keydown listener now: Minimap.jsx,
    // WaypointTravel.jsx and core/Game.js. LOWERED, not deleted -- the guard's
    // job is to fail when discovery breaks, and it still does.
    expect(listeners.length).toBeGreaterThanOrEqual(3);
    const files = listeners.map((l) => l.file);
    expect(files).toContain('games/something2/WaypointTravel.jsx');
    expect(files).toContain('games/something2/src/js/core/Game.js');
    expect(files).not.toContain('games/something2/CharacterSheet.jsx');
  });

  it('gives C to exactly one handler -- Game.js, which opens the Character tab', () => {
    // The deleted popup owned C. Reusing it rather than retiring it keeps the
    // player's muscle memory, and this pins that the reuse did not create a
    // second claimant.
    const byFile = Object.fromEntries(listeners.map((l) => [l.file, l]));
    expect([...byFile['games/something2/src/js/core/Game.js'].plain]).toContain('c');
    expect(listeners.filter((l) => l.plain.has('c'))).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/markunn/worker/coding/jsgame/something2/frontend && npx vitest run src/games/something2/__tests__/hotkeyRegistry.test.js src/games/something2/src/js/net/__tests__/progressionClient.test.js`

Expected: FAIL — `hotkeyRegistry.test.js` reports `expected [ 'games/something2/Minimap.jsx', 'games/something2/CharacterSheet.jsx', … ] not to contain 'games/something2/CharacterSheet.jsx'` and `expected [ 'i', 'escape', 'e', 'b', 'f', 'g' ] to include 'c'`.

- [ ] **Step 3: Write the minimal implementation**

Add the `C` branch to `Game.js`, immediately after the `isKey('i')` block (`Game.js:1072`):

```js
            // Character sheet (SOMET-NNN): C opens the inventory panel on its
            // Character tab. The standalone popup this key used to toggle is
            // deleted -- the key is REUSED rather than retired so the player's
            // muscle memory survives, and hotkeyRegistry.test.js pins that
            // nothing else claims it. Same gates as 'i', so the two centred
            // panels can never stack.
            if (isKey('c') && this.state === 'playing' && this.chunked && !e.repeat && !this.shopOpen && !this.bankOpen) {
                if (this.inventoryOpen && this.inventoryTab === 'character') {
                    this.closeInventory();
                } else {
                    this.inventoryOpen = true;
                    this.inventoryTab = 'character';
                    this.inventoryPage = 0;
                    this.characterModPage = 0;
                    this._refreshProgressionBundle();
                }
            }
```

Delete the popup and its test file:

```bash
rm /home/markunn/worker/coding/jsgame/something2/frontend/src/games/something2/CharacterSheet.jsx
rm /home/markunn/worker/coding/jsgame/something2/frontend/src/games/something2/src/js/__tests__/characterSheet.test.js
```

Remove the two lines in `GameView.jsx` — delete `:13` (`import CharacterSheet from "./CharacterSheet.jsx";`) and `:256` (`{isPlaying && <CharacterSheet gameRef={gameRef} />}`).

Update the three stale comments that name the deleted file:

- `Game.js:123` — replace `CharacterSheet.jsx is the sole reader.` with `the inventory panel's Character tab is the sole reader (progressionExtras.js).`
- `Game.js:675` and `:693` (inside `applyGoldResult`'s doc block) — replace `CharacterSheet.jsx calls this right after a successful respec HTTP response` with `C/T8's passive-tree overlay calls this right after a successful respec HTTP response`, and `See CharacterSheet.jsx's module header` with `See core/progressionExtras.js's module header`. Keep the method and `getProgressionSnapshot` (`Game.js:669`): both are the documented entry points C/T8's respec flow needs, and `progressionSnapshot.test.js`'s F1 regression guard is the surviving record of that fix.
- `progressionClient.js:16` — replace `threaded down through CharacterSheet's props` with `threaded down through a component's props`.
- `progressionSnapshot.test.js:1-5` and `:102-106` — replace both mentions of `CharacterSheet.jsx` with `the inventory panel's Character tab`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/markunn/worker/coding/jsgame/something2/frontend && npx vitest run && npm run lint`
Expected: PASS, and no lint error for an unused import in `GameView.jsx`.

- [ ] **Step 5: Commit**

```bash
git add -u frontend/src/games/something2/CharacterSheet.jsx frontend/src/games/something2/src/js/__tests__/characterSheet.test.js
git add frontend/src/games/something2/GameView.jsx frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/src/js/net/progressionClient.js frontend/src/games/something2/src/js/net/__tests__/progressionClient.test.js frontend/src/games/something2/__tests__/hotkeyRegistry.test.js frontend/src/games/something2/src/js/core/__tests__/progressionSnapshot.test.js
git commit -m "$(cat <<'EOF'
feat(sheet): delete the standalone level popup, rebind C (SOMET-NNN)

CharacterSheet.jsx and its DOM overlay are gone; C now opens the inventory
panel on its Character tab. The F1 single-writer rule and the F2 no-local-curve
prohibition are preserved in progressionExtras.js and characterTab.test.js
respectively rather than deleted with the file that documented them.

hotkeyRegistry.test.js's discovery floor drops from 4 to 3 with the reason
recorded inline -- one fewer file binds a window keydown listener.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15f: Browser verification

This change has a UI surface, so AGENTS.md's definition of done requires a real browser pass. Run it against an **isolated** stack — never `checkout` the shared working directory and never restart the compose containers (their CMD is a stub; a restart silently kills the shared vite/nodemon and nothing brings them back).

**Files:** none. This task produces evidence, not code.

- [ ] **Step 1: Start an isolated backend against a scratch database**

```bash
cd /home/markunn/worker/coding/jsgame/something2
PORT=13102 \
DATABASE_URL="postgres://user:password@localhost:15432/somet_e_sheet" \
JWT_SECRET="$(grep ^JWT_SECRET= .env | cut -d= -f2-)" \
nohup node backend/src/index.js > /tmp/claude-1000/e-sheet-backend.log 2>&1 & echo $! > /tmp/claude-1000/e-sheet-backend.pid
```

Kill it later by **PID file only** (`kill "$(cat /tmp/claude-1000/e-sheet-backend.pid)"`) — a `pkill -f "node src/index.js"` hits other sessions' host processes.

- [ ] **Step 2: Start vite from the worktree with an override config**

`frontend/vite.config.js` hardcodes `BACKEND = 'http://backend:3101'` (the compose service name), so a host-run vite needs an override. Write `frontend/vite.verify.config.mjs` **inside `frontend/`** (or its `vite`/`@vitejs` imports will not resolve), setting `server.port: 15273`, `server.proxy` to `http://localhost:13102`, and `cacheDir: '/tmp/claude-1000/e-sheet-vite'` (the default `node_modules/.vite` is a symlink into the shared checkout). Then `cd frontend && npx vite --config vite.verify.config.mjs`. **Delete the override config before committing.**

- [ ] **Step 3: Register a player and open the game**

`POST http://localhost:13102/api/auth/register {username, password}` (password ≥ 8) → `{token}`. Open Chrome DevTools MCP in an `isolatedContext` at `http://localhost:15273/game` (the route is `/game`, not `/game-something2`), `evaluate_script` `localStorage.setItem('something2.authToken', <jwt>)`, reload. A `role:"player"` account auto-joins the entry world.

- [ ] **Step 4: Verify the Character tab on a fresh level-1 character**

Press `i`, then click the **Character** tab (the fifth). Screenshot. Look for:
- a header reading `<Class> — Level 1` with the class name filled in, not `Unknown class`;
- an XP bar with a visible track and the label `0 / 18 XP` (**not** `Loading…` and **not** `MAX LEVEL`);
- six itemised lines, each of the form `STR 5 = 5 base` — the zero tree/gear parts must be **absent**, not printed as `+ 0 tree`;
- seven derived rows with real numbers, none showing `—` (`Max HP`, `Max mana`, `Melee`, `Spell`, `Cooldown`, `Mana regen`, `Sell price`);
- `Strong: <ABBR> 5    Weak: —` — the weak half must be a dash, not a repeat of the strong stat;
- `Passive points: 0`;
- `No modifiers yet — allocate passives or equip gear.` under the `Modifiers` heading;
- the eight paperdoll boxes and the auto-loot / gold footer still present on the left;
- **no** item cells and **no** page arrows painted over the pane.

- [ ] **Step 5: Verify the tab is live, not a snapshot**

With the panel open on the Character tab, kill one creature (or take one XP source). The XP bar and the `into / need` label must move without closing and reopening the panel. Then click the **All** tab and back to **Character**: the pane must repaint with the same numbers, and the item grid must reappear on **All**.

- [ ] **Step 6: Verify gear and passive modifiers appear with their source**

Equip an item that carries an affix (D/T12) and allocate one passive node (C/T7). Screenshot. Look for:
- the affected stat's line gaining a `+ N gear` and/or `+ N tree` part, and its headline total moving by exactly that amount;
- one row per affix and one per granting passive under `Modifiers`, each with a right-hand `gear` or `tree` tag;
- if more than seven modifiers exist, a `>` arrow that pages the list and a `page 1/2` counter, with `<` appearing on page 2.

- [ ] **Step 7: Verify the key changes and that the popup is gone**

- Close the panel (`Escape`), then press `c`: the panel must open **directly on the Character tab**. Press `c` again: it must close.
- With the panel open on the **All** tab, press `c`: it must switch to the Character tab rather than closing.
- Confirm the bottom-left corner has **no** floating sheet and **no** 📜 show-button — the deleted overlay was pinned there (`CharacterSheet.jsx:149-206`).
- Press `m` (minimap) and `t` (waypoint travel) and confirm neither also opens the Character tab: `c` must not have leaked into another handler.

- [ ] **Step 8: Record the evidence and tear down**

Attach the screenshots from Steps 4, 6 and 7 to the Plane item, then `kill "$(cat /tmp/claude-1000/e-sheet-backend.pid)"`, stop vite, and delete `frontend/vite.verify.config.mjs`.

- [ ] **Step 9: Commit (only if Step 8 turned up a fix)**

```bash
git add <the explicit paths the browser pass changed>
git commit -m "$(cat <<'EOF'
fix(sheet): <what the browser pass found> (SOMET-NNN)

Found only in the browser; the vitest suite was green throughout.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review: spec requirement → sub-task

Every requirement in spec §10.1 and §10.2, and every constraint the task brief imposed, mapped to where it is implemented and where it is proved.

| Requirement (source) | Sub-task | Proof |
|---|---|---|
| Delete the standalone popup `CharacterSheet.jsx` (§10.1) | 15e | `rm` + `GameView.jsx` unmount; `hotkeyRegistry.test.js` asserts the file no longer registers a listener |
| Delete the `C` key toggle (§10.1) | 15e | Popup deleted; `C` re-bound in `Game.js` and pinned as a sole claim by `hotkeyRegistry.test.js` |
| Preserve the F1 single-writer data flow (§10.1, contract §4) | 15d | `progressionExtras.test.js` — "is a NO-OP once a socket frame has carried extras", plus `Game.onProgression` remains the only writer of `this.progression` and `progressionSnapshot.test.js`'s F1 guard is kept intact |
| Preserve the F2 rule (read `xpFloor`/`xpToNext`/`respecCost` from the server) | 15a, 15d | `characterTab.test.js`'s source-text block (no `XP_BASE`/`MAX_LEVEL`/`RESPEC_BASE`, no `Math.pow`/`**`, `xpCurve.js` still absent); `mergeLevelInfo` copies all three |
| New tab in `inventoryPanel.js`, using its existing `TABS` mechanism (§10.2) | 15b | `TABS` gains a fifth entry; `inventoryPanel.test.js` pins the five keys and their hit areas |
| Layout/formatting testable without a canvas; only drawing touches the context (§10.2, contract §5) | 15a, 15b, 15c | `characterTab.js` splits `layoutCharacterTab` (pure) from `drawCharacterTab` (write-only); `characterTabDraw.test.js` uses the repo's recording-context stub |
| Class, level, XP bar (§10.2) | 15a, 15b, 15c | `formatHeader`, `xpBar`, `formatXpLabel`, `layoutCharacterTab.xp`; draw test asserts the fill is 150px of a 300px track at 50% |
| Six stats, each itemised `STR 42 = 5 base + 33 tree + 4 gear` (§10.2) | 15a, 15b | `formatStatBreakdown` — literal assertions for all three parts, for a partial breakdown, and for base-only |
| Derived stats: max HP, max mana, melee ×, spell ×, cooldown ×, mana regen, sell price × (§10.2) | 15a | `derivedRows` — a literal seven-row expectation and a seven-dash expectation |
| Strong point = highest, weak point = lowest (§10.2) | 15a | `strongAndWeak` — highest/lowest on the rich fixture |
| Ties broken toward the class main stat (§10.2) | 15a | Two dedicated cases: a strongest-tie and a weakest-tie, each won by the main stat against declaration order |
| Combined expanded modifier list, every affix and every granting passive, with its source, rendered from `composeStats().modifiers` (§10.2) | 15a, 15b, 15c | `modifierRows` — an interleaved tree/gear fixture asserted in server order with source tags; `drawCharacterTab` paints the tag in its own colour column |
| Renders correctly with ZERO passives and ZERO affixes (brief) | 15a, 15b, 15c | `FRESH_SOURCES`/`FRESH_CHARACTER` fixtures: `STR 5 = 5 base` ×6, `Weak: —`, `Passive points: 0`, `No modifiers yet…`, and a draw test that asserts no `tree`/`gear` tag is painted |
| Tests do not derive expectations from the code under test (contract §5) | 15a–15d | Every expectation is a hand-written literal string, number or object; no test calls `formatStatBreakdown`, `xpBar`, `composeStats` or a backend constant to build one |
| Explicit browser verification of the UI surface (§11, AGENTS.md) | 15f | Nine steps naming exactly what to click and what to look for, on an isolated stack |
| No migration (contract §1) | — | T15 has no slot; nothing in this plan touches `backend/migrations/` |
| Decomposed into identifiable sub-tasks of one Plane item | 15a–15f | Six sub-tasks, each with its own TDD cycle and its own commit, all carrying `SOMET-NNN` |
