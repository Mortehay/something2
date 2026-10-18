// SOMET-638. Pure rules for the Seed / Export tab: badge copy, which decisions
// a preview row accepts, and when Apply is allowed. The backend re-validates
// every decision (applySeed.js); this only keeps the UI from offering or
// sending choices it would refuse.

// The git file was exported from a newer database schema: both export and
// seed are refused until this PC runs its migrations.
const SCHEMA_NEWER = 'run migrations first';

export function statusBadge(group) {
  switch (group.status) {
    case 'in_sync': return { label: 'in sync', tone: 'ok' };
    case 'local_edits': {
      if (group.gitChanges > 0) return { label: `${group.localEdits} edit${group.localEdits === 1 ? '' : 's'} not exported · git is newer`, tone: 'warn' };
      const n = group.localEdits;
      return { label: `${n} edit${n === 1 ? '' : 's'} not exported`, tone: 'warn' };
    }
    case 'git_newer': return { label: 'git is newer', tone: 'info' };
    case 'never_exported': return { label: 'never exported', tone: 'info' };
    case 'file_missing': return { label: 'export file missing', tone: 'bad' };
    case 'tokens_missing': {
      const n = group.tokensMissing;
      return { label: `${n} token${n === 1 ? '' : 's'} missing`, tone: 'warn' };
    }
    case 'bad_file': return { label: 'bad export file', tone: 'bad' };
    case 'schema_newer': return { label: SCHEMA_NEWER, tone: 'bad' };
    default: return { label: String(group.status), tone: 'info' };
  }
}

// Why Export is disabled (its tooltip), or null. The server refuses export
// whenever git holds changes, even when the badge says local edits (both can
// be true at once), and over a newer-schema or unreadable file.
export function exportBlockReason(group) {
  if (group.status === 'schema_newer') return SCHEMA_NEWER;
  if (group.status === 'bad_file') return 'fix or delete the export file first';
  if (group.status === 'git_newer' || group.gitChanges > 0) return 'seed (preview) first';
  return null;
}
export const exportBlocked = (group) => exportBlockReason(group) !== null;

// Why Seed is disabled (its tooltip), or null.
export function seedBlockReason(group) {
  if (group.status === 'schema_newer') return SCHEMA_NEWER;
  if (group.status === 'bad_file') return 'fix or delete the export file first';
  if (group.status === 'file_missing') return 'no export file';
  if (!group.inGit) return 'nothing in git yet';
  return null;
}

// Re-seed: Seed is available whenever an export file exists, whatever the
// status; the label says whether this PC has seeded the group before.
export const seedButtonLabel = (group) => (group.lastSeed ? 'Re-seed…' : 'Seed…');

const EXPORT_ALL_STATUSES = new Set(['local_edits', 'never_exported', 'file_missing']);

// "Export all": groups (registry order) worth exporting, plus the ones that
// would qualify but are blocked, with the reason the export button shows.
export function exportAllPlan(groups) {
  const toExport = [];
  const skipped = [];
  for (const g of groups) {
    if (!EXPORT_ALL_STATUSES.has(g.status)) continue;
    const reason = exportBlockReason(g);
    if (reason) skipped.push({ id: g.id, label: g.label, reason });
    else toExport.push(g);
  }
  return { toExport, skipped };
}

// "Seed all": every group with a usable export file, registry (= dependency)
// order.
export const seedAllGroups = (groups) => groups.filter((g) => g.inGit && !seedBlockReason(g));

export const HISTORY_PER_PAGE = 15;
export const historyPageCount = (total, perPage = HISTORY_PER_PAGE) => (
  Math.max(1, Math.ceil((Number(total) || 0) / perPage)));

// Toast text for Export all. results: [{ label, ok, rowCount?, error? }].
export function exportAllMessage(results, skipped) {
  const lines = [];
  const ok = results.filter((r) => r.ok);
  if (results.length) lines.push(`Exported ${ok.length} of ${results.length} groups`);
  else lines.push('Nothing to export');
  for (const r of results) if (!r.ok) lines.push(`Failed: ${r.label} — ${r.error}`);
  if (skipped.length) lines.push(`Skipped: ${skipped.map((s) => `${s.label} — ${s.reason}`).join('; ')}`);
  return lines.join('\n');
}

