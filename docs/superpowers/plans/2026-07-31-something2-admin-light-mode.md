# Something2 Admin Light Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Something2 admin tabs respond to the app's light/dark toggle by replacing 217 hardcoded colour literals with `--s2-*` CSS custom properties.

**Architecture:** `GlobalStyles.js` already swaps token *values* under `:root.dark-mode`. We add an `--s2-*` token block to both mode blocks, then sweep each admin component to consume them. A source-gate test enforces completeness mechanically, since `vitest` runs `environment: "node"` here and rendered styling cannot be asserted at all.

**Tech Stack:** React 19.2.5, styled-components 6 (transient `$` props), vitest 3 (`environment: "node"`), CSS custom properties.

**Design contract:** `docs/superpowers/specs/2026-07-31-something2-admin-light-mode-design.md` — it pins every token value and contrast ratio. **Do not re-derive colours.** All light values were measured for WCAG AA; substituting "a similar shade" silently breaks accessibility.

## Global Constraints

- **Dark mode must not change**, except for the three convergences listed below. Any other dark value differing from the table is a regression.
- **`MapsAdmin.jsx`: colour literals only.** No logic, hook, JSX-structure or behaviour changes. This file was frozen by explicit user constraint; the freeze is lifted for colours alone.
- **Never introduce a new hex literal.** Add a token to `GlobalStyles.js` instead (`.ai/styleguides/frontend.md:15`).
- **`--s2-border` is decorative only** (1.47:1). Anything outlining an interactive control uses `--s2-border-strong` (3.32:1, meets WCAG 1.4.11).
- Disabled state = `--s2-disabled-bg` + `--s2-text-dim` + `cursor: not-allowed`. Never opacity alone.
- Colours appear in **three syntaxes**, all in scope: styled-components templates (`background: #1a1a2e;`), transient props (`$bg="#555"`), and inline style objects (`style={{ color: '#aaa' }}`). Inline styles take `var(--s2-…)` strings normally.

### Out of scope — must NOT be tokenized

| What | Where | Why |
|---|---|---|
| Cytoscape stylesheet | `MapGraphAdmin.jsx` ~`:237-304` (13 literals incl. `#444`, `#9bb`) | Renders to canvas; cannot read CSS custom properties |
| `Minimap.jsx` | all 8 literals | HUD overlay on the game canvas |
| Game canvas viewport | `Something2.jsx` canvas container background | Deliberate dark game surface |
| Biome ring colours | `biomeRingSvg.js` | Colours are biome *data* |
| **Form-state defaults** | `TileTypesAdmin.jsx:399` `'#000000'`, `:425` `'#00ff00'`; `EntityTypesAdmin.jsx:742` `'#ffffff'`, `:798` `'#00ff00'` | **Tile/entity data.** Changing these changes what colour newly-created records get |

### Approved dark-mode convergences

Three near-identical duplicate pairs collapse into one token each. Only the first was explicitly approved; the other two apply the same principle and are called out for rejection if unwanted.

| Converges | Into | Sites | Visible delta |
|---|---|---|---|
| `#333` → `#2e2e3e` | `--s2-border` | 6 | blue channel 51→62 (**approved**) |
| `#e6e6f0` → `#eee` | `--s2-text` | 3 | rgb(230,230,240)→(238,238,238) |
| `#666` → `#888` | `--s2-text-dim` | 2 | empty-state text, one step brighter |

### Token table — the complete literal → token map

Add to **both** the `&, &.light-mode{` block (ends `GlobalStyles.js:44`) and the `&.dark-mode{` block (ends `:82`).

**Surfaces and borders**

| Token | Dark | Light | Replaces |
|---|---|---|---|
| `--s2-bg` | `#0f0f1a` | `#f4f4f8` | `#0f0f1a` (11) |
| `--s2-bg-sunken` | `#12121f` | `#ececf3` | `#12121f` (3) |
| `--s2-surface-subtle` | `#161625` | `#f7f7fb` | `#161625` (1) |
| `--s2-surface` | `#1a1a2e` | `#ffffff` | `#1a1a2e` (12) |
| `--s2-surface-raised` | `#23233f` | `#f0f0f6` | `#23233f` (3, excl. cytoscape) |
| `--s2-border` | `#2e2e3e` | `#d4d4e0` | `#2e2e3e` (3) + `#333` (6) |
| `--s2-border-strong` | `#3a3a4e` | `#8b8ba3` | `#3a3a4e` (1) |

