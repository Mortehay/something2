# Sidebar Navigation & URL-Driven Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the seven `Something2` tabs out of the horizontal `TabBar` into the left sidebar as real, addressable routes, without ever tearing down the live game canvas.

**Architecture:** `GameShell` becomes a React Router *layout route* that owns the `<canvas>` and the `Game` instance; the six admin panels become its child routes, so navigating between them never remounts the parent and the world stays connected. Auth state lifts out of the game component into an `AuthProvider` so the sidebar (which sits above the game in the tree) can decide what to render. `Something2.jsx` splits into `GameShell.jsx` (what must outlive navigation) and `GameView.jsx` (the game view's own UI).

**Tech Stack:** React 19, react-router-dom 7, styled-components 6, TanStack Query 5, vitest 3 (plain **node** environment — no jsdom, no React Testing Library).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-01-sidebar-nav-routing-design.md`. Read it before Task 1.
- **vitest runs in a plain node environment.** There is no DOM and no RTL. Tests are pure-function tests or source-text regression tests. Follow the existing convention in `frontend/src/games/something2/__tests__/` — do **not** add jsdom.
- All commands run from `frontend/`.
- Baseline before any change: `npm test` → **70 files, 531 tests passing**. Every task must leave it green.
- Colour literals inside `frontend/src/games/something2/*.jsx` are gated by `__tests__/themeTokens.test.js`. Use `--s2-*` CSS vars there, or carry an existing `// s2-theme-exempt(<literal>): <reason>` sentinel comment along with the code it exempts.
- App chrome (`frontend/src/ui/`, `frontend/src/context/`) uses the `--color-*` palette and is **not** gated.
- Base route path is `/game` (renamed from `game-something2`).
- Never remove the comment blocks explaining the always-mounted canvas, the `handleEnterRef` staleness fix, or the token-revocation checks. They document defects that were paid for once already.

---

### Task 0: Branch

- [ ] **Step 1: Create the working branch**

The spec is already committed on `main`. Start the implementation from there.

```bash
cd /home/markunn/worker/coding/jsgame/something2
git checkout -b feat/sidebar-nav-routing
```

- [ ] **Step 2: Confirm the baseline is green**

Run: `cd frontend && npm test`
Expected: `Test Files  70 passed (70)` / `Tests  531 passed (531)`

---

### Task 1: Shared API URL + auth derivation + AuthProvider

**Files:**
- Create: `frontend/src/config.js`
- Create: `frontend/src/context/authState.js`
- Create: `frontend/src/context/AuthContext.jsx`
- Test: `frontend/src/context/__tests__/authState.test.js`

**Interfaces:**
- Consumes: `parseJwt`, `getStoredToken`, `clearToken`, `authHeaders`, `AUTH_EXPIRED_EVENT` from `frontend/src/games/something2/src/js/net/auth.js` (all already exported).
- Produces:
  - `API_URL: string` from `frontend/src/config.js`
  - `deriveAuth(token: string | null) => { authed: boolean, isAdmin: boolean, username: string | null }`
  - `<AuthProvider>` and `useAuth() => { authed, isAdmin, username, signIn(token?), signOut() }`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/context/__tests__/authState.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { deriveAuth } from '../authState.js';

// Mirrors what backend/src/auth/tokens.js signs: { user_id, username, role, tv }.
// Padding is stripped, exactly as jsonwebtoken emits it.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const makeToken = (payload) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;

describe('deriveAuth', () => {
  it('reports signed out for a null token', () => {
    expect(deriveAuth(null)).toEqual({ authed: false, isAdmin: false, username: null });
  });

  it('reports signed out for a malformed token rather than throwing', () => {
    expect(deriveAuth('not-a-jwt')).toEqual({ authed: false, isAdmin: false, username: null });
  });

  it('reports a non-admin player as authed but not admin', () => {
    const t = makeToken({ user_id: 3, username: 'player1', role: 'user', tv: 1 });
    expect(deriveAuth(t)).toEqual({ authed: true, isAdmin: false, username: 'player1' });
  });

  it('reports an admin as authed and admin', () => {
    const t = makeToken({ user_id: 1, username: 'admin', role: 'admin', tv: 4 });
    expect(deriveAuth(t)).toEqual({ authed: true, isAdmin: true, username: 'admin' });
  });

  it('does not treat a role that merely contains "admin" as admin', () => {
    const t = makeToken({ user_id: 9, username: 'x', role: 'not-admin', tv: 1 });
    expect(deriveAuth(t).isAdmin).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/context/__tests__/authState.test.js`
Expected: FAIL — `Failed to resolve import "../authState.js"`

- [ ] **Step 3: Write the derivation**

Create `frontend/src/context/authState.js`:

```js
import { parseJwt } from "../games/something2/src/js/net/auth.js";

// Derive the whole auth view-model from the raw JWT. Deliberately pure and
// React-free so the rule that decides who sees the admin nav can be unit-tested
// in the plain node vitest env, which has no DOM.
//
// A malformed or absent token yields the signed-out shape rather than throwing.
// getStoredToken() already drops expired and unparseable tokens, so anything
// that reaches here and fails to parse is treated as "not signed in".
export function deriveAuth(token) {
  const claims = token ? parseJwt(token) : null;
  return {
    authed: !!claims,
    isAdmin: claims?.role === "admin",
    username: claims?.username ?? null,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/context/__tests__/authState.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Create the shared API URL module**

Create `frontend/src/config.js`:

```js
// Single source for the backend base URL. The auth context and the login route
// both talk to the same API; one definition stops them drifting apart in a
// container where VITE_API_URL is only half configured.
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:13101';
```

- [ ] **Step 6: Create the provider**

Create `frontend/src/context/AuthContext.jsx`. The two effects are moved verbatim in behaviour from `Something2.jsx:404-431` — including their comments, which document real defects.

```jsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { API_URL } from "../config";
import {
  getStoredToken, clearToken, authHeaders, AUTH_EXPIRED_EVENT,
} from "../games/something2/src/js/net/auth.js";
import { deriveAuth } from "./authState";

const AuthContext = createContext(null);

function AuthProvider({ children }) {
  // Source of truth for "who is signed in". Initialised from storage so a page
  // reload keeps the session instead of minting a new anonymous user
  // (SOMET-97); getStoredToken() clears an expired/malformed token itself.
  const [token, setToken] = useState(() => getStoredToken());
  const { authed, isAdmin, username } = useMemo(() => deriveAuth(token), [token]);

  // Login.jsx calls storeToken() itself before invoking onAuthed(), so the
  // default re-reads storage rather than making the caller hand it over twice.
  const signIn = useCallback((next = getStoredToken()) => setToken(next), []);

  const signOut = useCallback(() => {
    clearToken();
    setToken(null);
  }, []);

  // A token can be REVOKED while still being well-formed and unexpired: any
  // token_version bump (logout-everywhere, `make admin-password`) leaves the
  // stored JWT parsing fine, so the derivation above happily reports "signed in
  // as admin" while the server 401s every write. That zombie session looks like
  // a broken app -- admin screens render, saving silently fails.
  // Only the server knows about token_version, so ask it once.
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/auth/me`, { headers: authHeaders() });
        if (cancelled || res.status !== 401) return;   // network/5xx: keep the session
        signOut();
        toast.error("Session expired — please sign in again");
      } catch { /* offline: leave the session alone rather than logging out */ }
    })();
    return () => { cancelled = true; };
  }, [authed, signOut]);

  // The check above only catches a token that was ALREADY dead. A session
  // revoked while this tab is open (someone rotates the admin password, or hits
  // logout-everywhere) is caught here instead: apiFetch clears the token on any
  // 401 and fires this event, so the UI stops pretending to be signed in the
  // moment a request is actually rejected. The token is already cleared from
  // storage by noteAuthFailure, so this only has to drop the in-memory state.
  useEffect(() => {
    const onExpired = () => {
      setToken(null);
      toast.error("Session expired — please sign in again");
    };
    globalThis.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => globalThis.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const value = useMemo(
    () => ({ authed, isAdmin, username, signIn, signOut }),
    [authed, isAdmin, username, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

export { AuthProvider, useAuth };
```

Nothing renders `AuthProvider` yet — that happens in Task 4.

- [ ] **Step 7: Run the full suite**

Run: `cd frontend && npm test`
Expected: `Test Files  71 passed (71)` / `Tests  536 passed (536)`

- [ ] **Step 8: Commit**

```bash
git add frontend/src/config.js frontend/src/context/authState.js \
        frontend/src/context/AuthContext.jsx \
        frontend/src/context/__tests__/authState.test.js
git commit -m "feat(auth): lift session state into an AuthProvider"
```

---

### Task 2: Route guards

**Files:**
- Create: `frontend/src/ui/routeGuards.js`
- Create: `frontend/src/ui/RequireAuth.jsx`
- Create: `frontend/src/ui/RequireAdmin.jsx`
- Test: `frontend/src/ui/__tests__/routeGuards.test.js`

**Interfaces:**
- Consumes: `useAuth()` from Task 1.
- Produces: `guardRedirect({ authed, isAdmin, requireAdmin }) => string | null`, plus the `RequireAuth` and `RequireAdmin` route components (default exports).

Why this exists: today a non-admin cannot reach an admin tab because the *button* is not rendered. Once the tabs are URLs, a non-admin can type one. The old `{isAdmin && activeTab === 'tiles' && …}` pattern would render an empty content area. The server's `adminGuard` is still the real enforcement; this is the UX half.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/ui/__tests__/routeGuards.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { guardRedirect } from '../routeGuards.js';

describe('guardRedirect', () => {
  it('sends a signed-out visitor to the login screen', () => {
    expect(guardRedirect({ authed: false, isAdmin: false })).toBe('/login');
  });

  it('sends a signed-out visitor to login even on an admin route', () => {
    expect(guardRedirect({ authed: false, isAdmin: false, requireAdmin: true })).toBe('/login');
  });

  it('lets a signed-in non-admin through a non-admin route', () => {
    expect(guardRedirect({ authed: true, isAdmin: false })).toBeNull();
  });

  it('bounces a signed-in non-admin off an admin route to the game view', () => {
    expect(guardRedirect({ authed: true, isAdmin: false, requireAdmin: true })).toBe('/game');
  });

  it('lets an admin through an admin route', () => {
    expect(guardRedirect({ authed: true, isAdmin: true, requireAdmin: true })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/ui/__tests__/routeGuards.test.js`
Expected: FAIL — `Failed to resolve import "../routeGuards.js"`

- [ ] **Step 3: Write the decision function**

Create `frontend/src/ui/routeGuards.js`:

```js
// Where a guarded route should send this visitor, or null to let them through.
// Kept as a plain function (no router, no React) so the gating rule is testable
// in the node vitest env. Signed-out always wins over the admin check: someone
// with no session should land on the login screen, not on the game view.
export function guardRedirect({ authed, isAdmin, requireAdmin = false }) {
  if (!authed) return "/login";
  if (requireAdmin && !isAdmin) return "/game";
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/ui/__tests__/routeGuards.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Write the guard components**

Create `frontend/src/ui/RequireAuth.jsx`:

```jsx
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { guardRedirect } from "./routeGuards";

// Wraps everything behind the sign-in wall. Rendering the login screen OUTSIDE
// the app layout (rather than inside Main, as it used to be) means a signed-out
// visitor doesn't get an empty sidebar and header framing the login form.
function RequireAuth() {
  const { authed } = useAuth();
  const to = guardRedirect({ authed, isAdmin: false });
  return to ? <Navigate to={to} replace /> : <Outlet />;
}

export default RequireAuth;
```

Create `frontend/src/ui/RequireAdmin.jsx`:

```jsx
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { guardRedirect } from "./routeGuards";

// The admin panels are addressable now, so a non-admin can type their URL.
// Without this they would render a blank content area. The server's adminGuard
// is still the actual enforcement -- this is UX and defence in depth.
function RequireAdmin() {
  const { authed, isAdmin } = useAuth();
  const to = guardRedirect({ authed, isAdmin, requireAdmin: true });
  return to ? <Navigate to={to} replace /> : <Outlet />;
}

export default RequireAdmin;
```

- [ ] **Step 6: Run the full suite**

Run: `cd frontend && npm test`
Expected: `Test Files  72 passed (72)` / `Tests  541 passed (541)`

- [ ] **Step 7: Commit**

```bash
git add frontend/src/ui/routeGuards.js frontend/src/ui/RequireAuth.jsx \
        frontend/src/ui/RequireAdmin.jsx frontend/src/ui/__tests__/routeGuards.test.js
git commit -m "feat(routing): add RequireAuth and RequireAdmin route guards"
```

---

### Task 3: Navigation definitions

**Files:**
- Create: `frontend/src/ui/navSections.js`
- Test: `frontend/src/ui/__tests__/navSections.test.js`

**Interfaces:**
- Produces:
  - `NAV_SECTIONS: Array<{ title: string | null, adminOnly: boolean, items: NavItem[] }>`
  - `NavItem: { id: string, label: string, path: string, Icon: ComponentType, adminType?: 'entity' | 'items' | 'maps' }`
  - `visibleSections(isAdmin: boolean) => NAV_SECTIONS subset`

Icons live in this module, not in `MainNav`, so label/path/icon/colour cannot drift apart. Importing `react-icons/hi2` in the node vitest env is verified to work and costs ~10ms.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/ui/__tests__/navSections.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { NAV_SECTIONS, visibleSections } from '../navSections.js';

const allItems = (sections) => sections.flatMap((s) => s.items);

describe('NAV_SECTIONS', () => {
  it('gives every item an id, label, path and icon', () => {
    for (const item of allItems(NAV_SECTIONS)) {
      expect(item.id, `${item.label} id`).toBeTruthy();
      expect(item.label, `${item.id} label`).toBeTruthy();
      expect(item.path, `${item.id} path`).toMatch(/^\/game/);
      expect(typeof item.Icon, `${item.id} icon`).toBe('function');
    }
  });

  it('has no duplicate paths or ids', () => {
    const items = allItems(NAV_SECTIONS);
    expect(new Set(items.map((i) => i.path)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('only uses admin colour keys the tab bar already defined', () => {
    for (const item of allItems(NAV_SECTIONS)) {
      if (item.adminType) expect(['entity', 'items', 'maps']).toContain(item.adminType);
    }
  });
});

describe('visibleSections', () => {
  it('shows a non-admin only the game view', () => {
    const items = allItems(visibleSections(false));
    expect(items.map((i) => i.path)).toEqual(['/game']);
  });

  it('shows an admin the game view plus all six admin screens', () => {
    const items = allItems(visibleSections(true));
    expect(items).toHaveLength(7);
    expect(items.map((i) => i.path)).toEqual([
      '/game', '/game/tiles', '/game/entities', '/game/items',
      '/game/maps', '/game/biomes', '/game/world-map',
    ]);
  });

  it('hides every admin-only section from a non-admin', () => {
    expect(visibleSections(false).some((s) => s.adminOnly)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/ui/__tests__/navSections.test.js`
Expected: FAIL — `Failed to resolve import "../navSections.js"`

- [ ] **Step 3: Write the definitions**

Create `frontend/src/ui/navSections.js`:

```js
import {
  HiOutlinePuzzlePiece, HiOutlineWrenchScrewdriver, HiOutlineBeaker,
  HiOutlineCube, HiOutlineMap, HiOutlineGlobeAlt, HiOutlineShare,
} from "react-icons/hi2";

// One source of truth for the sidebar: label, route, icon and the admin colour
// coding inherited from the old TabBar. Route paths here MUST match the child
// routes registered in App.jsx -- navRoutes.test.js checks that they do.
//
// `adminType` reproduces the TabBar's colour groups (entity=yellow,
// items=pink, maps=green) as the active link's accent stripe, so the visual
// grouping players and admins already learned survives the move to a sidebar.
export const NAV_SECTIONS = [
  {
    title: null,          // no heading -- this is the default destination
    adminOnly: false,
    items: [
      { id: 'game', label: 'Game View', path: '/game', Icon: HiOutlinePuzzlePiece },
    ],
  },
  {
    title: 'Admin',
    adminOnly: true,
    items: [
      { id: 'tiles',    label: 'Tile Types', path: '/game/tiles',     Icon: HiOutlineWrenchScrewdriver },
      { id: 'entities', label: 'Entities',   path: '/game/entities',  Icon: HiOutlineBeaker,  adminType: 'entity' },
      { id: 'items',    label: 'Items',      path: '/game/items',     Icon: HiOutlineCube,    adminType: 'items' },
      { id: 'maps',     label: 'Maps',       path: '/game/maps',      Icon: HiOutlineMap,     adminType: 'maps' },
      { id: 'biomes',   label: 'Biomes',     path: '/game/biomes',    Icon: HiOutlineGlobeAlt, adminType: 'maps' },
      { id: 'worldmap', label: 'World Map',  path: '/game/world-map', Icon: HiOutlineShare,   adminType: 'maps' },
    ],
  },
];

// The sections this visitor may see. Admin-only sections are dropped entirely
// rather than rendered empty, so the "Admin" heading never appears alone.
export function visibleSections(isAdmin) {
  return NAV_SECTIONS.filter((section) => !section.adminOnly || isAdmin);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/ui/__tests__/navSections.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ui/navSections.js frontend/src/ui/__tests__/navSections.test.js
git commit -m "feat(nav): define the sidebar sections and admin gating"
```

---

### Task 4: Route tree + split Something2.jsx into GameShell and GameView

This is the largest task and it is **atomic** — the app does not build between the halves. Everything it touches fails together or passes together.

**Files:**
- Create: `frontend/src/games/something2/GameShell.jsx`
- Create: `frontend/src/games/something2/GameView.jsx`
- Create: `frontend/src/pages/LoginRoute.jsx`
- Modify: `frontend/src/App.jsx` (whole file rewritten)
- Delete: `frontend/src/games/something2/Something2.jsx`
- Delete: `frontend/src/pages/GameSomething2.jsx`
- Modify: `frontend/src/games/something2/__tests__/worldsPickerAdminGating.test.js`
- Modify: `frontend/src/games/something2/__tests__/themeTokens.test.js:104-107`

**Interfaces:**
- Consumes: `AuthProvider`/`useAuth` (Task 1), `RequireAuth`/`RequireAdmin` (Task 2).
- Produces: the outlet context `GameView` reads —
  `{ gameRef, isPlaying, isPaused, isFullscreen, selectedWorldId, setSelectedWorldId, enterWorld(worldId?), resume(), exitToMenu(), toggleFullscreen(), openHelp() }`

**Why the layout route:** `RenderSystem` captures the `<canvas>` element and its 2D context when the world is entered. Unmounting it leaves the rAF loop drawing into a detached node while React mounts a blank one — the game view comes back empty. React Router does not remount a parent route element when navigating between its children, so putting the canvas in `GameShell` preserves today's hidden-but-alive behaviour exactly.

- [ ] **Step 1: Update the two source-text tests to point at the new files**

These tests read `Something2.jsx` as text. They will fail the moment it is deleted, so fix them first and watch them go red for the right reason.

In `frontend/src/games/something2/__tests__/worldsPickerAdminGating.test.js`, replace lines 11-19 (the comment tail and the `readFileSync`) with:

```js
// Something2.jsx has since been split; the Worlds picker now lives in
// GameView.jsx. The guarded JSX moved verbatim, so both assertions still apply.
//
// GameView.jsx isn't rendered in tests (vitest here runs in a plain node
// environment, no jsdom/RTL), so this is a source-structure regression test:
// it asserts the destructive controls are lexically wrapped in the same
// `isAdmin &&` guard already used for the admin-only nav entries, rather than a
// rendered-DOM assertion.
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '../GameView.jsx'), 'utf8');
```

In `frontend/src/games/something2/__tests__/themeTokens.test.js`, replace the `IN_SCOPE` array at lines 104-107 with:

```js
const IN_SCOPE = [
  'GameShell.jsx', 'GameView.jsx', 'TileTypesAdmin.jsx', 'EntityTypesAdmin.jsx',
  'ItemTypesAdmin.jsx', 'BiomesAdmin.jsx', 'MapsAdmin.jsx', 'MapGraphAdmin.jsx',
];
```

- [ ] **Step 2: Run those two tests to verify they fail for the right reason**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/worldsPickerAdminGating.test.js src/games/something2/__tests__/themeTokens.test.js`
Expected: FAIL with `ENOENT ... GameView.jsx` and `ENOENT ... GameShell.jsx` — not with an assertion failure.

- [ ] **Step 3: Create `GameShell.jsx`**

Create `frontend/src/games/something2/GameShell.jsx`. Everything below is either moved verbatim from `Something2.jsx` (line ranges given) or written out in full where it changes.

```jsx
import { useEffect, useRef, useState } from 'react';
import { Outlet, useMatch } from 'react-router-dom';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { Game } from "./src/js/main.js";
import { useMapTiles, useMapConfig, useVfxEffects } from "./useMaps.js";
import { useWorlds } from "./useWorlds";
import { autoJoinTarget } from "./autoJoin.js";
import { bindGameCanvas } from "./gameCanvasBinding.js";
import { MAP_TILE_SIZE } from "./src/js/core/constants.js";
import { useAuth } from "../../context/AuthContext";
```

No `react-icons` import here: the shell's only icon-free affordance is the `?` `HelpButton`, which renders a literal `?` character. Every icon in the old file belongs to `HowToButton`, `FullscreenToggle` or the worlds list, all of which move to `GameView`.

**Styled components — move verbatim from `Something2.jsx`:**

| Component | Source lines | Change |
|---|---|---|
| `StyledGameContainer` | 24-36 | `height: 100vh` → `height: 100%` (defect D3), keep the comment |
| `HelpButton` | 38-59 | verbatim |
| `HelpBackdrop` | 61-70 | verbatim |
| `HelpCard` | 72-103 | verbatim |
| `HelpCloseButton` | 105-114 | verbatim |
| `HELP_SECTIONS` | 116-155 | see Step 4 — one row's text changes |
| `ContentArea` | 191-195 | verbatim |

`TabBar` (157-163), `ADMIN_TAB_COLORS` (165), and `TabButton` (167-189) are **deleted** — their colour coding lives in `navSections.js` now.

**Component body:**

```jsx
export default function GameShell() {
  const canvasRef = useRef(null);
  const gameRef = useRef(null);
  const contentRef = useRef(null); // fullscreen target (wraps the game canvas)
  // Always holds the LATEST enterWorld. The doorway-transition callback is
  // registered once (in the [isGameRoute] effect) and would otherwise capture a
  // stale closure -- one built before the async map-tiles/worlds/vfx queries
  // resolved -- making a mid-session transition re-init the world with empty
  // tile defs (terrain then renders as the invisible fallback colour).
  const handleEnterRef = useRef(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [selectedWorldId, setSelectedWorldId] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { isAdmin } = useAuth();

  // Replaces the old `activeTab === 'game'`. useMatch is an exact match, so this
  // is false on /game/biomes and friends -- which is what hides the canvas
  // without unmounting it.
  const isGameRoute = !!useMatch('/game');

  const { mapTiles } = useMapTiles();
  const { vfxEffects } = useVfxEffects();
  const { mapConfig } = useMapConfig();
  // worldsError is toasted inside useWorlds() itself (F-023), so every caller
  // gets the signal without opting in. GameView calls useWorlds() too; TanStack
  // dedupes them by query key, so this is one request, not two.
  const { worlds } = useWorlds();
```

Then move, **verbatim** from `Something2.jsx`:

| Block | Source lines | Change |
|---|---|---|
| `handleResume` | 456-458 | rename to `resume` |
| `enterGameFullscreen` / `exitGameFullscreen` / `toggleFullscreen` | 460-478 | verbatim |
| `fullscreenchange` effect | 480-486 | verbatim |
| enter-fullscreen-on-play effect | 488-494 | verbatim |
| `handleExit` | 496-508 | rename to `exitToMenu`; **delete** the `engineRef` block at 503-507 (defect D7 — `engineRef` is never assigned, so that branch is unreachable) |
| canvas-bind effect | 510-553 | see below |
| destroy-on-unmount effect | 555-564 | verbatim |
| `handleEnterChunkedWorld` | 566-591 | rename to `enterWorld`; body unchanged |
| auto-join effect | 593-613 | dep array `activeTab` → `isGameRoute` |

The canvas-bind effect changes in three ways — keep its full comment block (510-520) and append a note:

```jsx
  // ... existing F-045 comment block from Something2.jsx:510-520 ...
  //
  // The old `authed` dependency is gone: sign-out now unmounts this whole
  // component via RequireAuth, so a sign-in always produces a fresh mount
  // rather than an in-place canvas swap. bindGameCanvas stays because
  // re-running it against the same node is idempotent and it is the tested path.
  useEffect(() => {
    if (isGameRoute && canvasRef.current) {
      gameRef.current = bindGameCanvas(gameRef.current, canvasRef.current, () => new Game());

      gameRef.current.setOnStateChange((newState) => {
        setIsPaused(newState === 'paused');
        if (newState === 'menu') {
          setIsPlaying(false);
          setIsPaused(false);
        }
      });

      // Server-driven map transition (e.g. walking through a portal tile):
      // the authority sends {type:'transition', toWorldId, arriveX, arriveY}
      // and Game surfaces it here. Re-running enterWorld tears down the old
      // authority connection and reconnects to the destination world; the
      // server spawns the rejoining player at the pending arrival. Call through
      // handleEnterRef (updated every render) rather than closing over
      // enterWorld directly -- see the handleEnterRef declaration above.
      gameRef.current.setOnTransition((msg) => {
        if (msg?.toWorldId) handleEnterRef.current?.(msg.toWorldId);
      });
    }
    // NOTE: no engine teardown on cleanup. The old cleanup disconnected
    // `engineRef`, which was never assigned -- dead code. Real teardown is the
    // mount-once destroy effect below.
  }, [isGameRoute]);
```

**Render:**

```jsx
  return (
    <StyledGameContainer>
      <HelpButton
        title="Help — controls & operations"
        aria-label="Help"
        onClick={() => setHelpOpen(true)}
      >
        ?
      </HelpButton>

      <ContentArea ref={contentRef}>
        {/* Rendered INSIDE contentRef (the fullscreen element) so the panel is
            part of the fullscreen top layer. Rendered at the top level it was
            painted behind the fullscreen game canvas — invisible while playing. */}
        {helpOpen && (
          /* ... HelpBackdrop / HelpCard block moved verbatim from Something2.jsx:695-722 ... */
        )}

        <Outlet context={{
          gameRef, isPlaying, isPaused, isFullscreen,
          selectedWorldId, setSelectedWorldId,
          enterWorld, resume, exitToMenu, toggleFullscreen,
          openHelp: () => setHelpOpen(true),
        }} />

        {/* Kept mounted across route changes, NOT nested in the game route's
            element. RenderSystem captures this element and its 2d context when
            the world is entered, so unmounting it on a navigation left the
            running render loop drawing into a detached canvas while React
            mounted a fresh (blank) one — the game view came back empty.
            Hiding it is enough; the rAF loop and authority socket keep running,
            so returning to /game resumes the live world instead of reloading. */}
        <canvas
          ref={canvasRef}
          style={{
            width: '100%',
            height: '100%',
            display: isGameRoute && isPlaying ? 'block' : 'none',
            background: '#0f0f1a', // s2-theme-exempt(#0f0f1a): game canvas surface stays dark in both modes
          }}
        />
      </ContentArea>
    </StyledGameContainer>
  );
}
```

`isAdmin` is consumed by the auto-join effect (admins keep the world picker); it is not passed through the outlet context — `GameView` reads `useAuth()` itself.

- [ ] **Step 4: Update the help text that described the tab bar**

In `HELP_SECTIONS`, two rows describe UI that no longer exists. Change them:

```jsx
  {
    title: 'Session',
    rows: [
      { k: [['Esc']], d: 'Pause / resume' },
      { k: [['Sign out']], d: 'Bottom of the left sidebar — clears your session and returns to the login screen' },
    ],
  },
  {
    title: 'Worlds & admin (left sidebar)',
    rows: [
      { k: [['Game View']], d: 'Select a world in the right-hand list, then "Enter World (chunked)" to play it' },
      { k: [['Admin']], d: 'Tile Types / Entities / Items / Maps / Biomes / World Map editors — visible to admin accounts only' },
    ],
  },
```

- [ ] **Step 5: Create `GameView.jsx`**

Create `frontend/src/games/something2/GameView.jsx`:

```jsx
import { useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import styled from 'styled-components';
import {
  HiOutlineTrash, HiArrowsPointingOut, HiArrowsPointingIn, HiOutlineQuestionMarkCircle,
} from "react-icons/hi2";
import { useMapTiles } from "./useMaps.js";
import { useWorlds, useCreateWorld, useDeleteWorld } from "./useWorlds";
import { useAuth } from "../../context/AuthContext";
import WorldPreview from "./WorldPreview.jsx";
import Minimap from "./Minimap.jsx";
```

**Styled components — move verbatim from `Something2.jsx`:** `UIOverlay` (197-206), `FullscreenToggle` (208-228), `HowToButton` (230-255), `Panel` (257-266), `MapList` (268-283), `MapItem` (285-299), `Button` (301-320), `PauseOverlay` (322-335), `PausePanel` (337-346), `Input` (348-366).

**Component body:**

```jsx
export default function GameView() {
  const {
    gameRef, isPlaying, isPaused, isFullscreen,
    selectedWorldId, setSelectedWorldId,
    enterWorld, resume, exitToMenu, toggleFullscreen, openHelp,
  } = useOutletContext();

  const { isAdmin } = useAuth();
  const [newWorldName, setNewWorldName] = useState('');
  const [newWorldSeed, setNewWorldSeed] = useState('');
  const [newWorldChunkSize, setNewWorldChunkSize] = useState('64');

  // Same query keys GameShell uses; TanStack serves both from one cache entry.
  const { mapTiles } = useMapTiles();
  const { worlds, isLoadingWorlds } = useWorlds();
  const createWorldMutation = useCreateWorld();
  const deleteWorldMutation = useDeleteWorld();

  // name -> color for the minimap and world preview (mapTiles is keyed by tile name).
  const tileColors = useMemo(() => {
    const m = {};
    if (mapTiles && typeof mapTiles === 'object') {
      for (const [name, def] of Object.entries(mapTiles)) {
        m[name] = (def && typeof def === 'object') ? def.color : def;
      }
    }
    return m;
  }, [mapTiles]);

  const handleCreateWorld = () => {
    if (!newWorldName.trim()) return;
    const cs = Number(newWorldChunkSize);
    const chunk_size = Number.isInteger(cs) && cs >= 1 && cs <= 256 ? cs : 64;
    createWorldMutation.mutate({
      name: newWorldName.trim(),
      seed: newWorldSeed ? Number(newWorldSeed) : undefined,
      chunk_size,
    }, {
      onSuccess: (world) => {
        setNewWorldName('');
        setNewWorldSeed('');
        if (world?.id) setSelectedWorldId(world.id);
      }
    });
  };

  return (
    <>
      {/* ... everything from Something2.jsx:725-862 moved verbatim, with these substitutions ... */}
    </>
  );
}
```

Substitutions when moving `Something2.jsx:725-862`:

- `handleEnterChunkedWorld()` → `enterWorld()`
- `handleResume` → `resume`
- `handleExit` → `exitToMenu`
- `setHelpOpen(true)` → `openHelp()`
- everything else, including both `s2-theme-exempt` sentinel comments on the `#0f0f1a` placeholder block (846-862), moves unchanged.

The `{isAdmin && (<HiOutlineTrash …` guard and the `{isAdmin && (<div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '15px' }}>` guard must survive **byte-for-byte** — `worldsPickerAdminGating.test.js` matches them by regex.

- [ ] **Step 6: Create `LoginRoute.jsx`**

Create `frontend/src/pages/LoginRoute.jsx`:

```jsx
import { Navigate } from "react-router-dom";
import Login from "./Login";
import { API_URL } from "../config";
import { useAuth } from "../context/AuthContext";

// The login screen as a route, rendered OUTSIDE AppLayout so no sidebar or
// header frames it. Login.jsx stores the token itself and then calls
// onAuthed(), so signIn() just re-reads it from storage.
function LoginRoute() {
  const { authed, signIn } = useAuth();
  if (authed) return <Navigate to="/game" replace />;
  return <Login apiUrl={API_URL} onAuthed={() => signIn()} />;
}

export default LoginRoute;
```

- [ ] **Step 7: Rewrite `App.jsx`**

Replace `frontend/src/App.jsx` entirely:

```jsx
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Toaster } from "react-hot-toast";
import GlobalStyles from "./styles/GlobalStyles";
import LoginRoute from "./pages/LoginRoute";
import PageNotFound from "./pages/PageNotFound";
import AppLayout from "./ui/AppLayout";
import RequireAuth from "./ui/RequireAuth";
import RequireAdmin from "./ui/RequireAdmin";
import GameShell from "./games/something2/GameShell";
import GameView from "./games/something2/GameView";
import TileTypesAdmin from "./games/something2/TileTypesAdmin";
import EntityTypesAdmin from "./games/something2/EntityTypesAdmin";
import ItemTypesAdmin from "./games/something2/ItemTypesAdmin";
import MapsAdmin from "./games/something2/MapsAdmin";
import BiomesAdmin from "./games/something2/BiomesAdmin";
import MapGraphAdmin from "./games/something2/MapGraphAdmin";

import { DarkModeProvider } from "./context/DarkModeContext";
import { AuthProvider } from "./context/AuthContext";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
    },
  },
});

function App() {
  return (
    <DarkModeProvider>
      <QueryClientProvider client={queryClient}>
        <ReactQueryDevtools />
        <GlobalStyles />
        <BrowserRouter>
          <AuthProvider>
            <Routes>
              <Route path="login" element={<LoginRoute />} />

              <Route element={<RequireAuth />}>
                <Route element={<AppLayout />}>
                  <Route index element={<Navigate replace to="game" />} />

                  {/* Layout route: owns the canvas and the Game instance, so
                      navigating between its children never tears down the
                      running world. See GameShell's canvas comment. */}
                  <Route path="game" element={<GameShell />}>
                    <Route index element={<GameView />} />
                    <Route element={<RequireAdmin />}>
                      <Route path="tiles" element={<TileTypesAdmin />} />
                      <Route path="entities" element={<EntityTypesAdmin />} />
                      <Route path="items" element={<ItemTypesAdmin />} />
                      <Route path="maps" element={<MapsAdmin />} />
                      <Route path="biomes" element={<BiomesAdmin />} />
                      <Route path="world-map" element={<MapGraphAdmin />} />
                    </Route>
                  </Route>
                </Route>
              </Route>

              <Route path="*" element={<PageNotFound />} />
            </Routes>
          </AuthProvider>
        </BrowserRouter>
        <Toaster position="top-center" gutter={2} containerStyle={{ margin: '8px' }}
          toastOptions={{
            success: { duration: 3000 },
            error: { duration: 5000 },
            style: {
              fontSize: '16px',
              maxWidth: '500px',
              padding: '16px 24px',
              backgroundColor: 'var(--color-grey-0)',
              color: 'var(--color-grey-700)',
            }
          }}
        />
      </QueryClientProvider>
    </DarkModeProvider>
  )
}

export default App
```

`AuthProvider` is inside `BrowserRouter` because its consumers render `<Navigate>`. The `Dashboard` import is gone (its route was already removed); `Dashboard.jsx` stays on disk, unrouted.

- [ ] **Step 8: Delete the two replaced files**

```bash
git rm frontend/src/games/something2/Something2.jsx frontend/src/pages/GameSomething2.jsx
```

`GameSomething2.jsx` was a two-line passthrough that imported `Something2` twice (once under an unused `LoginForm` alias) and is the only file that imported it. Confirm nothing else does:

Run: `grep -rn "from.*Something2" frontend/src --include=*.jsx --include=*.js`
Expected: no output.

- [ ] **Step 9: Run the two source-text tests**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/worldsPickerAdminGating.test.js src/games/something2/__tests__/themeTokens.test.js`
Expected: PASS. A failure in `themeTokens` names an unexempted colour literal — you dropped a `s2-theme-exempt` comment while moving code.

- [ ] **Step 10: Run the full suite and the build**

Run: `cd frontend && npm test && npm run build`
Expected: `Test Files  72 passed (72)` / `Tests  541 passed (541)`, then a successful vite build with no unresolved imports.

- [ ] **Step 11: Commit**

```bash
git add -A frontend/src
git commit -m "refactor(routing): make the admin tabs real routes under a GameShell layout

Splits Something2.jsx into GameShell (canvas + Game instance, survives
navigation) and GameView (the game view's own UI). Deletes the TabBar and the
never-assigned engineRef. Repoints the two source-text tests at the new files."
```

---

### Task 5: Sidebar — nav, logo, sign out

**Files:**
- Modify: `frontend/src/ui/MainNav.jsx` (whole file rewritten)
- Modify: `frontend/src/ui/Sidebar.jsx`
- Modify: `frontend/src/ui/Logo.jsx` (whole file rewritten)

**Interfaces:**
- Consumes: `visibleSections()` (Task 3), `useAuth()` (Task 1).

Fixes D1 (broken logo image), D4 (dead "Home" link), D6 (wrapping labels).

- [ ] **Step 1: Rewrite `MainNav.jsx`**

```jsx
import styled from "styled-components";
import { NavLink } from "react-router-dom";
import { visibleSections } from "./navSections";
import { useAuth } from "../context/AuthContext";

const Nav = styled.nav`
  display: flex;
  flex-direction: column;
  gap: 2.4rem;
`;

const SectionTitle = styled.h3`
  padding: 0 2.4rem;
  margin: 0 0 0.8rem;
  font-size: 1.1rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-grey-400);
`;

const NavList = styled.ul`
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
`;

// $accent is the old TabBar colour coding, carried over so the admin grouping
// (entity=yellow, items=pink, maps=green) survives the move to a sidebar. It
// shows as the active row's left stripe and icon colour.
const StyledNavLink = styled(NavLink)`
  &:link,
  &:visited {
    display: flex;
    align-items: center;
    gap: 1.2rem;
    /* The labels wrapped to two lines in a 26rem column before this. */
    white-space: nowrap;

    color: var(--color-grey-600);
    font-size: 1.5rem;
    font-weight: 500;
    padding: 1rem 2.4rem;
    border-left: 3px solid transparent;
    transition: all 0.3s;
  }

  &:hover,
  &:active,
  &.active:link,
  &.active:visited {
    color: var(--color-grey-800);
    background-color: var(--color-grey-50);
  }

  &.active:link,
  &.active:visited {
    border-left-color: ${(props) => props.$accent};
  }

  & svg {
    width: 2.2rem;
    height: 2.2rem;
    flex-shrink: 0;
    color: var(--color-grey-400);
    transition: all 0.3s;
  }

  &:hover svg,
  &:active svg,
  &.active:link svg,
  &.active:visited svg {
    color: ${(props) => props.$accent};
  }
`;

const ADMIN_ACCENTS = {
  entity: 'var(--s2-tab-entity)',
  items: 'var(--s2-tab-items)',
  maps: 'var(--s2-tab-maps)',
};

function MainNav() {
  const { isAdmin } = useAuth();

  return (
    <Nav>
      {visibleSections(isAdmin).map((section) => (
        <div key={section.title ?? 'default'}>
          {section.title && <SectionTitle>{section.title}</SectionTitle>}
          <NavList>
            {section.items.map(({ id, label, path, Icon, adminType }) => (
              <li key={id}>
                {/* `end` on /game so it isn't marked active on /game/biomes. */}
                <StyledNavLink
                  to={path}
                  end={path === '/game'}
                  $accent={ADMIN_ACCENTS[adminType] || 'var(--color-brand-600)'}
                >
                  <Icon />
                  <span>{label}</span>
                </StyledNavLink>
              </li>
            ))}
          </NavList>
        </div>
      ))}
    </Nav>
  );
}

export default MainNav;
```

- [ ] **Step 2: Rewrite `Logo.jsx`**

The old component requested `/logo-light.png` and `/logo-dark.png`; `frontend/public/` holds only `favicon.svg` and `icons.svg`, so it rendered a broken-image box (D1). A text wordmark has no asset dependency and is correct in both themes.

```jsx
import styled from "styled-components";

const StyledLogo = styled.div`
  text-align: center;
  padding: 0.8rem 0;
`;

const Wordmark = styled.span`
  font-size: 2.4rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--color-brand-600);
`;

function Logo() {
  return (
    <StyledLogo>
      <Wordmark>Something2</Wordmark>
    </StyledLogo>
  );
}

export default Logo;
```

- [ ] **Step 3: Add the pinned sign-out to `Sidebar.jsx`**

```jsx
import styled from "styled-components";
import { HiOutlineArrowRightOnRectangle } from "react-icons/hi2";
import Logo from "./Logo";
import MainNav from "./MainNav";
import { useAuth } from "../context/AuthContext";

const StyledSidebar = styled.aside`
    background-color: var(--color-grey-0);
    padding: 3.2rem 0;
    border-right: 1px solid var(--color-grey-100);
    grid-row:  1 / -1;
    display:flex;
    flex-direction:column;
    gap: 3.2rem;
    overflow-y: auto;
`;

// margin-top:auto pins this to the bottom however few nav entries render above.
const SignOutButton = styled.button`
    margin-top: auto;
    display: flex;
    align-items: center;
    gap: 1.2rem;
    width: 100%;
    padding: 1rem 2.4rem;
    background: none;
    border: none;
    border-top: 1px solid var(--color-grey-100);
    color: var(--color-grey-600);
    font-size: 1.5rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.3s;

    &:hover {
      color: var(--color-grey-800);
      background-color: var(--color-grey-50);
    }

    & svg {
      width: 2.2rem;
      height: 2.2rem;
      color: var(--color-grey-400);
    }
`;

function Sidebar() {
    const { signOut } = useAuth();
    return (
        <StyledSidebar>
            <Logo/>
            <MainNav/>
            <SignOutButton onClick={signOut}>
                <HiOutlineArrowRightOnRectangle/>
                <span>Sign out</span>
            </SignOutButton>
        </StyledSidebar>
    )
}

export default Sidebar;
```

The aside's horizontal padding moved onto the individual rows so hover and active backgrounds span the full sidebar width.

- [ ] **Step 4: Verify**

Run: `cd frontend && npm test && npm run build`
Expected: 72 files / 541 tests passing, clean build.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ui/MainNav.jsx frontend/src/ui/Sidebar.jsx frontend/src/ui/Logo.jsx
git commit -m "feat(nav): move the game and admin tabs into the left sidebar"
```

---

### Task 6: Header user chip

**Files:**
- Modify: `frontend/src/ui/HeaderMenu.jsx` (whole file rewritten)

Fixes D5: the user icon navigated to `/account`, which has no route, so it rendered `PageNotFound`.

- [ ] **Step 1: Rewrite `HeaderMenu.jsx`**

```jsx
import { useEffect, useRef, useState } from "react";
import styled from "styled-components";
import { HiOutlineUser } from "react-icons/hi";
import DarkModeToggle from "./DarkModeToggle";
import { useAuth } from "../context/AuthContext";

const StyledHeaderMenu = styled.ul`
    display: flex;
    align-items: center;
    gap: 0.4rem;
`;

const UserWrapper = styled.li`
    position: relative;
`;

const Chip = styled.button`
    display: flex;
    align-items: center;
    gap: 0.8rem;
    padding: 0.6rem 1.2rem;
    background: none;
    border: none;
    border-radius: var(--border-radius-sm);
    color: var(--color-grey-600);
    font-size: 1.4rem;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s;

    &:hover { background-color: var(--color-grey-100); }

    & svg {
      width: 2.2rem;
      height: 2.2rem;
      color: var(--color-brand-600);
    }
`;

const Menu = styled.ul`
    position: absolute;
    top: calc(100% + 0.4rem);
    right: 0;
    z-index: 50;
    min-width: 16rem;
    padding: 0.4rem;
    background-color: var(--color-grey-0);
    border: 1px solid var(--color-grey-100);
    border-radius: var(--border-radius-sm);
    box-shadow: var(--shadow-md);
`;

const MenuItem = styled.button`
    width: 100%;
    padding: 0.8rem 1.2rem;
    text-align: left;
    background: none;
    border: none;
    border-radius: var(--border-radius-sm);
    color: var(--color-grey-600);
    font-size: 1.4rem;
    font-family: inherit;
    cursor: pointer;

    &:hover { background-color: var(--color-grey-50); }
`;

function HeaderMenu() {
    const { username, signOut } = useAuth();
    const [open, setOpen] = useState(false);
    const wrapperRef = useRef(null);

    // Click-away close. Without it the menu stays open behind whatever the user
    // clicks next, including the game canvas.
    useEffect(() => {
        if (!open) return;
        const onDocClick = (e) => {
            if (!wrapperRef.current?.contains(e.target)) setOpen(false);
        };
        document.addEventListener('click', onDocClick);
        return () => document.removeEventListener('click', onDocClick);
    }, [open]);

    return (
        <StyledHeaderMenu>
            <UserWrapper ref={wrapperRef}>
                <Chip
                    onClick={() => setOpen((v) => !v)}
                    aria-haspopup="menu"
                    aria-expanded={open}
                >
                    <HiOutlineUser />
                    <span>{username ?? 'Account'}</span>
                </Chip>
                {open && (
                    <Menu role="menu">
                        <li>
                            <MenuItem role="menuitem" onClick={signOut}>Sign out</MenuItem>
                        </li>
                    </Menu>
                )}
            </UserWrapper>
            <li>
                <DarkModeToggle />
            </li>
        </StyledHeaderMenu>
    );
}
export default HeaderMenu;
```

`ButtonIcon` is no longer imported here; it is still used by `DarkModeToggle`, so leave the file alone.

`--shadow-md` is already defined in both the light and dark blocks of `GlobalStyles.js` (lines 39 and 142) — no new token is needed.

- [ ] **Step 2: Verify**

Run: `cd frontend && npm test && npm run build`
Expected: 72 files / 541 tests passing, clean build.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/ui/HeaderMenu.jsx
git commit -m "fix(header): replace the dead /account link with a user menu"
```

---

### Task 7: Content area — kill the nested scrollbars

**Files:**
- Modify: `frontend/src/ui/AppLayout.jsx`

Fixes D3. `Main` was `overflow: scroll` (always-visible bar) inside a `100vh` grid whose child forced another `100vh`, with `4rem 4.8rem 6.4rem` of padding and a `130rem` cap around a canvas that wants the whole cell.

The padded, centred look for admin routes is **not** lost: all six admin panels already set their own `padding: 2rem; max-width: 1200-1400px; margin: 0 auto`. Keeping `Main`'s padding as well would stack `6rem` of padding and two competing max-widths.

- [ ] **Step 1: Rewrite `AppLayout.jsx`**

```jsx
import { Outlet } from "react-router-dom";
import Header from "./Header";
import Sidebar from "./Sidebar";
import styled from "styled-components";

const StyledAppLayout = styled.div`
    display: grid;
    height:100vh;
    grid-template-columns: 26rem 1fr;
    grid-template-rows: auto 1fr;
`;

// Flush scroll container. No padding and no max-width wrapper: the game canvas
// fills this cell edge to edge, and every admin panel already applies its own
// padding + max-width + margin:0 auto. min-height:0 lets the grid cell actually
// shrink -- without it the row refuses to be smaller than its content and the
// page grows a second scrollbar. overflow:auto (not scroll) hides the bar when
// nothing overflows.
const Main = styled.main`
    background-color: var(--color-grey-50);
    min-height: 0;
    overflow: auto;
`;

function AppLayout() {
    return (
        <StyledAppLayout>
            <Header/>
            <Sidebar/>
            <Main>
                <Outlet/>
            </Main>
        </StyledAppLayout>
    )
}

export default AppLayout
```

- [ ] **Step 2: Verify**

Run: `cd frontend && npm test && npm run build`
Expected: 72 files / 541 tests passing, clean build.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/ui/AppLayout.jsx
git commit -m "fix(layout): make Main a flush scroll container"
```

---

### Task 8: Nav/route consistency test, lint, and browser verification

**Files:**
- Create: `frontend/src/ui/__tests__/navRoutes.test.js`

The nav and the route table are two lists that must agree. Nothing catches a typo in either today.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/ui/__tests__/navRoutes.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV_SECTIONS } from '../navSections.js';

// The sidebar and the route table in App.jsx are two lists that have to agree:
// a nav entry pointing at an unregistered path renders a blank content area,
// and a route with no nav entry is unreachable except by typing the URL.
// vitest runs in a plain node env here (no jsdom/RTL), so this compares the
// nav definitions against App.jsx's source text rather than a rendered router.
const here = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(here, '../../App.jsx'), 'utf8');

const items = NAV_SECTIONS.flatMap((s) => s.items);

describe('nav paths and App.jsx routes agree', () => {
  it('registers a child route for every admin nav path', () => {
    for (const item of items) {
      if (item.path === '/game') continue;          // the index route, no path= segment
      const segment = item.path.replace('/game/', '');
      expect(app, `${item.path} has no route`).toContain(`path="${segment}"`);
    }
  });

  it('mounts the game shell at /game with an index route', () => {
    expect(app).toMatch(/path="game"\s+element=\{<GameShell \/>\}/);
    expect(app).toMatch(/<Route index element=\{<GameView \/>\} \/>/);
  });

  it('keeps every admin route behind RequireAdmin', () => {
    const guarded = app.slice(app.indexOf('<RequireAdmin />'));
    for (const item of items) {
      if (item.path === '/game') continue;
      expect(guarded, `${item.path} is outside RequireAdmin`)
        .toContain(`path="${item.path.replace('/game/', '')}"`);
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd frontend && npx vitest run src/ui/__tests__/navRoutes.test.js`
Expected: PASS (3 tests). Tasks 3 and 4 already put the app in the correct state, so this test documents and locks it rather than driving new code. If it fails, a path in `navSections.js` disagrees with `App.jsx` — fix the mismatch, do not loosen the test.

- [ ] **Step 3: Run the full suite, lint and build**

```bash
cd frontend && npm test && npm run lint && npm run build
```

Expected: `Test Files  73 passed (73)` / `Tests  544 passed (544)`, lint clean, build clean.

Lint will flag unused imports left behind by the split (`HiOutlineQuestionMarkCircle` in `GameShell`, `clearToken`/`parseJwt`/`getStoredToken` if any survived the auth lift, `Heading`/`Logo` in the deleted page). Remove them; do not add eslint-disable comments.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/ui/__tests__/navRoutes.test.js
git commit -m "test(nav): lock the sidebar paths to the route table"
```

- [ ] **Step 5: Browser verification**

Bring up the dev stack (hot-reloading vite on :15173, nodemon backend on :13101) and drive it with Chrome DevTools MCP. **A green suite does not prove this works** — none of these tests render a component.

Verify in order, as an **admin**:

1. Signed out, hit `/game/biomes` directly → lands on `/login`, full-screen, with no sidebar or header around the form.
2. Sign in → lands on `/game`. Sidebar shows the "Something2" wordmark (no broken-image box), Game View, an "Admin" heading and six admin entries. Header chip shows the admin username.
3. Click all seven nav entries. For each: the URL changes, the correct panel renders, the active row shows its accent stripe, **exactly one vertical scrollbar exists**, and no label wraps or overlaps.
4. Reload the page on `/game/biomes` → lands on Biomes, not the game view.
5. **Session survival (the point of the whole design):** from `/game`, select a world and Enter World. Note the player position. Navigate to `/game/biomes`, then back to `/game`. The world must still be live — no reconnect, no blank canvas, position preserved, and the browser console shows no new WebSocket open.
6. Open the header chip → menu appears; click elsewhere → it closes; click Sign out → login screen. Repeat with the sidebar Sign out button.
7. Toggle dark mode on `/game` and on `/game/entities`; both must be readable.

Then as a **non-admin** (register a fresh account):

8. Sidebar shows only Game View, no "Admin" heading.
9. Type `/game/biomes` → redirected to `/game`, not a blank content area.
10. The Worlds panel shows no delete icons and no create-world form.

- [ ] **Step 6: Fix anything the browser pass found, then push**

```bash
git push -u origin feat/sidebar-nav-routing
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Route tree, `/game` rename | 4 |
| `RequireAdmin` as a route | 2, 4 |
| `RequireAuth` wraps the layout | 2, 4 |
| `AuthContext` + both liveness effects | 1 |
| `engineRef` deleted (D7) | 4 |
| `GameShell` / `GameView` split | 4 |
| `useMatch('/game')` replaces `activeTab` | 4 |
| `NAV_SECTIONS`, admin accent stripes | 3, 5 |
| Sign out pinned to sidebar bottom | 5 |
| Logo wordmark (D1) | 5 |
| Labels nowrap (D6) | 5 |
| "Home" removed, `Dashboard` import dropped (D4) | 4, 5 |
| Header user chip (D5) | 6 |
| Flush `Main`, `overflow: auto`, `height: 100%` (D3) | 4 (shell root), 7 |
| TabBar deleted (D2) | 4 |
| `worldsPickerAdminGating` repointed | 4 |
| `themeTokens` `IN_SCOPE` updated | 4 |
| New unit tests | 1, 2, 3, 8 |
| Browser verification | 8 |

No spec requirement is unassigned.

**Naming consistency across tasks:** `deriveAuth`, `guardRedirect`, `NAV_SECTIONS`, `visibleSections`, `useAuth`, `signIn`, `signOut`, `enterWorld`, `resume`, `exitToMenu`, `toggleFullscreen`, `openHelp`, `isGameRoute` are each defined once and referenced with the same spelling everywhere. The three `Something2.jsx` handler renames (`handleEnterChunkedWorld`→`enterWorld`, `handleResume`→`resume`, `handleExit`→`exitToMenu`) are applied in both the shell's definitions and the view's substitution list.
