# Frontend styleguide

Patterns observed across `frontend/src/`. Each entry has a concrete file reference. Update this file when intentionally diverging — or when refactors change the convention.

## Provider stack

[frontend/src/main.jsx](../../frontend/src/main.jsx) wraps the app in `StrictMode > ErrorBoundary` (with `onReset` doing `window.location.replace('/')`). [frontend/src/App.jsx](../../frontend/src/App.jsx) wraps the app body in `DarkModeProvider > QueryClientProvider > BrowserRouter`. The single `<Toaster />` lives at the bottom of `App` with project-wide style + duration overrides.

New providers go in `App.jsx` unless they need to render above the error boundary.

## Styled-components + design tokens (scoped to `frontend/src/ui/`)

Reusable UI primitives in [frontend/src/ui/](../../frontend/src/ui/) are styled-components that read CSS variables defined in [frontend/src/styles/GlobalStyles.js](../../frontend/src/styles/GlobalStyles.js): `var(--color-grey-0)`, `var(--color-brand-600)`, `var(--shadow-sm)`, `var(--border-radius-sm)`, `var(--backdrop-color)`, etc.

For new UI primitives, use tokens — don't hardcode hex colors, radii, or shadows. If a token is missing, add one to `GlobalStyles.js` rather than inline-styling.

The in-game UI (e.g. [frontend/src/games/something2/Something2.jsx](../../frontend/src/games/something2/Something2.jsx)) intentionally uses its own dark gaming palette with hardcoded hex (`#0f0f1a`, `#1a1a2e`, `#facc15`, `#4a9eff`, ...). This is deliberate visual separation from the admin/dashboard UI — don't "fix" it by replacing with tokens.

### Rem base

[frontend/src/styles/GlobalStyles.js:113-115](../../frontend/src/styles/GlobalStyles.js#L113-L115) sets `html { font-size: 62.5% }`, so **`1rem = 10px`**. That's why padding values like `padding: 4rem 4.8rem 6.4rem` (e.g. [frontend/src/ui/AppLayout.jsx:14-15](../../frontend/src/ui/AppLayout.jsx#L14-L15)) read as 40px / 48px / 64px, not 64px / 76.8px / 102.4px.

### Light/dark mode

[frontend/src/styles/GlobalStyles.js:8,45](../../frontend/src/styles/GlobalStyles.js#L8-L45) defines `&.light-mode` and `&.dark-mode` blocks on `:root` that **swap the values of the same token names**. Components that use `var(--color-grey-700)` get the right color in both modes for free; components that hardcode `#374151` break dark mode silently. This is the actual reason the token rule above matters.

## Variant patterns

Two patterns coexist for multi-style components — match whichever the surrounding code uses:

- **Const-lookup tables** ([frontend/src/ui/Button.jsx:3-49](../../frontend/src/ui/Button.jsx#L3-L49)): `size` / `variation` props index into `const sizes = { ... }` and `const variations = { ... }` objects of `css\`...\`` blocks. Good for 3+ variants.
- **Inline checks** ([frontend/src/ui/Form.jsx:3-23](../../frontend/src/ui/Form.jsx#L3-L23)): `props.type === 'regular' && css\`...\`` directly in the template. Fine for 1–2 variants.

Don't switch on string props inside a single template literal (i.e. `${props => props.size === 'small' ? '...' : '...'}` within one big css block).

### Transient props

For props that drive styling but **must not reach the DOM**, use the styled-components 6 transient-prop syntax: prefix with `$`. See [frontend/src/games/something2/Something2.jsx:28-31](../../frontend/src/games/something2/Something2.jsx#L28-L31) — `$active`, `$adminType`. Without the `$`, React 19 will warn about unknown DOM attributes.

### `defaultProps` is legacy

[frontend/src/ui/Button.jsx:59-62](../../frontend/src/ui/Button.jsx#L59-L62) and [frontend/src/ui/Form.jsx:25-27](../../frontend/src/ui/Form.jsx#L25-L27) set `Component.defaultProps = { ... }`. This still works on styled-components today but is **deprecated for function components in React 19** and will warn eventually. For new components, use destructuring defaults instead:

```js
const Foo = styled.button`${(props) => sizes[props.$size]}`;
function Wrapper({ $size = 'medium', ...rest }) { return <Foo $size={$size} {...rest} />; }
```

Don't refactor the existing files just for this — leave them alone until they're touched anyway.

## Server I/O via TanStack Query hooks per feature

All server I/O goes through TanStack Query hooks, co-located in `<feature>/use<Thing>.js`. Reference: [frontend/src/games/something2/useMaps.js](../../frontend/src/games/something2/useMaps.js).

- One file per feature, named exports per resource: `useMaps`, `useGenerateMap`, `useDeleteMap`, ...
- Queries: `useQuery({ queryKey: [...], queryFn: async () => { ... } })`. Throw a real `Error` from `queryFn` on `!res.ok`.
- Mutations: `mutationFn` does the fetch; `onSuccess` calls `queryClient.invalidateQueries({ queryKey: [...] })` and `toast.success(...)`; `onError` calls `toast.error(\`... ${err.message}\`)`.
- API base URL: `import.meta.env.VITE_API_URL` with a localhost fallback.
- Don't `fetch` directly from components.

## Routing

Route tree lives in `App.jsx`. Layout routes wrap pages via `<Route element={<AppLayout />}>`. Top-level fallback `<Route path="*" element={<PageNotFound />} />`. New pages go under `frontend/src/pages/` and are registered in `App.jsx`.

## User feedback

`toast.success` / `toast.error` from `react-hot-toast` for user-visible feedback. Don't add custom notification components.

## ESLint

ESLint 10 flat config: [frontend/eslint.config.js](../../frontend/eslint.config.js). Run `npm run lint` from `frontend/`. Don't disable rules inline without a comment explaining why.
