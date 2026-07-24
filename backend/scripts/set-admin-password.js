#!/usr/bin/env node
// Apply ADMIN_USERNAME / ADMIN_PASSWORD from the repo-root .env to the users
// table. Creates the admin if absent, updates the password if present.
//
// Run via `make admin-password` (apply what's in .env) or
// `make admin-password-rotate` (generate a fresh password, write it to .env,
// then apply it).
//
// This deliberately parses .env with dotenv rather than letting make/sh expand
// it: dotenv is what src/index.js and node-pg-migrate use, so whatever this
// script writes to the DB is exactly what the app will read back. Passwords
// routinely contain characters ('=', '&', '#', '*') that shell sourcing and
// `docker compose exec -e` mangle differently than dotenv does.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const ENV_PATH = path.resolve(__dirname, '../../.env');
const BCRYPT_ROUNDS = 12; // Must match migrations/1714440025000_users.js.

// Excludes look-alikes (O/0/I/l/1) and every character that changes meaning
// inside single quotes or under dotenv-expand: ' " ` \ $ and #.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@%^&*-_=+';
const PASSWORD_LENGTH = 24;

function generatePassword() {
  // Rejection-sample so each character is uniform rather than modulo-biased.
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < PASSWORD_LENGTH) {
    for (const byte of crypto.randomBytes(PASSWORD_LENGTH)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === PASSWORD_LENGTH) break;
    }
  }
  return out;
}

// Rewrite ADMIN_PASSWORD in place, preserving every other line and any trailing
// comment-free structure. Appends the key if it isn't there yet.
function writePasswordToEnv(password) {
  const quoted = `'${password}'`; // Safe: ALPHABET contains no single quote.
  const original = fs.readFileSync(ENV_PATH, 'utf8');
  const line = /^ADMIN_PASSWORD=.*$/m;
  const updated = line.test(original)
    ? original.replace(line, `ADMIN_PASSWORD=${quoted}`)
    : `${original.endsWith('\n') ? original : `${original}\n`}ADMIN_PASSWORD=${quoted}\n`;
  fs.writeFileSync(ENV_PATH, updated);
}

async function main() {
  const rotate = process.argv.includes('--rotate');

  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`no .env at ${ENV_PATH} — copy the example and set ADMIN_USERNAME/ADMIN_PASSWORD`);
  }

  if (rotate) writePasswordToEnv(generatePassword());

  // Parsed after the rotate write, so both paths read the file as the app will.
  const env = dotenv.parse(fs.readFileSync(ENV_PATH));
  const username = env.ADMIN_USERNAME;
  const password = env.ADMIN_PASSWORD;
  const databaseUrl = process.env.DATABASE_URL || env.DATABASE_URL;

  if (!username || !password) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must both be set in .env');
  }
  if (!databaseUrl) throw new Error('DATABASE_URL is not set in .env');

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

    // Bumping token_version invalidates every JWT minted under the old
    // password — src/auth/routes.js embeds it and the middleware rejects
    // tokens whose version is behind the row.
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, role)
            VALUES ($1, $2, 'admin')
       ON CONFLICT (username) DO UPDATE
              SET password_hash = EXCLUDED.password_hash,
                  role = 'admin',
                  token_version = users.token_version + 1
        RETURNING id, username, role, token_version,
                  (xmax = 0) AS created`,
      [username, passwordHash],
    );
    const row = rows[0];

    // Read the row back and confirm the stored hash actually verifies, rather
    // than trusting that the UPDATE did what we meant.
    const check = await pool.query(
      'SELECT password_hash FROM users WHERE username = $1',
      [username],
    );
    if (!bcrypt.compareSync(password, check.rows[0].password_hash)) {
      throw new Error('stored hash does not verify against the .env password');
    }

    console.log(`${row.created ? 'Created' : 'Updated'} admin "${row.username}" (id ${row.id}, role ${row.role}).`);
    console.log(`token_version is now ${row.token_version} — existing sessions are logged out.`);
    if (rotate) {
      console.log(`\n  username: ${username}`);
      console.log(`  password: ${password}\n`);
      console.log('Written to .env (gitignored). Save it somewhere safe.');
    } else {
      console.log('Password taken from .env; it is unchanged there.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`set-admin-password failed: ${err.message}`);
  process.exit(1);
});
