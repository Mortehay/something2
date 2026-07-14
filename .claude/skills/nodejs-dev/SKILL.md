---
name: nodejs-dev
description: Use when writing or editing the Express backend in backend/src — CommonJS, inline routes, raw pg queries, error shape, migrations.
---

# Node/Express conventions (something2)

Full detail lives in `.ai/styleguides/backend.md`; this is the short version.

- **CommonJS** (`require` / `module.exports`). Express 4.
- **Routes** currently live inline in `backend/src/index.js`. Don't add a per-resource router until that file passes ~600 lines or a resource has 5+ routes.
- **Postgres** via a single `pg` `Pool` from `process.env.DATABASE_URL`, raw parameterized queries (`$1, $2`). No ORM. JSON columns: `JSON.stringify` in, read raw out.
- **Error shape:** `try { ...; res.json(row) } catch (err) { console.error(err); res.status(500).json({ error: '...' }) }`. Validation → 400, not-found → 404 `{ error: '<resource> not found' }`, created → 201 with the row, destructive success → `{ success: true, id }`.
- **Migrations:** `node-pg-migrate` JS files in `backend/migrations/`, `<timestamp>_<description>.js`, run on startup. Never edit a committed migration — add a new one. Manual: `npm run migrate:up`.
- **Pure logic** goes in `backend/src/services/<name>.js` (reference `backend/src/services/mapService.js`); routes do I/O, services do algorithms.
- **No auth** yet — when it lands, add middleware before routes, not per-route checks.

Related: [[js-dev]], [[game-netcode]].
