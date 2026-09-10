// SOMET-556. The Maps admin "Add village" form shipped defaults of 6x5 while the
// server rejects any box whose width + height exceeds VILLAGE_LIMITS.maxSum, so
// the button was guaranteed to 400 until the admin edited the size fields. The
// defaults are now 5x5.
//
// This test exists because the two numbers live on opposite sides of the wire
// and neither file mentions the other. maxSum is DERIVED --
// largestTileSumWithinBudget searches for the largest tile sum whose on-screen
// box fits in a quarter of the viewport -- so it moves on its own if ISO_K, the
// tile size or the screen budget changes. Copying it into the .jsx would drift
// silently; pinning it here means a shrinking budget goes red and names the file
// to edit instead of quietly restoring the always-fails behaviour.
//
// Reading the .jsx as text rather than importing it: the frontend is ESM built
// by vite and this is a CommonJS node --test process, and the frontend's own
// vitest runs node-env with no DOM so it could not render the component either.
// The constants are asserted to exist by name first, so a rename fails loudly
// rather than making the regex quietly match nothing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { VILLAGE_LIMITS } = require('../src/services/villages.js');

const FORM = path.join(
  __dirname, '../../frontend/src/games/something2/MapsAdmin.jsx',
);

function formDefault(name) {
  const src = fs.readFileSync(FORM, 'utf8');
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*(\\d+);`));
  assert.ok(m, `${name} not found in MapsAdmin.jsx -- was it renamed or inlined? `
    + 'The admin form default and the server limit have to stay reconcilable.');
  return Number(m[1]);
}

test('VILLAGE_LIMITS exposes a numeric maxSum', () => {
  // Guards the rest of the file: if this import ever came back undefined, every
  // comparison below would be against NaN and could not fail.
  assert.equal(typeof VILLAGE_LIMITS.maxSum, 'number');
  assert.ok(Number.isFinite(VILLAGE_LIMITS.maxSum), 'maxSum must be finite');
});

test("the admin form's default village box is accepted by the server's own limits", () => {
  const w = formDefault('VILLAGE_DEFAULT_W');
  const h = formDefault('VILLAGE_DEFAULT_H');

  assert.ok(w + h <= VILLAGE_LIMITS.maxSum,
    `Add village defaults are ${w}x${h} = ${w + h}, over VILLAGE_LIMITS.maxSum `
    + `(${VILLAGE_LIMITS.maxSum}). The form's first click would 400. Lower `
    + 'VILLAGE_DEFAULT_W/H in frontend/src/games/something2/MapsAdmin.jsx.');

  // The sum is the rule that actually bit, but a default outside the per-axis
  // bands would fail just as hard and with a different message.
  assert.ok(w >= VILLAGE_LIMITS.minW && w <= VILLAGE_LIMITS.maxW,
    `default width ${w} is outside ${VILLAGE_LIMITS.minW}..${VILLAGE_LIMITS.maxW}`);
  assert.ok(h >= VILLAGE_LIMITS.minH && h <= VILLAGE_LIMITS.maxH,
    `default height ${h} is outside ${VILLAGE_LIMITS.minH}..${VILLAGE_LIMITS.maxH}`);
});

test('the old 6x5 default really was rejected, so this test could have caught it', () => {
  // Without this the file would pass just as happily against a limit so large
  // that nothing could ever violate it -- it pins that maxSum is still tight
  // enough for the original bug to be a bug.
  assert.ok(6 + 5 > VILLAGE_LIMITS.maxSum,
    'maxSum has grown past 11, so the regression this test guards is no longer '
    + 'possible and the test needs revisiting rather than deleting.');
});
