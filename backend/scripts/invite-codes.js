#!/usr/bin/env node
// SOMET-381. Mint and inspect invite codes for REGISTRATION_MODE=invite.
//
// Deliberately a CLI and not an admin API route. Issuing invites is a rare,
// operator-shaped action, and an HTTP endpoint for it would be one more
// authenticated surface on a public deployment for no gain -- the operator
// already has shell access, which is how the codes get delivered anyway.
//
// Usage:
//   node scripts/invite-codes.js mint [count] [--note "for alice"]
//   node scripts/invite-codes.js list [--all]
//   node scripts/invite-codes.js revoke <code>

const crypto = require('crypto');
const { Pool } = require('pg');

// 8 bytes of crypto randomness, base32-ish. Long enough that guessing is
// hopeless against the auth rate limiter (10 attempts per 15 min), short
// enough to read down a phone line. Ambiguous characters are excluded so a
// code can be dictated without spelling it out.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
function mintCode() {
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

async function main() {
  const cmd = process.argv[2] || 'list';
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
      for (const c of made) console.log(c);
      return;
    }

    if (cmd === 'revoke') {
      const code = process.argv[3];
      if (!code) throw new Error('revoke needs a code');
      // Burn it rather than delete it: the row is the record that the code
      // existed, and deleting would let the same string be minted again.
      const r = await pool.query(
        `UPDATE invite_codes SET used_at = COALESCE(used_at, now()), note = COALESCE(note,'') || ' [revoked]'
          WHERE code = $1 RETURNING code, used_at`, [code]);
      console.log(r.rows.length ? `revoked ${r.rows[0].code}` : 'no such code');
      return;
    }

    const all = process.argv.includes('--all');
    const { rows } = await pool.query(
      `SELECT code, note, created_at, used_at, used_by FROM invite_codes
        ${all ? '' : 'WHERE used_at IS NULL'}
        ORDER BY created_at DESC`);
    if (!rows.length) { console.log(all ? 'no invite codes' : 'no unused invite codes'); return; }
    for (const r of rows) {
      const state = r.used_at ? `used ${r.used_at.toISOString().slice(0, 10)}${r.used_by ? ` by user ${r.used_by}` : ''}` : 'unused';
      console.log(`${r.code}  ${state}${r.note ? `  (${r.note})` : ''}`);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}

module.exports = { mintCode, ALPHABET };
