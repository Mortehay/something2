// FK reference translation between a PC's local ids and the portable values a
// sync file holds. A ref column declared { table, by: 'uuid' } travels as the
// target row's sync_uuid; { table, by: 'key', keyCol } as the target's natural
// key (e.g. elements.name). Numeric ids never reach a file.

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

// The referenced column of each single-column FK of `table`: { col: refCol }.
async function fkReferencedColumns(db, table) {
  const { rows } = await db.query(
    `SELECT a.attname::text AS col, fa.attname::text AS ref_col
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND c.conrelid = $1::text::regclass AND array_length(c.conkey, 1) = 1`,
    [quoteIdent(table)],
  );
  return new Map(rows.map((r) => [r.col, r.ref_col]));
}

// Per ref column: toRef (local FK value -> ref value) and fromRef (ref value ->
// local FK value). Loads only the target's referenced column and its uuid/key.
async function buildRefMaps(db, spec) {
  const refs = Object.entries(spec.refs || {});
  const toRef = {};
  const fromRef = {};
  if (!refs.length) return { toRef, fromRef };
  const fkCols = await fkReferencedColumns(db, spec.table);
  for (const [col, ref] of refs) {
    const refCol = fkCols.get(col);
    if (!refCol) throw new Error(`seed-sync: ${spec.table}.${col} is declared a ref but is not a single-column FK`);
    const valueCol = ref.by === 'uuid' ? 'sync_uuid' : ref.keyCol;
    if (!valueCol) throw new Error(`seed-sync: ${spec.table}.${col} ref by key needs keyCol`);
    const { rows } = await db.query(
      `SELECT ${quoteIdent(refCol)} AS local, ${quoteIdent(valueCol)} AS ref FROM ${quoteIdent(ref.table)}`);
    toRef[col] = new Map(rows.map((r) => [r.local, r.ref]));
    fromRef[col] = new Map(rows.map((r) => [r.ref, r.local]));
  }
  return { toRef, fromRef };
}

// Copy of `row` with each ref column's local value replaced by its ref value.
// Null stays null. A value with no target is a bug (FKs guarantee one): throw
// rather than let a raw local id reach a file.
function exportRow(row, spec, maps) {
  const out = { ...row };
  for (const col of Object.keys(spec.refs || {})) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    const map = maps.toRef[col];
    if (!map || !map.has(v)) {
      throw new Error(`seed-sync: ${spec.table}.${col} = ${JSON.stringify(v)} has no ${spec.refs[col].table} target`);
    }
    out[col] = map.get(v);
  }
  return out;
}

const pendingFor = (pending, table) => {
  if (!pending) return null;
  return pending instanceof Map ? pending.get(table) : pending[table];
};

// Inverse of exportRow for a git row. `pending` ({ [targetTable]: Map(refValue
// -> localId) }, or a Map of the same) holds targets created earlier in the
// same seed. Unresolvable values are listed in `missing` (value left as is).
async function resolveRow(gitRow, spec, maps, pending) {
  const row = { ...gitRow };
  const missing = [];
  for (const [col, ref] of Object.entries(spec.refs || {})) {
    const v = gitRow[col];
    if (v === null || v === undefined) continue;
    const local = maps.fromRef[col];
    const extra = pendingFor(pending, ref.table);
    if (local && local.has(v)) row[col] = local.get(v);
    else if (extra && extra.has(v)) row[col] = extra.get(v);
    else missing.push({ column: col, target: ref.table, value: v });
  }
  return { row, missing };
}

module.exports = { buildRefMaps, exportRow, resolveRow };
