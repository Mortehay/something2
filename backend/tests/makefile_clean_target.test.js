const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// F-042 (SOMET-222): `make clean` ran `docker compose ... down -v --rmi all
// --remove-orphans`. The `-v` flag deletes named volumes -- postgres_data,
// redis_data, minio_data, sprite-models -- with no confirmation and no name
// hinting at data loss, unlike `down`/`restart`/`rebuild` (defined right
// above it in the same file), none of which touch volumes. A developer
// running `make clean` expecting the same kind of tidy-up loses the local
// Postgres database and every MinIO-stored sprite.
//
// This test reads the Makefile as text and asserts the default `clean`
// target's recipe does not carry the volume-deleting `-v` flag, and that a
// separate, clearly-named target exists for the destructive path.

const MAKEFILE_PATH = path.join(__dirname, '..', '..', 'Makefile');

function targetRecipe(text, targetName) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^${targetName}:`).test(l));
  assert.ok(start !== -1, `target '${targetName}' not found in ${MAKEFILE_PATH}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    // A tab-indented line is part of the recipe; anything else ends it
    // (blank line, comment, or the next target).
    if (!/^\t/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

test('make clean does not delete named volumes', () => {
  const text = fs.readFileSync(MAKEFILE_PATH, 'utf8');
  const recipe = targetRecipe(text, 'clean');
  assert.ok(
    !/docker compose[^\n]*\s-v(\s|$)/.test(recipe),
    `'clean' target's recipe still carries the volume-deleting -v flag:\n${recipe}`
  );
  // --remove-orphans and --rmi all (image cleanup) are fine to keep; only the
  // volume flag is the data-loss risk this finding is about.
  assert.ok(/--remove-orphans/.test(recipe), "'clean' should still remove orphaned containers");
});

test('a separate, clearly-named target exists for the destructive (volume-deleting) path', () => {
  const text = fs.readFileSync(MAKEFILE_PATH, 'utf8');
  // Matches the finding's proposed_fix shape: a rename (nuke/clean-all) or a
  // confirmation-gated variant. Either way, the volume flag must show up
  // *somewhere* in the file, just not in the default `clean` target above.
  assert.ok(
    /-v\s--rmi all --remove-orphans|--rmi all -v --remove-orphans/.test(text),
    'expected some Makefile target to still offer the destructive down -v path, opt-in'
  );
});
