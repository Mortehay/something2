# Something2 Admin — Light Mode Design Contract

**Status:** design contract, not yet planned or implemented.
**Date:** 2026-07-31

## Problem

`DarkModeContext` toggles a `.dark-mode` class on `documentElement`, and `GlobalStyles.js`
swaps `--color-*` token values under it. The `games/something2` subtree consumes none of
those tokens — 238 hardcoded hex literals across 8 files, 0 `var(--color…)` references — so
the toggle has no effect there.

`useLocalStorageState(false, "isDarkMode")` means **light is the default mode**, so this is
what every fresh profile sees on first load: light app chrome wrapping a permanently dark
game section.

## Governing constraint and its resolved reading

`.ai/styleguides/frontend.md:17` states the in-game UI "intentionally uses its own dark
gaming palette with hardcoded hex … don't 'fix' it by replacing with tokens."

**Resolved reading (approved):** that exemption covers the *game* surfaces — the canvas
viewport, the HUD, and `Minimap.jsx`. The seven admin tabs are CRUD admin tooling that
merely lives inside the game route, and the same styleguide requires admin UI to use tokens.

**This change must amend `.ai/styleguides/frontend.md:17`** to state the boundary
explicitly, so code and docs stop contradicting each other.

## Scope

**In scope — tokenize:**
- `Something2.jsx` — tab strip and page chrome only, *not* the canvas viewport
- `TileTypesAdmin.jsx`, `EntityTypesAdmin.jsx`, `ItemTypesAdmin.jsx`, `BiomesAdmin.jsx`
- `MapsAdmin.jsx` — **colour literals only**; no logic, hooks, JSX-structure or behaviour changes
- `MapGraphAdmin.jsx` — the ~18 styled-components literals

**Out of scope — stays hardcoded dark:**
- The game canvas viewport and `Minimap.jsx` (HUD overlay on the canvas)
- `MapGraphAdmin.jsx:237-304` — the cytoscape stylesheet object (13 literals). Cytoscape
  renders to canvas and cannot read CSS custom properties; theming it needs a
  `getComputedStyle` bridge plus forced re-render. Deliberately excluded.
- Biome ring SVGs (`biomeRingSvg.js`) — colours are biome *data*, not chrome

## Audience and workflow

Single-operator admin tooling for the project owner. Dense, data-heavy: long scrolling
lists, inline forms, destructive actions. Not a consumer surface — clarity and state
legibility beat visual polish. Sessions are long, which is why the dark appearance must not
regress.

## Visual direction

**Dark mode must render pixel-identical to today.** It is the mode in daily use, and the
admin chrome sits directly against the dark game viewport — the indigo cast is what keeps
that seam coherent. Every dark value below is copied verbatim from current source.

Light mode is a purpose-built ramp, not an inversion: near-white surfaces with a faint
indigo tint so the section still reads as part of the game tooling rather than as the
dashboard.

## Colour roles

Two ramps exist in the current code and both carry over: an **indigo scale** for surfaces
and borders, and a **neutral grey scale** for text.

### Surfaces and borders

| Token | Dark (verbatim) | Light | Role |
|---|---|---|---|
| `--s2-bg` | `#0f0f1a` | `#f4f4f8` | page backdrop (9 uses) |
| `--s2-bg-sunken` | `#12121f` | `#ececf3` | inset / secondary backdrop |
| `--s2-surface-subtle` | `#161625` | `#f7f7fb` | list row default |
| `--s2-surface` | `#1a1a2e` | `#ffffff` | primary panel/card (12 uses) |
| `--s2-surface-raised` | `#23233f` | `#f0f0f6` | inputs, elevated surfaces |
| `--s2-border` | `#2e2e3e` | `#d4d4e0` | decorative separators |
| `--s2-border-strong` | `#3a3a4e` | `#8b8ba3` | input/control outlines |

**Approved deviation from pixel-identical dark:** `#333` (6 uses — cards and inputs in
`MapGraphAdmin.jsx:30,33`, `BiomesAdmin.jsx:19,22`, `MapsAdmin.jsx:22,26`) does the same job
as `#2e2e3e` and **converges into `--s2-border`**. Those 6 sites shift `rgb(51,51,51)` →
`rgb(46,46,62)` — blue channel only, imperceptible in place. This is the single intentional
dark-mode change; every other dark value stays verbatim.

