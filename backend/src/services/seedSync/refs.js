// FK reference translation between a PC's local ids and the portable values a
// sync file holds. A ref column declared { table, by: 'uuid' } travels as the
// target row's sync_uuid; { table, by: 'key', keyCol } as the target's natural
// key (e.g. elements.name). Numeric ids never reach a file.

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

// Single-column FKs of `table`: Map(col -> [{ refCol, target }]).
async function fkReferencedColumns(db, table) {
  const { rows } = await db.query(
    `SELECT a.attname::text AS col, fa.attname::text AS ref_col, t.relname::text AS target
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = c.confkey[1]
       JOIN pg_class t ON t.oid = c.confrelid
      WHERE c.contype = 'f' AND c.conrelid = $1::text::regclass AND array_length(c.conkey, 1) = 1`,
    [quoteIdent(table)],
  );
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.col)) out.set(r.col, []);
    out.get(r.col).push({ refCol: r.ref_col, target: r.target });
  }
  return out;
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
    const fks = fkCols.get(col) || [];
    if (!fks.length) throw new Error(`seed-sync: ${spec.table}.${col} is declared a ref but is not a single-column FK`);
    if (fks.length > 1) throw new Error(`seed-sync: ${spec.table}.${col} has ${fks.length} single-column FKs; a ref needs exactly one`);
    const { refCol, target } = fks[0];
    if (target !== ref.table) {
      throw new Error(`seed-sync: ${spec.table}.${col} references ${target}, but the ref declares ${ref.table}`);
    }
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
// Null stays null. A value with no target, or a target whose uuid/key is
// null, is a bug (FKs guarantee one): throw rather than let a raw local id or a
// silently nulled ref reach a file.
function exportRow(row, spec, maps) {
  const out = { ...row };
  for (const col of Object.keys(spec.refs || {})) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    const map = maps.toRef[col];
    if (!map || !map.has(v)) {
      throw new Error(`seed-sync: ${spec.table}.${col} = ${JSON.stringify(v)} has no ${spec.refs[col].table} target`);
    }
    const refValue = map.get(v);
    if (refValue === null || refValue === undefined) {
      throw new Error(`seed-sync: ${spec.table}.${col} = ${JSON.stringify(v)}: its ${spec.refs[col].table} target has no ${spec.refs[col].by === 'uuid' ? 'sync_uuid' : spec.refs[col].keyCol}`);
    }
    out[col] = refValue;
  }
  return out;
}

// Canonicalization columns of an exported row: a ref column already holds its
// exported value (uuid or key text) after exportRow, so it is canonicalized
// as-is ('ref'), never as the FK column's numeric type. Export and diff both
// use this, so a baseline written by export equals the diff's local hash.
function exportColumns(columns, spec) {
  const refCols = new Set(Object.keys(spec.refs || {}));
  return columns.map((c) => (refCols.has(c.name) ? { name: c.name, dataType: 'ref' } : c));
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

module.exports = { buildRefMaps, exportRow, exportColumns, resolveRow };
