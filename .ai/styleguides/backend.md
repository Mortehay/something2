# Backend styleguide

Patterns observed in `backend/src/`. Each entry has a concrete file reference. Update this file when intentionally diverging.

## CommonJS, not ESM

Backend uses `require` / `module.exports`. Frontend uses ESM. Don't switch backend to ESM without a deliberate decision (would need `"type": "module"` in [backend/package.json](../../backend/package.json) and rewriting every require/export).

## Routes inline in `index.js`

All Express routes currently live in [backend/src/index.js](../../backend/src/index.js) (~450 lines). Don't introduce a per-resource router for two endpoints.

When this file exceeds ~600 lines or a resource has 5+ routes, split by resource into `backend/src/routes/<resource>.js` and mount with `app.use('/api/<resource>', router)`. Keep helpers (`getTileTypesMap`, `getEntityTypesMap`) where they're used until they get reused.

## Postgres via raw `pool.query`

Single `Pool` constructed in `index.js` from `process.env.DATABASE_URL`. Parameterized queries with `$1, $2, ...` placeholders. No ORM, no query builder. Reference pattern: [backend/src/index.js:148-177](../../backend/src/index.js#L148-L177).

JSON columns are stored with `JSON.stringify(...)` on the way in and read directly out of `result.rows[i].column_name`.

## Error handling pattern

Every route follows:

```js
try {
  // ... work ...
  res.json(result.rows[0]);
} catch (err) {
  console.error(err);
  res.status(500).json({ error: '<descriptive message>' });
}
```

Validation: return `400` with `{ error: '...' }`. Not-found: return `404` with `{ error: '<resource> not found' }`. Created: return `201` with the row. Successful destructive ops: return `{ success: true, id }`. Match this shape on new routes.

## Migrations

`node-pg-migrate` JS files in [backend/migrations/](../../backend/migrations/), filename format `<timestamp>_<description>.js`. Migrations run on backend startup via `runMigrations()` in [backend/src/index.js:25-40](../../backend/src/index.js#L25-L40). Manual runs: `npm run migrate:up` from `backend/`.

Don't edit a committed migration — add a new one.

## Service modules

Pure logic (no Express, no `pool`) goes in `backend/src/services/<name>.js` and is `require`d from `index.js`. The route does I/O (read body, query db); the service does the algorithm. See [backend/src/services/mapService.js](../../backend/src/services/mapService.js) (`generateWFC`).

## No auth

There is no auth middleware. Every endpoint is public. When auth lands, add it as middleware before the routes are mounted — don't add per-route checks.

## Logging

`console.log` for events, `console.error(err)` in catch blocks. No structured logger yet. When one is added, replace globally rather than mixing styles.