`--s2-border-strong` is the token for anything delineating an interactive control. At
3.32:1 on white it meets WCAG 1.4.11 (3:1 non-text). `--s2-border` is decorative only
(1.47:1) and must **not** be used for input outlines.

### Text

| Token | Dark | Light | Contrast on `#f4f4f8` |
|---|---|---|---|
| `--s2-text` | `#e6e6f0` / `#eee` | `#1a1a2e` | 15.55:1 |
| `--s2-text-muted` | `#aaa` (18 uses) | `#4a4a5e` | 7.87:1 |
| `--s2-text-dim` | `#888` (13 uses) | `#6b6b80` | 4.74:1 |

Verified: `#aaa`, `#888`, `#eee`, `#ccc` are used **exclusively** as `color:` — no role
collapse in the text ramp.

### Control surfaces — `#555` must split three ways

`#555` currently serves three unrelated roles that are indistinguishable in dark mode and
must diverge in light. Mapping them to one token is a defect, not a simplification.

| Token | Dark | Light | Role and sites |
|---|---|---|---|
| `--s2-btn-neutral` | `#555` | `#6b6b80` bg / white label (5.20:1), same as dark | secondary buttons passed as props: `MapsAdmin.jsx:100,103`, `MapGraphAdmin.jsx:611` (Cancel), `:651` (Link mode off) |
| `--s2-disabled-bg` | `#555` | `#ececf3` | `&:disabled` in `ItemTypesAdmin.jsx:237`, `TileTypesAdmin.jsx:274`, `EntityTypesAdmin.jsx:362` |
| `--s2-swatch-border` | `#555` | `#8b8ba3` | colour-swatch outline, `BiomesAdmin.jsx:28` |

Disabled controls pair `--s2-disabled-bg` with `--s2-text-dim`; the contrast drop is the
disabled signal, alongside `cursor: not-allowed` — never opacity alone.

**Colours travel as props, not only in styled templates.** `<Button $bg="#555">` is a
supported pattern here (styled-components 6 transient props, see
`.ai/styleguides/frontend.md:38`). Passing `var(--s2-btn-neutral)` as the prop value works,
since it resolves in CSS — but the source gate must match prop-position literals or it will
pass while missing these four call sites.

### Accents

**Every current accent fails WCAG AA on light surfaces** — measured, not assumed:
`#4a9eff` 2.51:1, `#facc15` 1.40:1, `#ef4444` 3.43:1, `#22c55e` 2.08:1, `#f59e0b` 1.96:1,
`#10b981` 2.31:1 (all against `#f4f4f8`). None may be reused in light mode.

| Token | Dark | Light | Contrast on `#f4f4f8` |
|---|---|---|---|
| `--s2-accent` | `#4a9eff` (29 uses) | `#2563eb` | 4.71:1 |
| `--s2-selected` | `#facc15` (28 uses) | `#946005` | 4.87:1 |
| `--s2-danger` | `#ef4444` (13 uses) | `#b91c1c` | 5.90:1 |
| `--s2-success` | `#22c55e` | `#15803d` | 4.57:1 |
| `--s2-warning` | `#f59e0b` | `#b45309` | 4.58:1 |
| `--s2-success-alt` | `#10b981` | `#047857` | 5.00:1 |

The light accents deliberately coincide with the app's existing light tokens
(`--color-red-700` `#b91c1c`, `--color-green-700` `#15803d`), so the two systems agree
where they overlap.

## Interaction states

- **Selected** — the largest visual risk. Dark mode uses `#facc15` as a bright glow against
  near-black. On a white surface a saturated yellow reads as a warning, not a selection.
  Light mode uses a filled tint: background `#fef3c7` with a `#946005` border/text, never
  bare yellow on white.
- **Hover** — one step along the surface ramp (`--s2-surface` → `--s2-surface-raised`),
  same in both modes.
- **Focus** — 2px `--s2-accent` outline. Must remain visible in both modes; do not rely on
  border-colour change alone.