**Text**

| Token | Dark | Light | Replaces |
|---|---|---|---|
| `--s2-text-strong` | `#fff` | `#12121f` | `Something2.jsx:79` heading, `:109` hover |
| `--s2-on-accent` | `#fff` | `#ffffff` | `Something2.jsx:54` — white on the accent hover background; **stays white in both modes** |
| `--s2-text` | `#eee` | `#1a1a2e` | `#eee` (10) + `#e6e6f0` (3) |
| `--s2-text-secondary` | `#ccc` | `#33334a` | `#ccc` (6), `#ddd` (1) |
| `--s2-text-muted` | `#aaa` | `#4a4a5e` | `#aaa` (18) |
| `--s2-text-dim` | `#888` | `#6b6b80` | `#888` (13) + `#666` (2) |

**Controls — `#555` splits three ways**

| Token | Dark | Light | Replaces |
|---|---|---|---|
| `--s2-btn-neutral` | `#555` | `#e2e2ea` | `$bg="#555"` — `MapsAdmin.jsx:100,103`; `MapGraphAdmin.jsx:611,651` |
| `--s2-disabled-bg` | `#555` | `#ececf3` | `&:disabled` — `ItemTypesAdmin.jsx:237`, `TileTypesAdmin.jsx:274`, `EntityTypesAdmin.jsx:362` |
| `--s2-swatch-border` | `#555` | `#8b8ba3` | `BiomesAdmin.jsx:28` swatch outline |

A neutral button in light mode needs `--s2-text` as its label colour; dark mode's `#555` background carried white text implicitly.

**Accents** — every dark accent fails WCAG AA on light surfaces (measured: `#facc15` 1.40:1, `#f59e0b` 1.96:1, `#22c55e` 2.08:1, `#10b981` 2.31:1, `#4a9eff` 2.51:1, `#ef4444` 3.43:1). None may be reused.

| Token | Dark | Light | Contrast on `#f4f4f8` |
|---|---|---|---|
| `--s2-accent` | `#4a9eff` | `#2563eb` | 4.71:1 |
| `--s2-selected` | `#facc15` | `#946005` | 4.87:1 |
| `--s2-danger` | `#ef4444` | `#b91c1c` | 5.90:1 |
| `--s2-danger-soft` | `#f87171` | `#c81e1e` | 5.23:1 |
| `--s2-success` | `#22c55e` | `#15803d` | 4.57:1 |
| `--s2-success-alt` | `#10b981` | `#047857` | 5.00:1 |
| `--s2-warning` | `#f59e0b` | `#b45309` | 4.58:1 |
| `--s2-warning-soft` | `#fcd34d` | `#946005` | 4.87:1 |
| `--s2-warning-bright` | `#fde047` | `#854d0e` | 6.25:1 |
| `--s2-warning-mid` | `#eab308` | `#854d0e` | 6.25:1 |

**Selection is not a plain swap.** `--s2-selected` on white reads as a warning. Where `#facc15` currently fills or outlines a selected row, light mode uses background `#fef3c7` with `--s2-selected` for border and text. Applies wherever selection state is drawn.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `frontend/src/styles/GlobalStyles.js` | token definitions | Add `--s2-*` to both mode blocks |
| `frontend/src/games/something2/__tests__/themeTokens.test.js` | **new** — source gate | Enforces completeness; owns the `PENDING` list |
| `BiomesAdmin.jsx` (14) | first file under the gate | sweep |
| `TileTypesAdmin.jsx` (26), `ItemTypesAdmin.jsx` (25) | near-identical structure | sweep |
| `EntityTypesAdmin.jsx` (50) | largest admin tab | sweep |
| `MapsAdmin.jsx` (32) | **colours only** | sweep |
| `MapGraphAdmin.jsx` (18 of 31) | cytoscape block sentinel-wrapped | sweep |
| `Something2.jsx` (52) | shell + tab strip, not canvas | sweep |
| `.ai/styleguides/frontend.md:17` | currently forbids this change | amend |

### The exemption mechanism

Out-of-scope literals are wrapped in **sentinel comments**, never line ranges — line numbers shift on every edit and a range-based allowlist rots immediately.

```js
/* s2-theme-exempt:start — cytoscape renders to canvas, cannot read CSS vars */
...
/* s2-theme-exempt:end */
```

Single-line form for data defaults:

```js
color: '#00ff00', // s2-theme-exempt: tile data default, not chrome
```

