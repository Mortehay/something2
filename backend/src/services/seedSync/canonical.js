const crypto = require('node:crypto');

// Stable identity shared with the migration backfill:
// md5('s2sync:' || table || ':' || naturalKey)::uuid
function deterministicUuid(table, key) {
  const h = crypto.createHash('md5').update(`s2sync:${table}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

const NUMERIC_TYPES = new Set(['numeric', 'real', 'double precision', 'integer', 'bigint', 'smallint']);
const TIME_TYPES = new Set(['timestamp with time zone', 'timestamp without time zone', 'date']);

function canonicalValue(value, dataType) {
  if (value === null || value === undefined) return null;
  if (NUMERIC_TYPES.has(dataType)) return Number(value);
  if (TIME_TYPES.has(dataType)) {
    if (value instanceof Date) return value.toISOString();
    return value;
  }
  if (dataType === 'json' || dataType === 'jsonb') return sortDeep(value);
  return value;
}

function canonicalRow(row, columns) {
  const out = {};
  for (const c of columns) out[c.name] = canonicalValue(row[c.name], c.dataType);
  out.sync_uuid = row.sync_uuid;
  return sortDeep(out);
}

function stableStringify(value) {
  return JSON.stringify(sortDeep(value), null, 2);
}

function rowHash(canonical) {
  return crypto.createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

module.exports = { deterministicUuid, canonicalValue, canonicalRow, rowHash, stableStringify };