// Apply gate over several groups' previews (also the single-group case).
// sections: [{ rows, decisions }]. Apply needs every section decided and at
// least one row somewhere to write.
export function seedAllGate(sections) {
  let undecided = 0;
  let rows = 0;
  for (const s of sections) {
    undecided += applyGate(s.rows, s.decisions).undecided;
    rows += s.rows.length;
  }
  return { canApply: undecided === 0 && rows > 0, undecided, rows };
}

const DECISION_LABEL = { git: 'Take git', local: 'Keep local', delete: 'Delete local' };
// Button copy per row kind: git-only rows are created, not taken; and keeping
// "local" for a new row means skipping it, which the next export turns into
// removing it from git.
export function decisionLabel(row, d) {
  if (row.kind === 'new' && d === 'local') return 'Skip (drops it from git on next export)';
  if (d === 'git' && (row.kind === 'new' || row.kind === 'deleted_here')) return 'Create';
  return DECISION_LABEL[d] || d;
}

const KIND_LABELS = {
  changed: 'changed',
  not_exported: 'edited here, not exported',
  edited_here: 'edited here since last seed',
  adopt_identity: 'same row, adopt git identity',
  deleted_here: 'deleted here',
  new: 'new from git',
  deleted_in_git: 'deleted in git',
  only_here: 'only on this PC',
};
export const KINDS = Object.keys(KIND_LABELS);
export const kindLabel = (kind) => KIND_LABELS[kind] || kind;

const DELETE_KINDS = new Set(['deleted_in_git', 'only_here']);
const CREATE_KINDS = new Set(['new', 'deleted_here']);

export function allowedDecisions(row) {
  if (DELETE_KINDS.has(row.kind)) return row.blockedReason ? ['local'] : ['delete', 'local'];
  // Key clash: a git row whose natural key a local row already uses. The
  // server refuses 'git' (conflict), so only 'local' is offered.
  if (CREATE_KINDS.has(row.kind) && row.blockedReason) return ['local'];
  return ['git', 'local'];
}

// Identity of a fetched preview. A refetch with the same content must not
// reset the admin's decisions; a different diff must.
export function previewSignature(groupId, data) {
  // The server's signature covers kinds, defaults and blocked reasons.
  if (data && typeof data.signature === 'string') return `${groupId}|${data.signature}`;
  const rows = (data && data.rows) || [];
  const head = data && data.header ? data.header.exported_at : '';
  return `${groupId}|${head}|${rows.map((r) => `${r.syncUuid}:${r.kind}:${r.blockedReason ? 1 : 0}`).join(',')}`;
}

export function initialDecisions(rows) {
  const out = {};
  for (const r of rows) if (r.defaultDecision != null) out[r.syncUuid] = r.defaultDecision;
  return out;
}

// Returns a new map; rows whose kind does not accept `decision` (or whose
// delete is blocked) keep what they had.
export function bulkSet(decisions, uuids, decision, rows) {
  const byUuid = new Map(rows.map((r) => [r.syncUuid, r]));
  const out = { ...decisions };
  for (const u of uuids) {
    const r = byUuid.get(u);
    if (r && allowedDecisions(r).includes(decision)) out[u] = decision;
  }
  return out;
}

export function applyGate(rows, decisions) {
  let undecided = 0;
  const summary = { updated: 0, created: 0, deleted: 0, kept: 0, adopted: 0 };
  for (const r of rows) {
    const d = decisions[r.syncUuid];
    if (!d) { undecided += 1; continue; }
    if (d === 'delete') summary.deleted += 1;
    else if (d === 'local') summary.kept += 1;
    else if (r.kind === 'adopt_identity') summary.adopted += 1;
    else if (r.kind === 'new' || r.kind === 'deleted_here') summary.created += 1;
    else summary.updated += 1;
  }
  return { canApply: undecided === 0, undecided, summary };
}

// POST body of an apply: the full decision map plus the signature of the
// preview the admin decided on; the server refuses (stale_preview) if the
// diff moved since.
export const seedRequestBody = (decisions, preview) => ({ decisions, signature: preview.signature });
