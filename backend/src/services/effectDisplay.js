// SOMET-769: the `display` column every effect table carries (vfx_effects, aura_effects,
// buff_visuals, status_visuals): how the row is shown in game.
//   'sprite' -- the sheet may be used; the player's Animations setting decides (default).
//   'code'   -- the drawn (code) version only, whatever the player chose.
// Pure rules here; the one write that is not a per-row save (set for all) too.
'use strict';

const { EFFECT_KINDS, kindOf } = require('./effectKinds.js');

const DISPLAYS = Object.freeze(['code', 'sprite']);
const DEFAULT_DISPLAY = 'sprite';

const isDisplay = (v) => DISPLAYS.includes(v);

// Error string for a body's `display`, or null. A body WITHOUT the key is fine (the row keeps
// its stored value); a key that is present must be one of the two words.
function displayError(b) {
  if (!b || typeof b !== 'object' || !('display' in b)) return null;
  return isDisplay(b.display) ? null : `display must be one of ${DISPLAYS.join(', ')}`;
}

// Column + value to write for a save: nothing when the body has no key (keep stored),
// else the validated value. `withDefault` (an insert) writes the default instead of nothing.
function displayWrite(b, { withDefault = false } = {}) {
  if (b && typeof b === 'object' && 'display' in b) return { cols: ['display'], vals: [b.display] };
  return withDefault ? { cols: ['display'], vals: [DEFAULT_DISPLAY] } : { cols: [], vals: [] };
}

// Set every row of one effect table. `subjectKind` is an effectKinds key (vfx, aura, buff,
// status), never a table name from a request. Returns the number of rows set.
async function setDisplayForAll(db, subjectKind, display) {
  const kind = kindOf(subjectKind);
  if (!kind) throw new Error(`unknown effect kind ${subjectKind}`);
  if (!isDisplay(display)) throw new Error(`display must be one of ${DISPLAYS.join(', ')}`);
  const touch = kind.updatedAt ? ', updated_at = now()' : '';
  const r = await db.query(`UPDATE ${kind.table} SET display = $1${touch}`, [display]);
  return r.rowCount;
}

module.exports = { DISPLAYS, DEFAULT_DISPLAY, isDisplay, displayError, displayWrite, setDisplayForAll, EFFECT_KINDS };