- **Disabled** — `--s2-text-dim` on `--s2-bg-sunken`. Do not convey disabled state by
  opacity alone.
- **Destructive** — `--s2-danger` for both text and border on delete controls.

## Non-colour states to verify

Loading, empty list, query error, disabled buttons, confirmation dialogs, and the
`MapGraphAdmin` lint banner all carry their own literals and are reachable only by driving
the UI. They are the most likely place for a missed token to survive.

## Anti-patterns

- Do **not** tokenize the cytoscape stylesheet, the canvas, or `Minimap.jsx`.
- Do **not** reuse a dark-mode accent in light mode "because it looks fine" — all six were
  measured and all six fail.
- Do **not** use `--s2-border` on inputs; it is below 3:1.
- Do **not** change `MapsAdmin.jsx` beyond colour literals.
- Do **not** introduce new hex literals; add a token instead
  (`.ai/styleguides/frontend.md:15`).
- Do **not** let dark mode drift. Any dark value differing from the table above is a
  regression, not a refinement.

## Acceptance

1. **Source gate** — a node-env test greps the in-scope files for hex literals outside an
   explicit allowlist (cytoscape block, canvas, biome-ring data colours) and fails on any
   survivor. This is the only mechanical check available: `vitest` runs
   `environment: "node"` in this repo, so no DOM, no jsdom, no RTL, and rendered styling
   cannot be asserted.
2. **Browser pass** — every tab in both modes. The gate proves completeness; only eyes
   catch a token applied with the wrong role, which looks correct in dark and unreadable in
   light.
3. **Styleguide amended** so `.ai/styleguides/frontend.md:17` matches the new boundary.

---

## Amendment 1 — the colour surface is larger than this contract first stated

**Found during execution, after Task 3.** The original inventory was built from a
frequency-sorted list of six-digit hex and covered only the head of it. The real surface:

| File | hex | `rgba()` | `white`/`black` | total |
|---|---|---|---|---|
| `Something2.jsx` | 52 | 15 | 2 | 69 |
| `EntityTypesAdmin.jsx` | 50 | 27 | 3 | 80 |
| `MapsAdmin.jsx` | 32 | 0 | 1 | 33 |
| `MapGraphAdmin.jsx` | 31 | 0 | 1 | 32 |
| `TileTypesAdmin.jsx` | 4 | 15 | 3 | 22 |
| `ItemTypesAdmin.jsx` | 6 | 14 | 3 | 23 |

**~260 items, not 217.** The source gate matches hex only, so 71 `rgba()` values and 14
colour keywords — 33% of the work — were invisible to it. `color: white` appears 14 times
and becomes white-on-white in light mode while the gate reports green. The claim that
completeness was mechanically verified was false for a third of the surface.

### Gate must additionally catch

- `rgba(...)` / `rgb(...)` in any property
- bare colour keywords in a colour position: `white`, `black`, `red`, `green`, `blue`
  (`transparent` is legitimate and stays allowed)
- eight-digit hex with alpha (`#facc1533`, `#4ade8055`) — the existing `{3,8}` match already
  covers these, but they need tokens rather than exemptions

### Additional solid tokens

| Token | Dark | Light | Role |
|---|---|---|---|
| `--s2-row` | `#1f1f35` | `#eaeaf2` | unselected list row |
| `--s2-btn-primary` | `#3a7ed8` | `#1d4ed8` | primary button idle (white label 6.70:1) |
| `--s2-btn-info` | `#3b82f6` | `#1d4ed8` | non-danger action button |
| `--s2-btn-grey` | `#4b5563` | `#d0d0dc` | tertiary button |
| `--s2-btn-purple` | `#8b5cf6` | `#6d28d9` | purple action button (7.10:1) |
| `--s2-variant-gpu` | `#4ade80` | `#15803d` | GPU-variant indicator (5.02:1) |
| `--s2-tab-entity` | `#facc15` | `#946005` | tab identity (4.87:1 as text) |
| `--s2-tab-items` | `#f472b6` | `#be185d` | tab identity (5.50:1) |
| `--s2-tab-maps` | `#34d399` | `#047857` | tab identity (5.00:1) |

