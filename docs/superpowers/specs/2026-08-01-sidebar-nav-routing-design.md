# Sidebar navigation & URL-driven tabs

Date: 2026-08-01
Status: approved, ready for planning

## Problem

`Something2.jsx` renders a horizontal `TabBar` with seven tab buttons driven by a
local `activeTab` state. Three things are wrong with it:

1. **The tabs are not addressable.** There is no URL for the Biomes editor. You
   cannot link to it, bookmark it, or reload into it — a reload always lands on
   the game view.
2. **The tab bar does not fit.** It is a `display: flex` row with no wrap or
   shrink control, nested inside `AppLayout`'s `4rem`-padded, `130rem`-capped
   container. The seven buttons compress until their labels overlap their icons.
3. **The left sidebar is broken and nearly empty.** It shows a broken-image box
   and two links, one of which is dead.

Meanwhile the app has a real left sidebar (`AppLayout` → `Sidebar` → `MainNav`)
carrying almost nothing. The tabs belong there.

### Specific defects to fix

| # | Defect | Cause |
|---|---|---|
| D1 | Broken image in the sidebar | `Logo.jsx` requests `/logo-light.png` and `/logo-dark.png`; `frontend/public/` holds only `favicon.svg` and `icons.svg` |
| D2 | Tab labels overlap their icons | `TabBar` flex row, no `flex-wrap`/`flex-shrink: 0`, inside a constrained container |
| D3 | Two vertical scrollbars | `StyledGameContainer` is `height: 100vh` inside `Main`, itself a `1fr` cell of a `100vh` grid that already spends a row on the header, plus `4rem 4.8rem 6.4rem` padding. `Main` is also `overflow: scroll` (always-visible bar) rather than `auto` |
| D4 | "Home" is a dead link | `MainNav` links to `/`, which `App.jsx` redirects straight back to the game route |
| D5 | Header user icon 404s | `HeaderMenu` navigates to `/account`; no such route exists, so it renders `PageNotFound` |
| D6 | Sidebar labels wrap to two lines | "Game Something2" in a `26rem` column with `2.4rem` horizontal padding and a `1.2rem` icon gap |
| D7 | Dead `engineRef` code | `engineRef` is read and nulled in four places in `Something2.jsx` but never assigned, so every `engineRef.current.disconnect()` is unreachable |

## Constraint that shapes the whole design

The `<canvas>` is deliberately kept mounted across tab switches (see the comment
at `Something2.jsx:871-877`). `RenderSystem` captures the element and its 2D
context when the world is entered; unmounting it leaves the running rAF loop
drawing into a detached node while React mounts a blank one. The authority
WebSocket and the rAF loop keep running behind a hidden canvas, so returning to
the game view resumes the live world instead of reloading it.

**Turning tabs into URLs must preserve this.** A flat set of sibling routes
would unmount the game on every admin visit. Therefore `GameShell` is a *layout
route* and the admin screens are its *children*: React Router does not remount a
parent route element when navigating between its children.

## Architecture

### Route tree

```
/login                    LoginRoute            full-screen, no app chrome
/                         RequireAuth
  └─ AppLayout                                  sidebar + header + main
       index              → Navigate replace to /game
       /game              GameShell             owns the canvas + Game instance
         index            GameView              worlds picker, minimap, pause, fullscreen
         └─ RequireAdmin
              /game/tiles       TileTypesAdmin
              /game/entities    EntityTypesAdmin
              /game/items       ItemTypesAdmin
              /game/maps        MapsAdmin
              /game/biomes      BiomesAdmin
              /game/world-map   MapGraphAdmin
*                         PageNotFound
```

Decisions baked into this tree:

- **Base path renamed** `game-something2` → `game`. Nothing external links to
  the old path; the backend is unaware of frontend routes.
- **`RequireAdmin` is a route, not a render-time `&&`.** Today a non-admin
  cannot reach an admin tab because the button is not rendered. With URLs they
  can type one, and the old `{isAdmin && activeTab === 'tiles' && …}` pattern
  would render an empty content area. `RequireAdmin` redirects to `/game`
  instead. The server's `adminGuard` remains the actual enforcement; this is UX
  and defence in depth, exactly as the existing `isAdmin` gating is.
- **`RequireAuth` wraps the layout, not the game.** Signed-out users get the
  login form with no sidebar or header around it, instead of today's login form
  rendered inside `Main` with empty chrome surrounding it.

### Auth lifted into context

`Something2.jsx` currently owns `authed`, `isAdmin`, the login gate, and two
session-liveness effects. The sidebar now needs `authed` and `isAdmin` to decide
what to render, and it lives *above* the game in the tree. Auth moves up.

New `frontend/src/context/AuthContext.jsx`:

```
{ authed, isAdmin, username, signIn(token), signOut() }
```

- `authed` — derived from a `token` state initialised with `getStoredToken()`.
- `isAdmin` — `parseJwt(token)?.role === 'admin'`.
- `username` — `parseJwt(token)?.username` (the backend signs `user_id`,
  `username`, `role`, `tv`; see `backend/src/auth/tokens.js`).