The gate strips exempt regions, then flags **any** remaining `#hex`. Scanning for all hex rather than for CSS-declaration syntax is what makes it catch prop and inline-style literals automatically.

---

### Task 1: Define the `--s2-*` tokens

**Files:**
- Modify: `frontend/src/styles/GlobalStyles.js`
- Test: `frontend/src/games/something2/__tests__/themeTokens.test.js` (create)

**Interfaces:**
- Produces: all `--s2-*` token names in the Global Constraints table. Every later task consumes them.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/__tests__/themeTokens.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const globalStyles = readFileSync(
  fileURLToPath(new URL('../../../styles/GlobalStyles.js', import.meta.url)), 'utf8',
);

// [token, darkValue, lightValue] — copied from the design contract. Do not re-derive.
const TOKENS = [
  ['--s2-bg', '#0f0f1a', '#f4f4f8'],
  ['--s2-bg-sunken', '#12121f', '#ececf3'],
  ['--s2-surface-subtle', '#161625', '#f7f7fb'],
  ['--s2-surface', '#1a1a2e', '#ffffff'],
  ['--s2-surface-raised', '#23233f', '#f0f0f6'],
  ['--s2-border', '#2e2e3e', '#d4d4e0'],
  ['--s2-border-strong', '#3a3a4e', '#8b8ba3'],
  ['--s2-text-strong', '#fff', '#12121f'],
  ['--s2-on-accent', '#fff', '#ffffff'],
  ['--s2-text', '#eee', '#1a1a2e'],
  ['--s2-text-secondary', '#ccc', '#33334a'],
  ['--s2-text-muted', '#aaa', '#4a4a5e'],
  ['--s2-text-dim', '#888', '#6b6b80'],
  ['--s2-btn-neutral', '#555', '#e2e2ea'],
  ['--s2-disabled-bg', '#555', '#ececf3'],
  ['--s2-swatch-border', '#555', '#8b8ba3'],
  ['--s2-accent', '#4a9eff', '#2563eb'],
  ['--s2-selected', '#facc15', '#946005'],
  ['--s2-danger', '#ef4444', '#b91c1c'],
  ['--s2-danger-soft', '#f87171', '#c81e1e'],
  ['--s2-success', '#22c55e', '#15803d'],
  ['--s2-success-alt', '#10b981', '#047857'],
  ['--s2-warning', '#f59e0b', '#b45309'],
  ['--s2-warning-soft', '#fcd34d', '#946005'],
  ['--s2-warning-bright', '#fde047', '#854d0e'],
  ['--s2-warning-mid', '#eab308', '#854d0e'],
];

// Slice the two mode blocks apart so a token defined in only one is caught.
function modeBlocks(source) {
  const darkStart = source.indexOf('&.dark-mode');
  if (darkStart === -1) throw new Error('no &.dark-mode block found');
  const darkEnd = source.indexOf('\n  }', darkStart);
  if (darkEnd === -1) throw new Error('could not find end of &.dark-mode block');
  const lightStart = source.indexOf('&.light-mode');
  if (lightStart === -1) throw new Error('no &.light-mode block found');
  return { light: source.slice(lightStart, darkStart), dark: source.slice(darkStart, darkEnd) };
}

describe('--s2-* theme tokens', () => {
  const { light, dark } = modeBlocks(globalStyles);

  it.each(TOKENS)('defines %s in the light block as %s', (token, _darkValue, lightValue) => {
    expect(light).toMatch(new RegExp(`${token}\\s*:\\s*${lightValue}\\s*;`, 'i'));
  });

  it.each(TOKENS)('defines %s in the dark block as %s', (token, darkValue) => {
    expect(dark).toMatch(new RegExp(`${token}\\s*:\\s*${darkValue}\\s*;`, 'i'));
  });

  it('slices two non-empty, non-overlapping mode blocks', () => {
    expect(light.length).toBeGreaterThan(100);
    expect(dark.length).toBeGreaterThan(100);
    expect(dark).not.toContain('&.light-mode');
  });
});
```

The third test guards the slicing helper itself — without it, a `modeBlocks` that returned the whole file for both would make every other assertion pass vacuously.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/themeTokens.test.js`
Expected: FAIL — 52 assertions failing, no `--s2-*` tokens defined yet.

- [ ] **Step 3: Add the tokens**

In `GlobalStyles.js`, inside the `&, &.light-mode{` block (before its closing `}` at ~`:44`), add each token with its **light** value. Inside `&.dark-mode{` (before its closing `}` at ~`:82`), add each token with its **dark** value. Use the exact values from `TOKENS` above — they are the contract's measured values.

