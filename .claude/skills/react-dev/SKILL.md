---
name: react-dev
description: Use when writing or editing React components in frontend/src — provider stack, styled-components tokens, TanStack Query data hooks, routing.
---

# React conventions (something2)

Full detail lives in `.ai/styleguides/frontend.md`; this is the short version.

- **React 19 + Vite 8.** Function components only.
- **Provider stack:** new providers go in `frontend/src/App.jsx` (order: `DarkModeProvider > QueryClientProvider > BrowserRouter`), unless they must render above the error boundary in `frontend/src/main.jsx`.
- **Styling:** styled-components 6. Reusable UI primitives in `frontend/src/ui/` read CSS-variable design tokens from `frontend/src/styles/GlobalStyles.js` (`var(--color-grey-0)`, etc). Don't hardcode hex in UI primitives — add a token instead. Exception: in-game UI (`frontend/src/games/something2/Something2.jsx`) deliberately uses a hardcoded dark gaming palette — leave it.
- **Transient props:** style-only props that must not hit the DOM get a `$` prefix (`$active`). React 19 warns otherwise.
- **Data:** all server I/O goes through TanStack Query hooks co-located in `<feature>/use<Thing>.js` (reference `frontend/src/games/something2/useMaps.js`). Never `fetch` from a component. API base is `import.meta.env.VITE_API_URL`.
- **Feedback:** `toast.success` / `toast.error` from react-hot-toast. No custom notification components.
- **Routing:** route tree in `App.jsx`; new pages under `frontend/src/pages/`.

Related: [[js-dev]], [[js-game-dev]].