- `signIn(token)` — `storeToken(token)` then set state.
- `signOut()` — `clearToken()` then set state to `null`.

Both existing session-liveness effects move here **unchanged in behaviour**:

- The mount-time `GET /api/auth/me` probe that catches an already-revoked token
  (a `token_version` bump leaves the JWT parsing fine, so the client would
  otherwise believe it is signed in while every write 401s). It still only acts
  on a literal `401` — network errors and 5xx leave the session alone.
- The `AUTH_EXPIRED_EVENT` listener that catches a session revoked while the tab
  is open, fired by `noteAuthFailure` in `auth.js`.

Both now call `signOut()` and toast, rather than `setAuthed(false)`.

`Login.jsx` keeps its internals; its `onAuthed` callback calls `signIn()`.
`API_URL` moves to a shared `frontend/src/config.js` so `AuthContext` and
`LoginRoute` share one definition.

**`engineRef` is deleted** (D7). Sign-out no longer needs it: flipping `authed`
makes `RequireAuth` unmount `GameShell`, whose existing mount-once cleanup calls
`gameRef.current?.destroy()` — which is the teardown that was actually running
all along.

### Splitting `Something2.jsx`

The file is 890 lines. The routing change forces a split anyway, and the seam is
already visible: everything that must outlive a navigation vs. everything that
is the game view's own UI.

**`GameShell.jsx`** — the `/game` layout route. Keeps:

- `gameRef`, `canvasRef`, `contentRef`
- the `bindGameCanvas` effect and the `setOnTransition` / `handleEnterRef` wiring
- the mount-once `gameRef.current?.destroy()` cleanup
- `useMapTiles` / `useMapConfig` / `useVfxEffects` / `useWorlds` and the
  create/delete mutations, plus the derived `tileColors`
- `handleEnterChunkedWorld`, the auto-join effect, the fullscreen handlers
- the help panel and its `?` button
- the always-mounted `<canvas>`

Renders `<ContentArea ref={contentRef}>` containing the help panel,
`<Outlet context={…}/>`, and the canvas. **No `TabBar`.**

`activeTab === 'game'` becomes `const isGameRoute = !!useMatch('/game')`
(end-match, so it is false on `/game/biomes`). It replaces `activeTab` in:

- the canvas `display` rule: `isGameRoute && isPlaying ? 'block' : 'none'`
- the canvas-bind effect's dependency array: `[isGameRoute]`
- the auto-join effect's dependency array

The bind effect's `authed` dependency (added by F-045, when an
`authed` false→true cycle remounted the canvas node under a live `Game`) is
dropped: sign-out now unmounts `GameShell` entirely, so a sign-in always
produces a fresh mount. `bindGameCanvas` is kept — it is the defensive,
unit-tested rebinding path and re-running it against the same node is
idempotent.

**`GameView.jsx`** — the `/game` index route. Reads `useOutletContext()` and
renders the worlds `Panel` (list, admin-only create form, admin-only delete
icon, "Enter World"), `WorldPreview`, `Minimap`, `FullscreenToggle`,
`HowToButton`, `PauseOverlay`, and the "Select a world to preview it"
placeholder.

The context object passed through `<Outlet context={…}/>` is consumed only by
`GameView`; the admin panels ignore it and keep their current prop-free
signatures.

### Sidebar

`MainNav.jsx` is rewritten around a single `NAV_SECTIONS` definition — one
source of truth for label, icon, path, and admin colour:

```
Game
  Game View      /game              HiOutlinePuzzlePiece
Admin                                                     (rendered only if isAdmin)
  Tile Types     /game/tiles        HiOutlineWrenchScrewdriver
  Entities       /game/entities     HiOutlineBeaker            entity
  Items          /game/items        HiOutlineCube              items
  Maps           /game/maps         HiOutlineMap               maps
  Biomes         /game/biomes       HiOutlineGlobeAlt          maps
  World Map      /game/world-map    HiOutlineShare             maps
```

- Icons are carried over unchanged from the `TabBar`.
- The `/game` link takes `end` so it is not marked active on child routes.
- The `TabBar`'s admin colour-coding survives: the active link gets a left accent
  stripe coloured from `--s2-tab-entity` / `--s2-tab-items` / `--s2-tab-maps`,
  falling back to `--color-brand-600` for non-admin entries. (The sidebar is app
  chrome and otherwise stays on the `--color-*` palette; only the accent borrows
  from `--s2-*` to preserve the existing visual coding.)
- Labels are shortened and get `white-space: nowrap` (D6).
- The dead "Home" entry is removed (D4), along with the now-unused `Dashboard`
  import in `App.jsx`. `Dashboard.jsx` itself is left on disk untouched.

`Sidebar.jsx` becomes a flex column with `MainNav` above and a **Sign out**
button pinned to the bottom via `margin-top: auto`, calling `signOut()`.