Group with comments matching the contract's sections: `/* s2: surfaces */`, `/* s2: text */`, `/* s2: controls */`, `/* s2: accents */`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/themeTokens.test.js`
Expected: PASS, 53 tests.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `cd frontend && npm test`
Expected: all previously-passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/styles/GlobalStyles.js frontend/src/games/something2/__tests__/themeTokens.test.js
git commit -m "feat(theme): add --s2-* tokens for Something2 admin light mode"
```

---

### Task 2: The source gate, proven on `BiomesAdmin.jsx`

Establishes the completeness mechanism and puts the first file under it. `BiomesAdmin.jsx` is smallest (14 literals), so the mechanism is proven on the cheapest target.

**Files:**
- Modify: `frontend/src/games/something2/__tests__/themeTokens.test.js`
- Modify: `frontend/src/games/something2/BiomesAdmin.jsx`

**Interfaces:**
- Consumes: `--s2-*` tokens from Task 1.
- Produces: the `PENDING` array and `s2-theme-exempt` sentinel convention. Tasks 3-7 each delete their filename from `PENDING`.

- [ ] **Step 1: Add the failing gate**

Append to `themeTokens.test.js`:

```js
const IN_SCOPE = [
  'Something2.jsx', 'TileTypesAdmin.jsx', 'EntityTypesAdmin.jsx',
  'ItemTypesAdmin.jsx', 'BiomesAdmin.jsx', 'MapsAdmin.jsx', 'MapGraphAdmin.jsx',
];

// Files not yet swept. Each sweep task deletes its own entry. Must reach [].
const PENDING = [
  'Something2.jsx', 'TileTypesAdmin.jsx', 'EntityTypesAdmin.jsx',
  'ItemTypesAdmin.jsx', 'MapsAdmin.jsx', 'MapGraphAdmin.jsx',
];

const read = (name) => readFileSync(
  fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8',
);

// Strip sentinel-marked regions and single-line exemptions, then find any surviving hex.
function offendingLiterals(source) {
  const withoutBlocks = source.replace(
    /\/\*\s*s2-theme-exempt:start[\s\S]*?s2-theme-exempt:end\s*\*\//g, '',
  );
  return withoutBlocks
    .split('\n')
    .filter((line) => !/s2-theme-exempt/.test(line))
    .flatMap((line) => line.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []);
}

describe('Something2 admin theme gate', () => {
  const swept = IN_SCOPE.filter((f) => !PENDING.includes(f));

  it.each(swept)('%s has no untokenized colour literals', (file) => {
    expect(offendingLiterals(read(file))).toEqual([]);
  });

  // Reverse assertion: a PENDING file that is already clean means someone swept it
  // and forgot to remove it from the list — or misspelled a filename.
  it.each(PENDING)('%s is still pending and still dirty', (file) => {
    expect(offendingLiterals(read(file)).length).toBeGreaterThan(0);
  });

  it('every PENDING entry is a real in-scope file', () => {
    for (const file of PENDING) expect(IN_SCOPE).toContain(file);
  });

  it('has at least one swept file under the gate', () => {
    expect(swept.length).toBeGreaterThan(0);
  });
});
```

The reverse assertion is what stops this from decaying into a test that passes by exempting everything. The last test stops `PENDING === IN_SCOPE` from making the gate vacuous.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/themeTokens.test.js`
Expected: FAIL — `BiomesAdmin.jsx has no untokenized colour literals` fails, listing its 14 literals.

- [ ] **Step 3: Sweep `BiomesAdmin.jsx`**

Replace every literal per the Global Constraints token table. Known sites: `:19` card `background: #23233f` → `var(--s2-surface-raised)` and `border: 1px solid #333` → `var(--s2-border)`; `:22` input `background: #12121f` → `var(--s2-bg-sunken)`, `color: #eee` → `var(--s2-text)`, `border: 1px solid #333` → `var(--s2-border)`; `:28` swatch `border: 1px solid #555` → `var(--s2-swatch-border)`; `:36` and inline styles `color: '#ccc'` → `'var(--s2-text-secondary)'`; `:78` `color: '#ef4444'` → `'var(--s2-danger)'`; `:112`, `:136` `color: '#888'` → `'var(--s2-text-dim)'`.

Leave `:28`'s `background: ${p => p.$color}` alone — it is biome data.

