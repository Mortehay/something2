// SOMET-638. Pure rules for the Seed / Export tab: badge copy, which decisions
// a preview row accepts, and when Apply is allowed. The backend re-validates
// every decision (applySeed.js); this only keeps the UI from offering or
// sending choices it would refuse.

export function statusBadge(group) {
  switch (group.status) {
    case 'in_sync': return { label: 'in sync', tone: 'ok' };
    case 'local_edits': {
      if (group.gitChanges > 0) return { label: `${group.localEdits} not exported · git is newer`, tone: 'warn' };
      const n = group.localEdits;
      return { label: `${n} edit${n === 1 ? '' : 's'} not exported`, tone: 'warn' };
    }
    case 'git_newer': return { label: 'git is newer', tone: 'info' };
    case 'never_exported': return { label: 'never exported', tone: 'info' };
    case 'tokens_missing': {
      const n = group.tokensMissing;
      return { label: `${n} token${n === 1 ? '' : 's'} missing`, tone: 'warn' };
    }
    case 'bad_file': return { label: 'bad export file', tone: 'bad' };
    default: return { label: String(group.status), tone: 'info' };
  }
}

// Export is refused server-side whenever git holds changes, even when the
// badge says local edits (both can be true at once).
export const exportBlocked = (group) => group.status === 'git_newer' || group.gitChanges > 0;

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
