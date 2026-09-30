// The stored prompt per audio slot (spec 2026-09-30 §4). One ACTIVE row per
// (kind, key, slot); a save deactivates the current row and inserts a new
// one in ONE transaction, so history is kept and the partial unique index
// (audio_prompts_one_active) is the arbiter of a race: the loser gets 23505,
// which becomes a 409 -- two writers to one slot is a conflict to show the
// admin, not a server error.
//
// '' IS A VALUE. A stored empty text means someone cleared the prompt on
// purpose; generation then falls through to its old path. null is never
// stored in `text` (the column is NOT NULL); "no prompt" is "no active row".
const { Client } = require('pg');

const MAX_PROMPT_TEXT = 400;
const COLS = 'id, subject_kind, subject_key, slot, style, text, source_input, hint, model, via, active, created_at';

function conflict(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

async function getActive(db, kind, key, slot) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM audio_prompts
      WHERE subject_kind = $1 AND subject_key = $2 AND slot = $3 AND active`, [kind, key, slot]);
  return rows[0] || null;
}

async function listForSubject(db, kind, key) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM audio_prompts WHERE subject_kind = $1 AND subject_key = $2
      ORDER BY slot, created_at DESC, id DESC`, [kind, key]);
  const out = {};
  for (const r of rows) {
    if (!out[r.slot]) out[r.slot] = { active: null, history: [] };
    if (r.active) out[r.slot].active = r; else out[r.slot].history.push(r);
  }
  return out;
}

async function listAllActive(db) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM audio_prompts WHERE active ORDER BY subject_kind, subject_key, slot`);
  return rows;
}

// `expectActiveId`: the active row id the caller's edit was based on (null =
// "I saw no prompt"; undefined = "don't check" -- the seeder, which applies a
// checked-in file on purpose, and a PUT that sends no expect_active_id). The
// card always sends one, and every model write passes one: the Write route
// the row it read before calling the model, the batch the row its
// start-of-run snapshot saw.
async function save(db, kind, key, slot, {
  style = null, text, sourceInput = null, hint = null, model = null, via = null,
}, { expectActiveId } = {}) {
  const body = String(text == null ? '' : text).trim().slice(0, MAX_PROMPT_TEXT);
  // A bare pg Client (a PoolClient from pool.connect() is one too, via
  // prototype chain) means the CALLER owns the transaction: run our
  // statements on it as given, no BEGIN/COMMIT/ROLLBACK/release. Anything
  // else (a Pool, or the app's pool proxy) gets its own connection+
  // transaction here. `typeof db.connect === 'function'` alone can't tell
  // them apart -- a Client has .connect() too, and calling it on an
  // already-connected Client throws "Client has already been connected".
  const callerOwned = db instanceof Client;
  const client = callerOwned ? db : (typeof db.connect === 'function' ? await db.connect() : db);
  const release = !callerOwned && client !== db;
  try {
    if (!callerOwned) await client.query('BEGIN');
    const cur = await client.query(
      `SELECT id FROM audio_prompts
        WHERE subject_kind = $1 AND subject_key = $2 AND slot = $3 AND active FOR UPDATE`, [kind, key, slot]);
    const curId = cur.rows[0] ? String(cur.rows[0].id) : null;
    if (expectActiveId !== undefined && String(expectActiveId ?? '') !== String(curId ?? '')) {
      throw conflict('this prompt was changed by someone else; reload it');
    }
    if (curId) await client.query('UPDATE audio_prompts SET active = false WHERE id = $1', [curId]);
    const { rows } = await client.query(
      `INSERT INTO audio_prompts (subject_kind, subject_key, slot, style, text, source_input, hint, model, via)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLS}`,
      [kind, key, slot, style || null, body, sourceInput, hint || null, model, via]);
    if (!callerOwned) await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    if (!callerOwned) await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') throw conflict('this prompt was changed by someone else; reload it');
    throw err;
  } finally {
    if (release) client.release();
  }
}

module.exports = {
  MAX_PROMPT_TEXT, getActive, listForSubject, listAllActive, save,
};
