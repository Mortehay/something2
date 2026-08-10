const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadMigrationFiles } = require('node-pg-migrate/dist/migration');

// SOMET-264 puts test-user-readme.md inside backend/migrations/, next to the
// migration it documents, because that is where someone looking for it will
// look. node-pg-migrate require()s EVERY file in that directory, so without an
// ignorePattern that one markdown file breaks the entire migration system --
// verified: `Can't get migration files: .../test-user-readme.md:1 # Test player
// account ^ SyntaxError`.
//
// There are TWO runners: the CLI (package.json's migrate scripts) and the app's
// own boot-time runMigrations() in src/index.js. Both need the pattern, and a
// fix applied to only one of them leaves the other broken -- which would show
// up as "migrations work from my terminal but the container will not start".
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const PATTERN = '(?!.*\\.js$).*';

test('the ignore pattern skips the readme and keeps every migration', async () => {
  const all = await loadMigrationFiles(MIGRATIONS_DIR, undefined);
  const kept = await loadMigrationFiles(MIGRATIONS_DIR, PATTERN);

  // Not vacuous: there really is a non-JS file in there to skip.
  assert.ok(all.includes('test-user-readme.md'),
    'expected test-user-readme.md in the migrations directory');
  assert.ok(!kept.includes('test-user-readme.md'), 'the readme must be skipped');

  const js = all.filter((f) => f.endsWith('.js'));
  assert.deepEqual(kept, js, 'every .js migration must survive the filter, and only those');
  assert.ok(js.length > 50, `expected the real migration set, found ${js.length}`);
});

test('both migration runners use the same pattern', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  for (const script of ['migrate', 'migrate:up']) {
    assert.match(pkg.scripts[script], /--ignore-pattern/,
      `npm run ${script} would try to require the readme as a migration`);
    assert.ok(pkg.scripts[script].includes(PATTERN),
      `npm run ${script} uses a different ignore pattern than src/index.js`);
  }

  // The app's own runner. Asserted on source text because runMigrations() is
  // only invoked under `require.main === module` and cannot be called here.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(src, /ignorePattern:\s*MIGRATION_IGNORE_PATTERN/,
    "the app's boot-time migration runner must pass an ignorePattern");

  // The literal is EVALUATED before comparing. Matching the source bytes would
  // compare index.js's `\\.` against this file's `\.` and fail on two spellings
  // of the same pattern.
  const declared = /const MIGRATION_IGNORE_PATTERN = '((?:[^'\\]|\\.)*)'/.exec(src);
  assert.ok(declared, 'could not find the MIGRATION_IGNORE_PATTERN declaration in src/index.js');
  const value = JSON.parse(`"${declared[1].replace(/"/g, '\\"')}"`);
  assert.equal(value, PATTERN,
    'src/index.js uses a different ignore pattern than the npm scripts');
});