- [ ] **Step 4: Run the gate to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/themeTokens.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `cd frontend && npm test`
Expected: green, including `BiomesAdmin.smoke.test.js`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/__tests__/themeTokens.test.js frontend/src/games/something2/BiomesAdmin.jsx
git commit -m "test(theme): add source gate; tokenize BiomesAdmin"
```

---

### Task 3: Sweep `TileTypesAdmin.jsx` and `ItemTypesAdmin.jsx`

Paired because both carry the identical `&:disabled { background: #555 }` pattern and similar form layouts. 51 literals total.

**Files:**
- Modify: `frontend/src/games/something2/TileTypesAdmin.jsx`, `ItemTypesAdmin.jsx`, `__tests__/themeTokens.test.js`

**Interfaces:**
- Consumes: `--s2-*` tokens (Task 1), `PENDING` array and sentinel convention (Task 2).

- [ ] **Step 1: Remove both files from `PENDING`**

Delete `'TileTypesAdmin.jsx'` and `'ItemTypesAdmin.jsx'` from the `PENDING` array.

- [ ] **Step 2: Run the gate and confirm it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/themeTokens.test.js`
Expected: FAIL — both files now under the gate with literals present.

- [ ] **Step 3: Exempt the two data defaults**

In `TileTypesAdmin.jsx`, mark the form-state colours — these are tile data, and tokenizing them changes what colour new tiles are created with:

```js
    color: '#000000', // s2-theme-exempt: tile data default, not chrome
```

at `:399`, and:

```js
        color: '#00ff00', // s2-theme-exempt: tile data default, not chrome
```

at `:425`.

- [ ] **Step 4: Sweep both files**

Apply the token table. `&:disabled { background: #555 }` at `TileTypesAdmin.jsx:274` and `ItemTypesAdmin.jsx:237` becomes `background: var(--s2-disabled-bg); color: var(--s2-text-dim);` — the added `color` is required, since dark mode relied on inherited light text that light mode will not supply. `color: '#4a9eff'` at `TileTypesAdmin.jsx:341` → `'var(--s2-accent)'`; `color: '#ef4444'` at `:370` → `'var(--s2-danger)'`.

- [ ] **Step 5: Run the gate and the full suite**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/themeTokens.test.js && npm test`
Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/TileTypesAdmin.jsx frontend/src/games/something2/ItemTypesAdmin.jsx frontend/src/games/something2/__tests__/themeTokens.test.js
git commit -m "feat(theme): tokenize TileTypesAdmin and ItemTypesAdmin"
```

---

### Task 4: Sweep `EntityTypesAdmin.jsx`

Largest admin tab, 50 literals.

**Files:**
- Modify: `frontend/src/games/something2/EntityTypesAdmin.jsx`, `__tests__/themeTokens.test.js`

**Interfaces:**
- Consumes: `--s2-*` tokens (Task 1), `PENDING` and sentinels (Task 2).

- [ ] **Step 1: Remove `'EntityTypesAdmin.jsx'` from `PENDING`**

- [ ] **Step 2: Run the gate and confirm it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/themeTokens.test.js`
Expected: FAIL listing its literals.

- [ ] **Step 3: Exempt the two data defaults**

```js
    color: '#ffffff', // s2-theme-exempt: entity data default, not chrome
```

at `:742`, and:

```js
        color: '#00ff00', // s2-theme-exempt: entity data default, not chrome
```

at `:798`.

- [ ] **Step 4: Sweep the file**

Apply the token table. `&:disabled { background: #555 }` at `:362` → `background: var(--s2-disabled-bg); color: var(--s2-text-dim);`. `color: '#4a9eff'` at `:681` → `'var(--s2-accent)'`; `color: '#ef4444'` at `:710` → `'var(--s2-danger)'`; `color: '#facc15'` at `:1008` and `:1018` → `'var(--s2-selected)'`.

- [ ] **Step 5: Run the gate and the full suite**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/themeTokens.test.js && npm test`
Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/EntityTypesAdmin.jsx frontend/src/games/something2/__tests__/themeTokens.test.js
git commit -m "feat(theme): tokenize EntityTypesAdmin"
```

---

### Task 5: Sweep `MapsAdmin.jsx` — colours only

32 literals, ~24 of them in inline `style={{}}` objects. **This file is under a standing freeze that is lifted for colour literals alone.**

**Files:**
- Modify: `frontend/src/games/something2/MapsAdmin.jsx`, `__tests__/themeTokens.test.js`

**Interfaces:**
- Consumes: `--s2-*` tokens (Task 1), `PENDING` (Task 2).

- [ ] **Step 1: Remove `'MapsAdmin.jsx'` from `PENDING`**

- [ ] **Step 2: Run the gate and confirm it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/themeTokens.test.js`
Expected: FAIL listing its literals.

- [ ] **Step 3: Sweep colours only**

Do **not** change logic, hooks, JSX structure, prop names, or formatting beyond the colour values themselves. The reviewer will diff for exactly this.

Sites include: `:22` card `background: #23233f` → `var(--s2-surface-raised)`, and its `border: 1px solid ${p => p.$entry ? '#facc15' : '#333'}` → `${p => p.$entry ? 'var(--s2-selected)' : 'var(--s2-border)'}`; `:26` input as in `BiomesAdmin`; `:93,117,119,142,220,222,227` `color: '#888'` → `'var(--s2-text-dim)'`; `:94` `color: '#facc15'` → `'var(--s2-selected)'`; `:95` `color: '#ef4444'` → `'var(--s2-danger)'`; `:99,113,134,153,169` `color: '#aaa'` → `'var(--s2-text-muted)'`; `:107,136,155,171` `color: '#ccc'` → `'var(--s2-text-secondary)'`; `:147` `color: '#f59e0b'` → `'var(--s2-warning)'`; `:100,103` `$bg="#555"` → `$bg="var(--s2-btn-neutral)"`.

- [ ] **Step 4: Verify no non-colour change slipped in**

Run: `git diff -U0 frontend/src/games/something2/MapsAdmin.jsx | grep -E '^[+-]' | grep -viE '#[0-9a-f]{3,8}|var\(--s2-'`
Expected: no output beyond the `+++`/`---` file headers. Any other line is an out-of-scope change and must be reverted.

- [ ] **Step 5: Run the gate and the full suite**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/themeTokens.test.js && npm test`
Expected: both green, including `MapsAdmin.smoke.test.js` and `useMapsAdminLinks.test.js`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/MapsAdmin.jsx frontend/src/games/something2/__tests__/themeTokens.test.js
git commit -m "feat(theme): tokenize MapsAdmin colours (colour literals only)"
```

---

### Task 6: Sweep `MapGraphAdmin.jsx`, exempting the cytoscape stylesheet

18 of its 31 literals are in scope. The other 13 live in the cytoscape stylesheet object, which renders to canvas and cannot read CSS custom properties.

**Files:**
- Modify: `frontend/src/games/something2/MapGraphAdmin.jsx`, `__tests__/themeTokens.test.js`

**Interfaces:**
- Consumes: `--s2-*` tokens (Task 1), `PENDING` and sentinels (Task 2).

- [ ] **Step 1: Remove `'MapGraphAdmin.jsx'` from `PENDING`**

- [ ] **Step 2: Run the gate and confirm it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/themeTokens.test.js`
Expected: FAIL listing all 31 literals, including the cytoscape ones.

- [ ] **Step 3: Wrap the cytoscape stylesheet in sentinels**

Find the cytoscape stylesheet array (around `:237-304`, containing `'background-color': '#23233f'`, `'line-color': '#4a9eff'`, `.eh-source`, `.eh-ghost-edge`). Wrap it:

```js
/* s2-theme-exempt:start — cytoscape renders to canvas and cannot read CSS custom
   properties; theming it needs a getComputedStyle bridge plus forced re-render.
   Deliberately excluded, see docs/superpowers/specs/2026-07-31-something2-admin-light-mode-design.md */
const GRAPH_STYLE = [
  ...
];
/* s2-theme-exempt:end */
```

Verify the sentinels bracket exactly the stylesheet — no chrome literal may fall inside, or it silently escapes the gate.

- [ ] **Step 4: Sweep the remaining 18**

Apply the token table to the styled-components at the top of the file: `:30` `border: 1px solid #333` → `var(--s2-border)`; `:33` `Card` `background: #23233f` → `var(--s2-surface-raised)`, `border: 1px solid #333` → `var(--s2-border)`. `$bg="#555"` at `:611` (Cancel) and `:651` (Link mode off) → `$bg="var(--s2-btn-neutral)"`; the `'#22c55e'` at `:651` (Link mode on) → `'var(--s2-success)'`.

- [ ] **Step 5: Run the gate and the full suite**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/themeTokens.test.js && npm test`
Expected: both green, including `MapGraphAdmin.smoke.test.js`, `mapGraphLayout.test.js`, `mapGraphLint.test.js`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/MapGraphAdmin.jsx frontend/src/games/something2/__tests__/themeTokens.test.js
git commit -m "feat(theme): tokenize MapGraphAdmin chrome, exempt cytoscape stylesheet"
```

---

### Task 7: Sweep `Something2.jsx` — chrome, not canvas

52 literals: the shell, tab strip, and HUD wrappers. The canvas viewport background stays dark.

**Files:**
- Modify: `frontend/src/games/something2/Something2.jsx`, `__tests__/themeTokens.test.js`

**Interfaces:**
- Consumes: `--s2-*` tokens (Task 1), `PENDING` and sentinels (Task 2).
- Produces: `PENDING === []`.

- [ ] **Step 1: Remove `'Something2.jsx'` from `PENDING`, leaving it empty**

The array must end as `const PENDING = [];`.

- [ ] **Step 2: Run the gate and confirm it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/themeTokens.test.js`
Expected: FAIL listing its literals. The `is still pending and still dirty` block now has no cases, which is correct.

- [ ] **Step 3: Sentinel-wrap the canvas container background**

Identify the styled-component wrapping the `<canvas>` (`canvasRef` is declared at `:365`, `contentRef` at `:368`). Its background is a deliberate game surface, not chrome:

```js
/* s2-theme-exempt:start — game canvas surface stays dark in both modes */
const CanvasWrap = styled.div`background: #0f0f1a; ...`;
/* s2-theme-exempt:end */
```

- [ ] **Step 4: Sweep the chrome, splitting `#fff` by role**

Three `#fff` sites do **not** share a token:

- `:54` `&:hover { background: #4a9eff; color: #fff; }` → `background: var(--s2-accent); color: var(--s2-on-accent);` — white text on the accent fill, correct in both modes.
- `:79` `h2 { color: #fff; }` → `var(--s2-text-strong)` — must invert to dark in light mode.
- `:109` `&:hover { color: #fff; }` → `var(--s2-text-strong)`.

Inline styles: `:748` `'#aaa'` → `'var(--s2-text-muted)'`; `:759` `'#888'` → `'var(--s2-text-dim)'`; `:765` `'#ef4444'` → `'var(--s2-danger)'`; `:779` `'#666'` → `'var(--s2-text-dim)'`.

Where the active tab is drawn with `#facc15` or `#4a9eff`, apply the selection rule from Global Constraints: a filled tint (`#fef3c7` background with `--s2-selected` border and text) rather than bare yellow on white.

- [ ] **Step 5: Run the gate and the full suite**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/themeTokens.test.js && npm test`
Expected: both green. The gate now covers all 7 files with `PENDING` empty.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/Something2.jsx frontend/src/games/something2/__tests__/themeTokens.test.js
git commit -m "feat(theme): tokenize Something2 shell and tab strip"
```

---

### Task 8: Amend the styleguide and verify in the browser

The styleguide currently forbids this entire change. Leaving it unamended means the next agent reads a rule that contradicts the code and "fixes" it back.

**Files:**
- Modify: `.ai/styleguides/frontend.md:17`

**Interfaces:**
- Consumes: the completed sweep (Tasks 2-7).

- [ ] **Step 1: Replace the line**

`.ai/styleguides/frontend.md:17` currently reads:

> The in-game UI (e.g. [frontend/src/games/something2/Something2.jsx](../../frontend/src/games/something2/Something2.jsx)) intentionally uses its own dark gaming palette with hardcoded hex (`#0f0f1a`, `#1a1a2e`, `#facc15`, `#4a9eff`, ...). This is deliberate visual separation from the admin/dashboard UI — don't "fix" it by replacing with tokens.

Replace with:

> The **game surfaces** — the canvas viewport, `Minimap.jsx`, and the cytoscape stylesheet in `MapGraphAdmin.jsx` — intentionally stay dark in both modes and keep hardcoded hex. This is deliberate visual separation from the admin/dashboard UI; don't "fix" it by replacing with tokens. The **admin tabs** inside the game route (`TileTypesAdmin`, `EntityTypesAdmin`, `ItemTypesAdmin`, `BiomesAdmin`, `MapsAdmin`, `MapGraphAdmin` chrome, and the `Something2.jsx` tab strip) are admin UI and use `--s2-*` tokens, which swap per mode like every other token. `src/games/something2/__tests__/themeTokens.test.js` enforces this: any new hex literal in those files fails the suite unless marked `s2-theme-exempt`. Tile and entity `color` form defaults are **data**, not chrome, and are exempt.

- [ ] **Step 2: Verify the full suite is green**

Run: `cd frontend && npm test`
Expected: all frontend tests pass.

- [ ] **Step 3: Browser-verify both modes**

This is the only behavioural gate — `environment: "node"` means no rendered styling is asserted anywhere.

The dev stack serves the **main working-dir checkout** at `http://localhost:15173/game-something2`; a scratchpad worktree is invisible to it. **Never `docker restart` the containers** — their CMD is a `tail -f /dev/null` stub, so restarting kills vite/nodemon with nothing to bring them back.

Toggle light and dark, and in **each** mode check every tab — Game View, TILE_TYPES Admin, Entity Admin, Items, Maps, Biomes, World Map — confirming:
  - text is legible on its surface everywhere; no dark-on-dark or light-on-light
  - the active tab is clearly distinguishable from inactive ones
  - inputs and cards have visible outlines
  - disabled buttons read as disabled
  - destructive (trash) icons remain clearly destructive
  - the game canvas and minimap stay dark in **both** modes
  - the World Map graph still renders with its dark node styling
  - dark mode is unchanged from before this branch, apart from the three approved convergences

Drive the states the gate cannot reach: an empty list, a failed query error screen, a confirmation dialog, and the `MapGraphAdmin` lint banner.

- [ ] **Step 4: Commit**

```bash
git add .ai/styleguides/frontend.md
git commit -m "docs(styleguide): scope the hardcoded-palette exemption to game surfaces"
```

---

## Verification strategy

1. **Token definitions** — Task 1's test asserts all 26 tokens exist in both mode blocks with contract values, and guards its own block-slicing helper against vacuity.
2. **Completeness** — the source gate asserts swept files contain zero non-exempt literals *and* that pending files are still dirty, so a file cannot be quietly dropped and the list cannot rot.
3. **Correctness of role assignment** — browser only. A token applied to the wrong role looks perfect in dark and unreadable in light; nothing automated can catch it.

## Acceptance criteria

- Toggling dark mode changes the appearance of all seven admin tabs.
- All text meets WCAG AA in light mode (values pre-measured in the contract).
- The game canvas, minimap and graph node styling stay dark in both modes.
- Dark mode is otherwise visually unchanged.
- `PENDING === []` and the full frontend suite is green.
- `.ai/styleguides/frontend.md` no longer contradicts the code.

## Known risks

- **Wrong-role tokens are invisible to every automated check.** Highest-value target for review and the browser pass.
- **Selection styling is not a swap.** `--s2-selected` on white reads as a warning; the filled-tint rule must be applied wherever selection is drawn, and it is the most likely thing to be missed.
- **Sentinel placement in `MapGraphAdmin.jsx` and `Something2.jsx`** is the one place a chrome literal could silently escape the gate by falling inside an exempt region. Reviewers should check the sentinel boundaries specifically.
- **The neutral button's light fill is low-contrast against the page by necessity.** `--s2-btn-neutral` `#e2e2ea` sits at 1.17:1 against `#f4f4f8`; no light grey reaches 3:1 against a near-white page (`#9a9ab0` only gets to 2.51:1 and stops looking neutral). Its label is 13.24:1, so the control is identifiable by text and shape, which satisfies WCAG 1.4.11 — that clause governs boundaries that *carry* information, not every fill. The robust fix is a `border: 1px solid var(--s2-btn-neutral-border)` (dark `#555`, invisible against its own fill; light `#8b8ba3`, 3.32:1), but adding a border is a **non-colour change** and `MapsAdmin.jsx:100,103` is under a colours-only freeze. Left as a follow-up rather than smuggled in.
- **Disabled label contrast is 4.42:1** (`--s2-text-dim` on `--s2-disabled-bg`), just under AA. WCAG 1.4.3 exempts disabled controls, and the shortfall is the disabled signal. Intentional.
- **Two of the three dark-mode convergences (`#e6e6f0`→`#eee`, `#666`→`#888`) were not explicitly approved** — they apply the principle approved for `#333`→`#2e2e3e`. Reject at Task 1 if unwanted; each becomes a separate token with an identical light value.
- Literal counts come from `grep` over current `main` (`8ea4946`). If another session lands changes in these files first, counts shift and the gate — not the counts — is authoritative.