**Primary button hover must stay distinguishable.** `--s2-btn-primary` idle and
`--s2-accent` hover differ by 1.30:1 in light mode. Task 3 collapsed both into
`--s2-accent`, removing the hover feedback; that is a defect to repair.

### Translucent tokens — light counterparts invert direction

On a dark surface a white overlay *lifts*; on a light surface the equivalent must *darken*.
A lighter white on white is invisible. This is the single most error-prone part of the
remaining sweep.

| Token | Dark | Light |
|---|---|---|
| `--s2-overlay-subtle` | `rgba(255,255,255,0.03)` | `rgba(0,0,0,0.02)` |
| `--s2-overlay` | `rgba(255,255,255,0.05)` | `rgba(0,0,0,0.035)` |
| `--s2-hairline` | `rgba(255,255,255,0.1)` | `rgba(0,0,0,0.08)` |
| `--s2-hairline-strong` | `rgba(255,255,255,0.3)` | `rgba(0,0,0,0.18)` |
| `--s2-text-ghost` | `rgba(255,255,255,0.4)` | `rgba(0,0,0,0.45)` |
| `--s2-scrim` | `rgba(0,0,0,0.8)` | `rgba(0,0,0,0.45)` |
| `--s2-scrim-soft` | `rgba(0,0,0,0.5)` | `rgba(0,0,0,0.28)` |
| `--s2-shadow` | `rgba(0,0,0,0.4)` | `rgba(0,0,0,0.14)` |
| `--s2-panel-veil` | `rgba(26,26,46,0.85)` | `rgba(255,255,255,0.9)` |
| `--s2-panel-veil-solid` | `rgba(46,46,74,0.95)` | `rgba(255,255,255,0.96)` |
| `--s2-accent-tint` | `rgba(74,158,255,0.1)` | `rgba(37,99,235,0.08)` |
| `--s2-accent-tint-strong` | `rgba(74,158,255,0.3)` | `rgba(37,99,235,0.22)` |
| `--s2-selected-tint` | `rgba(250,204,21,0.1)` | `rgba(148,96,5,0.10)` |
| `--s2-selected-tint-strong` | `rgba(250,204,21,0.3)` | `rgba(148,96,5,0.28)` |

Near-miss alpha values (`0.15`, `0.2`, `0.35`, `0.6`, `0.85`) map to the nearest token
above; exact alpha preservation is not required, and converging them is intended.

### `color: white`

Where white sits on a coloured or accent fill, it is `--s2-on-accent` and stays white.
Everywhere else it is `--s2-text-strong` and must invert. Decide per site by asking what is
behind it — this is the same split already defined for `#fff`.

## Amendment 2 — `color-mix()` for one-off tints

Sanctioned technique for a translucent tint with no authored token:

```css
color-mix(in srgb, var(--s2-accent) 20%, transparent)
```

Because it derives from the *current mode's* token value, hue correctness across modes is
automatic, and the neutral-overlay direction-inversion trap in Amendment 1 does not apply —
these are coloured tints, not white/black lifts. Verified: the source gate still catches a
raw literal hidden inside `color-mix()`, so this is not a detection bypass.

Ratified on its own merits. It first appeared in commit `3f4ecb5` and was later justified as
"existing precedent", which was circular — `color-mix` appears nowhere on `main`.

**Known gap:** authored tint tokens deliberately reduce alpha in light mode
(`--s2-accent-tint` 0.1 → 0.08, `--s2-accent-tint-strong` 0.3 → 0.22) because a tint reads
stronger on a light surface. `color-mix()` uses the same percentage in both modes and does
not get that tuning. The delta is small and acceptable for one-offs; a repeated family
should become real tokens instead. `EntityTypesAdmin.jsx`'s `CapabilityBanner` (6 uses) is
the outstanding candidate.

**Also unratified:** `ItemTypesAdmin.jsx:76` `CategoryBadge` (`#7f1d1d`/`#14532d`/`#1e3a8a`)
was exempted as fixed category styling. It is chrome, not per-record data, so it stays dark
in light mode rather than getting purpose-built values — inconsistent with the rest of the
ramp. It renders legibly either way (white on saturated fill). Either promote to three
category-identity tokens alongside `--s2-tab-*`, or ratify the exemption class.
