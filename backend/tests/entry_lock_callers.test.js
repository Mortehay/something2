// SOMET-786. Every holder of the entry-world key must wait the same ENTRY_LOCK_WAIT_MS
// (90 s, helpers/entryWorld.js). withEntryPreserved does; two files took the key directly
// through withAdvisoryLock and got its 6 s default, so beside one long holder they ran
// UNGUARDED and moved is_entry under a peer -- the "two worlds hold is_entry" failure
// seed_map_db hit in SOMET-784. Scans the real test files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = __dirname;
const files = [
  // Not this file: its own failing sample below would read as a holder.
  ...fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && f !== path.basename(__filename)).map((f) => path.join(DIR, f)),
  ...fs.readdirSync(path.join(DIR, 'helpers')).filter((f) => f.endsWith('.js')).map((f) => path.join(DIR, 'helpers', f)),
];

// From each `withAdvisoryLock(<pool>, ENTRY_LOCK_KEY` to the matching close of the call:
// returns the call's source text, so the options argument can be checked.
function entryLockCalls(src) {
  const out = [];
  const re = /withAdvisoryLock\(\s*\w+,\s*ENTRY_LOCK_KEY\b/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = src.indexOf('(', m.index);
    const start = i;
    for (; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') { depth -= 1; if (depth === 0) break; }
    }
    out.push(src.slice(start, i + 1));
  }
  return out;
}

test('the scan finds the direct holders (it can see what it guards)', () => {
  const holders = files.filter((f) => entryLockCalls(fs.readFileSync(f, 'utf8')).length);
  const names = holders.map((f) => path.basename(f)).sort();
  for (const f of ['entryWorld.js', 'entry_world.test.js', 'map_spec_link_authority.test.js']) {
    assert.ok(names.includes(f), `scan misses ${f}`);
  }
});

test('every direct entry-lock holder waits ENTRY_LOCK_WAIT_MS, never the 6 s default', () => {
  const bad = [];
  for (const f of files) {
    for (const call of entryLockCalls(fs.readFileSync(f, 'utf8'))) {
      if (!/\bwaitMs:\s*ENTRY_LOCK_WAIT_MS\b/.test(call)) bad.push(path.basename(f));
    }
  }
  assert.deepEqual(bad, []);
});

test('the check can fail: a call without the wait is caught', () => {
  const calls = entryLockCalls('await withAdvisoryLock(pool, ENTRY_LOCK_KEY, async () => { f(1); });');
  assert.equal(calls.length, 1);
  assert.ok(!/\bwaitMs:\s*ENTRY_LOCK_WAIT_MS\b/.test(calls[0]));
});
