/* eslint-disable camelcase */
exports.shorthands = undefined;

// SOMET-618. catalog_art can outlive a skill that was renamed or removed
// from seeds/data/skills.js -- artSeed.js's exportRows already skips any
// 'skill' row whose key has no match in the current SKILLS list ("Art with
// no subject is not exported: nothing could seed it back"), which is why
// textures/skills.json no longer lists it even though the row can still
// live in a deployed database's catalog_art table (and did: /api/game-art
// reported 301 skill keys against a 300-skill client/backend catalog).
//
// dru_charm_creature was never a real Druid skill gem. The Druid's charm is
// the class-gated `charm` WS message (SOMET-473, backend/src/services/
// charm.js / authority/server.js's `charm` handler), not a skill -- there is
// no dru_charm_creature entry in seeds/data/skills.js at any point in this
// repo's history of that file. This drops the one orphaned row so the game
// art index matches the 300-skill catalog on both sides.
//
// Frozen literal, not a dynamic diff against skills.js: this fixes the one
// known drift. skillsCatalogParity.test.js (frontend) guards the client and
// backend catalogs from drifting again; this migration only cleans up data
// already written before that guard existed.
//
// Exported so a test can run it against real rows (see audio_jobs_needs_
// prompt_backfill.js for the same pattern).
const PRUNE_SQL = `DELETE FROM catalog_art WHERE subject_kind = 'skill' AND subject_key = 'dru_charm_creature'`;

exports.PRUNE_SQL = PRUNE_SQL;

exports.up = (pgm) => {
  pgm.sql(PRUNE_SQL);
};

// Nothing to undo: the row pointed a generated image at a skill id that has
// never existed in the SKILLS catalog this migration runs against.
exports.down = () => {};
