// backend/tests/progression_frame_shape.test.js
//
// Contract §6.3. `stats` must ride EVERY progression frame, not only the
// refreshPlayerStats push -- a client that seeds from a kill push and then
// renders derived numbers would otherwise show pre-level-up values with
// nothing to correct them.
//
// Source text rather than a running server: the six sites are spread across
// five handlers with different preconditions (a kill, a death, a socket, an
// unsocket, a chest, a refresh), and standing all six up would test the
// harness rather than the frames.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// COMMENTS ARE STRIPPED FIRST, and that is not a nicety. server.js documents
// each frame's shape in prose right above it -- `{type:'progression',
// progression, leveledUp, ...}` appears verbatim inside a comment on the chest
// path, and `derivePlayerStats(progression) alone would ...` inside another.
// Scanning the raw text matched both and reported two failures against code
// that was already correct. Only whole-line comments are removed: a trailing
// `//` strip would also eat the `ws://` in this file's string literals.
const raw = fs.readFileSync(path.resolve(__dirname, '../src/authority/server.js'), 'utf8');
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n');

test('stripping comments did not empty the file out', () => {
  // The strip is itself a place a vacuous pass can hide: an over-eager regex
  // that removed everything would make every scan below trivially clean.
  // server.js is genuinely ~61% comment by character count, so the bound is
  // deliberately loose -- it is here to catch a strip that ate EVERYTHING, not
  // to police the comment ratio. The two positive assertions below are the
  // ones with teeth.
  assert.ok(src.length > raw.length * 0.2,
    `comment stripping removed ${Math.round((1 - src.length / raw.length) * 100)}% of the file`);
  assert.match(src, /const framedStats = /);
  assert.match(src, /entry\.world\.applyDerivedStats/);
});

// Every `{ type: 'progression', ... }` object literal, matched up to its
// closing brace. The frames are all short, single-level objects; the 240-char
// window is comfortably larger than the longest of them.
function progressionFrames() {
  return [...src.matchAll(/\{\s*\n?\s*type:\s*'progression',[\s\S]{0,240}?\}/g)].map((m) => m[0]);
}

test('the frame scan finds every send site the file actually has', () => {
  // The fixed point. If the regex stops matching, every assertion below passes
  // over an empty list -- the exact vacuous shape this repo keeps rediscovering.
  const declared = [...src.matchAll(/type:\s*'progression'/g)].length;
  const frames = progressionFrames();
  assert.strictEqual(frames.length, declared,
    `${declared} progression sends in the file but the frame regex matched ${frames.length}`);
  assert.ok(frames.length >= 6, `found only ${frames.length} progression frames -- has the send shape changed?`);
});

test('every progression frame carries stats', () => {
  const missing = progressionFrames().filter((f) => !/\bstats\b/.test(f));
  assert.deepStrictEqual(missing, [],
    'these progression frames omit `stats` (contract §6.3)');
});

test('no progression frame recomputes stats from an unbuffed row', () => {
  // withStoneBonuses is what folds socketed buff stones in. A frame that
  // called derivePlayerStats(progression) directly would report numbers the
  // live world does not use.
  const bare = [...src.matchAll(/derivePlayerStats\((?!withStoneBonuses)/g)];
  assert.strictEqual(bare.length, 0,
    'derivePlayerStats must be called on a stone-buffed row inside the authority');
});

// Contract §4 / the Group C contract addition: Game.js's onProgression keeps
// `msg.progression` and DISCARDS every sibling field. The composed fields
// therefore have to be inside the object, and `stats` is the single documented
// exception. A frame that hoisted `passivePoints` or `allocatedNodeIds` to the
// top level would look correct in a wire capture and be silently dropped by
// every client.
test('no progression frame hoists a composed field to the top level', () => {
  const hoisted = progressionFrames().filter((f) => /^[^]*?\b(passivePoints|allocatedNodeIds|sources|modifiers|effective):/m.test(f));
  assert.deepStrictEqual(hoisted, [],
    'composed fields ride INSIDE `progression`; Game.js drops every sibling but `stats`');
});
