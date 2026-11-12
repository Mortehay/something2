#!/usr/bin/env node
// Operator tool: give an account a VERIFIED email without the mail round trip.
//   node scripts/set-user-email.js <username> <email>
// Refuses (exit 1) when another account already holds that email verified.
// DATABASE_URL is taken from the environment first, then the repo .env (same
// dotenv loading as set-admin-password.js; dotenv never overrides a variable
// that is already set).
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { normalizeEmail, verifiedHolder } = require('../src/auth/emailAddress');

const ENV_PATH = fs.existsSync(path.resolve(__dirname, '../.env'))
  ? path.resolve(__dirname, '../.env')
  : path.resolve(__dirname, '../../.env');

async function main() {
  const [username, rawEmail] = process.argv.slice(2);
  if (!username || !rawEmail) throw new Error('usage: set-user-email.js <username> <email>');
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error('invalid email address');

  const env = fs.existsSync(ENV_PATH) ? dotenv.parse(fs.readFileSync(ENV_PATH)) : {};
  const databaseUrl = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (!rows.length) throw new Error(`no such user: ${username}`);
    const id = rows[0].id;
    if (await verifiedHolder(pool, email, id)) {
      throw new Error(`${email} is already verified on another account`);
    }
    try {
      await pool.query('UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2', [email, id]);
    } catch (err) {
      // Lost a race with another verification: the partial unique index decides.
      if (err.code === '23505') throw new Error(`${email} is already verified on another account`);
      throw err;
    }
    console.log(`ok: ${username} ${email} (verified)`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`set-user-email failed: ${err.message}`);
  process.exit(1);
});
