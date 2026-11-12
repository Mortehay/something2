#!/usr/bin/env node
// SOMET-381. Mint and inspect invite codes for REGISTRATION_MODE=invite.
//
// Deliberately a CLI and not an admin API route. Issuing invites is a rare,
// operator-shaped action, and an HTTP endpoint for it would be one more
// authenticated surface on a public deployment for no gain -- the operator
// already has shell access, which is how the codes get delivered anyway.
//
// Usage:
//   node scripts/invite-codes.js mint [count] [--note "for alice"] [--json]
//   node scripts/invite-codes.js list [--all] [--json]
//   node scripts/invite-codes.js revoke <code> [--json]
//
// --json prints ONE line of JSON instead of the human text (SOMET-734: the
// admin tab reads it through the pi helper; parsing the text would break on
// the first note with a parenthesis in it):
//   mint   {"codes":["ABCD-EFGH-JKMN"],"requested":1}
//   list   {"invites":[{"code","note","createdAt","usedAt","usedBy","createdBy","status"}]}
//          status is "unused", "used" or "revoked" (burned by `revoke`, or
//          soft-revoked by its player creator via revoked_at)
//          createdBy is the creator's username, or null (operator-minted/deleted)
//   revoke {"revoked":"ABCD-EFGH-JKMN"} or {"revoked":null}

const { Pool } = require('pg');

const { ALPHABET, mintCode } = require('../src/auth/inviteCodeGen.js');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

const REVOKED_MARK = ' [revoked]';
function statusOf(r) {
  if (r.revoked_at && !r.used_at) return 'revoked';
  if (!r.used_at) return 'unused';
  return !r.used_by && String(r.note || '').endsWith(REVOKED_MARK) ? 'revoked' : 'used';
}

async function main() {
  const cmd = process.argv[2] || 'list';
  const json = process.argv.includes('--json');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (cmd === 'mint') {
      const raw = process.argv[3];
      const count = Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : 1;
      const note = arg('--note');
      const made = [];
      for (let i = 0; i < count; i++) {
        // Retry on the astronomically unlikely collision rather than crashing
        // an operator's batch halfway through.
        for (let attempt = 0; attempt < 5; attempt++) {
          const code = mintCode();
          const r = await pool.query(
            'INSERT INTO invite_codes (code, note) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING code',
            [code, note],
          );
          if (r.rows.length) { made.push(r.rows[0].code); break; }
        }
      }
      if (made.length < count) {
        console.error(`WARNING: minted only ${made.length} of ${count} requested`);
      }
      if (json) console.log(JSON.stringify({ codes: made, requested: count }));
      else for (const c of made) console.log(c);
      return;
    }

    if (cmd === 'revoke') {
      const code = process.argv[3];
      if (!code) throw new Error('revoke needs a code');
      // Only a code nobody has spent: revoking a used one would rewrite its history and claim a success that changed nothing.
      // Burn it rather than delete it: the row is the record that the code
      // existed, and deleting would let the same string be minted again.
      const r = await pool.query(
        `UPDATE invite_codes SET used_at = COALESCE(used_at, now()), note = COALESCE(note,'') || ' [revoked]'
          WHERE code = $1 AND used_at IS NULL RETURNING code, used_at`, [code]);
      if (json) console.log(JSON.stringify({ revoked: r.rows.length ? r.rows[0].code : null }));
      else console.log(r.rows.length ? `revoked ${r.rows[0].code}` : 'nothing revoked: no such code, or it is already used');
      return;
    }

    const all = process.argv.includes('--all');
    const { rows } = await pool.query(
      `SELECT i.code, i.note, i.created_at, i.used_at, i.used_by, i.revoked_at,
              u.username AS created_by_name
         FROM invite_codes i LEFT JOIN users u ON u.id = i.created_by
        ${all ? '' : 'WHERE i.used_at IS NULL AND i.revoked_at IS NULL'}
        ORDER BY i.created_at DESC`);
    if (json) {
      console.log(JSON.stringify({
        invites: rows.map((r) => ({
          code: r.code,
          note: r.note,
          createdAt: r.created_at.toISOString(),
          usedAt: r.used_at ? r.used_at.toISOString() : null,
          usedBy: r.used_by ?? null,
          createdBy: r.created_by_name ?? null,
          status: statusOf(r),
        })),
      }));
      return;
    }
    if (!rows.length) { console.log(all ? 'no invite codes' : 'no unused invite codes'); return; }
    for (const r of rows) {
      const state = statusOf(r) === 'revoked' ? 'revoked' : r.used_at ? `used ${r.used_at.toISOString().slice(0, 10)}${r.used_by ? ` by user ${r.used_by}` : ''}` : 'unused';
      console.log(`${r.code}  ${state}${r.created_by_name ? `  by ${r.created_by_name}` : ''}${r.note ? `  (${r.note})` : ''}`);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}

module.exports = { mintCode, ALPHABET };
