'use strict';
// Shared by the board scope tests (board_seed_scope_db, board_maps_scope_db): which tables hold player
// data, and a fingerprint of only ONE fixture's rows in them (parallel files write player tables too).

// users, characters and every table with a user_id / character_id column.
async function playerTables(pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('user_id', 'character_id')
        AND table_name IN (SELECT table_name FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_type = 'BASE TABLE')`);
  return [...new Set(['users', 'characters', ...rows.map((r) => r.table_name)])].sort();
}

const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;
async function fingerprint(pool, tables) {
  const out = {};
  for (const tb of tables) {
    const q = quoteIdent(tb);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${q} x`);
    out[tb] = rows[0];
  }
  return out;
}

// Count and md5 of only the fixture's own rows (its user and character) in each
// table. Whole tables are not compared: parallel files write player tables too.
// A table with neither a user_id nor a character_id column is out of scope.
async function scopedFingerprint(pool, tables, userId, charId) {
  const out = {};
  for (const tb of tables) {
    const { rows: cols } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name IN ('user_id', 'character_id')`, [tb]);
    const names = cols.map((c) => c.column_name);
    const conds = [];
    if (names.includes('user_id')) conds.push(`x.user_id = ${Number(userId)}`);
    if (names.includes('character_id')) conds.push(`x.character_id = ${Number(charId)}`);
    if (tb === 'users') conds.push(`x.id = ${Number(userId)}`);
    if (tb === 'characters') conds.push(`x.id = ${Number(charId)}`);
    if (conds.length === 0) continue;
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h
         FROM ${quoteIdent(tb)} x WHERE ${conds.join(' OR ')}`);
    out[tb] = rows[0];
  }
  return out;
}

module.exports = { playerTables, scopedFingerprint, fingerprint, quoteIdent };