`Logo.jsx` (D1) drops the `<img>` and the dark/light `src` switch in favour of a
text wordmark reading "Something2", styled with `--color-brand-600`. No asset
dependency, correct in both themes, no 404.

`HeaderMenu.jsx` (D5): the user `ButtonIcon` no longer navigates to `/account`.
It becomes a chip showing `<HiOutlineUser/> {username}` from the JWT; clicking
it opens a small menu whose one entry is Sign out. The `DarkModeToggle` beside
it is unchanged.

### Content area

`AppLayout`'s `Container` (`max-width: 130rem`, flex column, `gap: 3.2rem`) is
removed and `Main` loses its padding, so `Main` becomes a flush scroll container
and the game canvas fills its grid cell edge to edge.

Admin routes keep their padded, centred appearance **from the roots they already
have**: every one of the six admin components sets its own `padding: 2rem;
max-width: 1200-1400px; margin: 0 auto`. Retaining `Main`'s `4rem` padding on
top would produce `6rem` of stacked padding and two competing max-widths, so it
is dropped rather than conditionally toggled per route.

`Main` also changes `overflow: scroll` → `overflow: auto` and gains
`min-height: 0` so the grid cell can actually shrink; `GameShell`'s root becomes
`height: 100%` instead of `height: 100vh` (D3).

## Files

New:

- `frontend/src/config.js` — shared `API_URL`
- `frontend/src/context/AuthContext.jsx` — provider + `useAuth()`
- `frontend/src/ui/RequireAuth.jsx`, `frontend/src/ui/RequireAdmin.jsx`
- `frontend/src/pages/LoginRoute.jsx` — redirects to `/game` when already authed
- `frontend/src/games/something2/GameShell.jsx`
- `frontend/src/games/something2/GameView.jsx`

Modified: `App.jsx`, `ui/AppLayout.jsx`, `ui/Sidebar.jsx`, `ui/MainNav.jsx`,
`ui/Logo.jsx`, `ui/HeaderMenu.jsx`.

Deleted:

- `frontend/src/games/something2/Something2.jsx` — split into `GameShell.jsx`
  and `GameView.jsx`.
- `frontend/src/pages/GameSomething2.jsx` — a two-line passthrough (which
  imports `Something2` twice, once under an unused `LoginForm` alias). It is the
  only importer of `Something2.jsx`; the route points at `GameShell` directly.

## Testing

### Existing suite

`frontend/src/games/something2/__tests__/worldsPickerAdminGating.test.js` reads
`../Something2.jsx` **as source text** and asserts the delete-world icon and the
create-world form are lexically wrapped in `isAdmin &&`. That file will not
exist. The test must be repointed at `GameView.jsx`; its two regexes still apply
because the guarded JSX moves verbatim.

The `themeTokens` gate scans the `something2` directory for hardcoded colour
literals. The two `#0f0f1a` values and the `rgba(255,255,255,0.35)` in the game
view carry `s2-theme-exempt(...)` sentinel comments on their own lines; those
comments must move with the code into `GameView.jsx`.

Everything else in the suite must stay green.

### New unit tests

vitest here runs in a plain node environment (no jsdom/RTL), matching the
existing convention of pure-function and source-structure tests:

- `NAV_SECTIONS` — exported as data and asserted directly: the admin section is
  absent for a non-admin, every entry has a unique path, and every path in the
  nav has a matching route in the route table.
- `RequireAuth` / `RequireAdmin` — the redirect decision extracted as a pure
  function (`authed`/`isAdmin` in, redirect target or `null` out) and tested
  against all four input combinations.
- `AuthContext` — the token→`{authed, isAdmin, username}` derivation as a pure
  function: no token, valid non-admin token, valid admin token, malformed token.

### Browser verification

Per the project's usual pass against the running compose stack:

1. Sign in as admin. Confirm the sidebar shows both sections and the header chip
   shows the username.
2. Click each of the seven nav entries. Confirm the URL changes, the correct
   panel renders, exactly one scrollbar exists, and no label wraps or overlaps.
3. Reload on `/game/biomes`. Confirm it lands on Biomes, not the game view.
4. **Session survival:** enter a world, navigate to `/game/biomes`, navigate
   back. Confirm the world is still live — no reconnect, player position
   preserved, no blank canvas.
5. Sign in as a non-admin. Confirm the Admin section is absent and typing
   `/game/biomes` redirects to `/game` rather than rendering blank.
6. Sign out from the sidebar and from the header chip. Confirm both land on the
   login screen with no sidebar chrome, and that signing back in works.
7. Toggle dark mode on an admin route and on the game route.

## Out of scope

- A real `/account` page. The header chip identifies the user and offers sign
  out; account management is a separate feature.
- Restoring a `/dashboard` route. `Dashboard.jsx` stays on disk, unrouted.
- Any change to the admin panels' internals, the game engine, or the backend.
- Responsive/collapsible sidebar behaviour at narrow viewports.
