import { describe, it, expect } from 'vitest';
import {
  statusBadge, initialDecisions, bulkSet, applyGate, allowedDecisions, kindLabel, exportBlocked, previewSignature,
  exportBlockReason, seedBlockReason, decisionLabel, seedRequestBody,
  seedButtonLabel, exportAllPlan, seedAllGroups, historyPageCount, exportAllMessage, seedAllGate, pluralize,
  tableLabel, warningText, warningIsError, refusalText, groupRowsByTable, isRename, renameNote,
} from '../../games/something2/seedExportModel.js';

const row = (syncUuid, kind, defaultDecision, blockedReason = null) => (
  { syncUuid, key: syncUuid, kind, defaultDecision, fields: [], blockedReason });

describe('statusBadge', () => {
  it('maps each status to copy and tone', () => {
    expect(statusBadge({ status: 'in_sync' })).toEqual({ label: 'in sync', tone: 'ok' });
    expect(statusBadge({ status: 'local_edits', localEdits: 14, gitChanges: 0 })).toEqual({ label: '14 edits not exported', tone: 'warn' });
    expect(statusBadge({ status: 'local_edits', localEdits: 1, gitChanges: 0 }).label).toBe('1 edit not exported');
    expect(statusBadge({ status: 'local_edits', localEdits: 3, gitChanges: 2 })).toEqual({ label: '3 edits not exported · git is newer', tone: 'warn' });
    expect(statusBadge({ status: 'git_newer' })).toEqual({ label: 'git is newer', tone: 'info' });
    expect(statusBadge({ status: 'never_exported' })).toEqual({ label: 'never exported', tone: 'info' });
    expect(statusBadge({ status: 'tokens_missing', tokensMissing: 2 })).toEqual({ label: '2 tokens missing', tone: 'warn' });
    expect(statusBadge({ status: 'tokens_missing', tokensMissing: 1 }).label).toBe('1 token missing');
    expect(statusBadge({ status: 'local_edits', localEdits: 1, gitChanges: 2 }).label).toBe('1 edit not exported · git is newer');
    expect(statusBadge({ status: 'file_missing' })).toEqual({ label: 'export file missing', tone: 'bad' });
    expect(statusBadge({ status: 'bad_file' })).toEqual({ label: 'bad export file', tone: 'bad' });
  });
});

describe('exportBlocked', () => {
  it('blocks on git_newer or any git changes, even under local_edits', () => {
    expect(exportBlocked({ status: 'git_newer', gitChanges: 1 })).toBe(true);
    expect(exportBlocked({ status: 'local_edits', gitChanges: 2 })).toBe(true);
    expect(exportBlocked({ status: 'local_edits', gitChanges: 0 })).toBe(false);
    expect(exportBlocked({ status: 'in_sync', gitChanges: 0 })).toBe(false);
  });
});

describe('previewSignature', () => {
  const data = (rows, at = 't1') => ({ header: { exported_at: at }, rows });
  const a = [row('a', 'changed', 'git'), row('b', 'new', 'git')];
  it('is stable across refetches of the same content', () => {
    expect(previewSignature('g', data(a))).toBe(previewSignature('g', data(a.map((r) => ({ ...r })))));
  });
  it('changes when rows, kinds, header or group change', () => {
    const base = previewSignature('g', data(a));
    expect(previewSignature('g', data([a[0]]))).not.toBe(base);
    expect(previewSignature('g', data([a[0], row('b', 'edited_here', null)]))).not.toBe(base);
    expect(previewSignature('g', data(a, 't2'))).not.toBe(base);
    expect(previewSignature('h', data(a))).not.toBe(base);
  });
});

describe('decisions', () => {
  const rows = [
    row('a', 'changed', 'git'),
    row('b', 'edited_here', null),
    row('c', 'only_here', 'local'),
    row('d', 'deleted_in_git', 'delete', 'referenced by a map'),
    row('e', 'new', 'git'),
  ];

  it('red rows start undecided and block apply', () => {
    const d = initialDecisions(rows);
    expect(d).toEqual({ a: 'git', c: 'local', d: 'delete', e: 'git' });
    expect('b' in d).toBe(false);
    const gate = applyGate(rows, d);
    expect(gate.canApply).toBe(false);
    expect(gate.undecided).toBe(1);
  });

  it('bulk take-git resolves red rows', () => {
    const d = bulkSet(initialDecisions(rows), ['b'], 'git', rows);
    expect(d.b).toBe('git');
    expect(applyGate(rows, d).canApply).toBe(true);
    expect(applyGate(rows, d).undecided).toBe(0);
  });

  it('bulk delete skips blocked rows', () => {
    const d = bulkSet({ d: 'local', c: 'local' }, ['d', 'c'], 'delete', rows);
    expect(d.d).toBe('local');
    expect(d.c).toBe('delete');
  });

  it('bulkSet skips decisions not allowed for the row kind', () => {
    const d = bulkSet({}, ['a', 'c'], 'git', rows);
    expect(d.a).toBe('git');
    expect('c' in d).toBe(false); // only_here: delete|local
  });

  it('bulkSet does not mutate its input', () => {
    const input = { a: 'git' };
    bulkSet(input, ['a'], 'local', rows);
    expect(input).toEqual({ a: 'git' });
  });

  it('summary counts match decisions', () => {
    const rs = [
      row('1', 'changed', 'git'), row('2', 'edited_here', 'git'), row('3', 'new', 'git'),
      row('4', 'deleted_here', 'git'), row('5', 'only_here', 'delete'), row('6', 'changed', 'local'),
      row('7', 'adopt_identity', 'git'),
    ];
    const g = applyGate(rs, initialDecisions(rs));
    expect(g.summary).toEqual({ updated: 2, created: 2, deleted: 1, kept: 1, adopted: 1 });
    expect(g.canApply).toBe(true);
  });
});

describe('allowedDecisions / kindLabel', () => {
  it('follows the per-kind table', () => {
    for (const k of ['changed', 'not_exported', 'edited_here', 'adopt_identity', 'new', 'deleted_here']) {
      expect(allowedDecisions(row('x', k, null))).toEqual(['git', 'local']);
    }
    expect(allowedDecisions(row('x', 'deleted_in_git', null))).toEqual(['delete', 'local']);
    expect(allowedDecisions(row('x', 'only_here', null))).toEqual(['delete', 'local']);
  });
  it('key-clash rows (blocked new/deleted_here) only allow local', () => {
    expect(allowedDecisions(row('x', 'new', null, 'key already used by a local row'))).toEqual(['local']);
    expect(allowedDecisions(row('x', 'deleted_here', null, 'clash'))).toEqual(['local']);
    const rs = [row('x', 'new', null, 'clash')];
    expect(bulkSet({}, ['x'], 'git', rs)).toEqual({});
  });
  it("prefers the server's per-row allowedDecisions (slice rows are keep-only)", () => {
    const slice = { ...row('s', 'only_here', 'local'), allowedDecisions: ['local'] };
    expect(allowedDecisions(slice)).toEqual(['local']);
    expect(bulkSet({}, ['s'], 'delete', [slice])).toEqual({});
    const orphan = { ...row('o', 'new', null, 'owner_missing'), allowedDecisions: ['local'] };
    expect(allowedDecisions(orphan)).toEqual(['local']);
    expect(bulkSet({}, ['o'], 'git', [orphan])).toEqual({});
    expect(bulkSet({}, ['o'], 'local', [orphan])).toEqual({ o: 'local' });
  });
  it('drops delete on blocked rows', () => {
    expect(allowedDecisions(row('x', 'only_here', null, 'in use'))).toEqual(['local']);
  });
  it('labels every kind', () => {
    expect(kindLabel('changed')).toBe('changed');
    expect(kindLabel('not_exported')).toBe('edited here, not exported');
    expect(kindLabel('edited_here')).toBe('edited here since last seed');
    expect(kindLabel('adopt_identity')).toBe('same row, adopt git identity');
    expect(kindLabel('deleted_here')).toBe('deleted here');
    expect(kindLabel('new')).toBe('new from git');
    expect(kindLabel('deleted_in_git')).toBe('deleted in git');
    expect(kindLabel('only_here')).toBe('only on this PC');
  });
});

describe('schema_newer', () => {
  const g = { status: 'schema_newer', gitChanges: 0, localEdits: 0, inGit: { schema_version: 'v9' } };
  it('badge says run migrations first, tone bad', () => {
    expect(statusBadge(g)).toEqual({ label: 'run migrations first', tone: 'bad' });
  });
  it('disables Export and Seed with that tooltip', () => {
    expect(exportBlockReason(g)).toBe('run migrations first');
    expect(exportBlocked(g)).toBe(true);
    expect(seedBlockReason(g)).toBe('run migrations first');
  });
  it('other block reasons', () => {
    expect(exportBlockReason({ status: 'git_newer', gitChanges: 1 })).toBe('seed (preview) first');
    expect(exportBlockReason({ status: 'bad_file', gitChanges: 0 })).toBe('fix or delete the export file first');
    expect(exportBlockReason({ status: 'local_edits', gitChanges: 0 })).toBe(null);
    expect(seedBlockReason({ status: 'never_exported', inGit: null })).toBe('nothing in git yet');
    expect(seedBlockReason({ status: 'bad_file', inGit: null })).toBe('fix or delete the export file first');
    expect(seedBlockReason({ status: 'git_newer', inGit: {} })).toBe(null);
  });
});

describe('decisionLabel', () => {
  it('says what keeping local means for a new row', () => {
    expect(decisionLabel(row('x', 'new', 'git'), 'local')).toBe('Skip (drops it from git on next export)');
    expect(decisionLabel(row('x', 'new', 'git'), 'git')).toBe('Create');
  });
  it('other kinds are unchanged', () => {
    expect(decisionLabel(row('x', 'deleted_here', 'local'), 'local')).toBe('Keep local');
    expect(decisionLabel(row('x', 'deleted_here', 'local'), 'git')).toBe('Create');
    expect(decisionLabel(row('x', 'changed', 'git'), 'git')).toBe('Take git');
    expect(decisionLabel(row('x', 'changed', 'git'), 'local')).toBe('Keep local');
    expect(decisionLabel(row('x', 'only_here', 'local'), 'delete')).toBe('Delete local');
  });
});

describe('stale-preview signature', () => {
  it('the apply body carries the preview signature', () => {
    expect(seedRequestBody({ a: 'git' }, { signature: 'abc', rows: [] })).toEqual({ decisions: { a: 'git' }, signature: 'abc' });
  });
  it('a new server signature remounts the preview (decisions reset after stale_preview)', () => {
    const rows = [row('a', 'changed', 'git')];
    const one = previewSignature('g', { header: { exported_at: 't' }, rows, signature: 's1' });
    expect(previewSignature('g', { header: { exported_at: 't' }, rows, signature: 's1' })).toBe(one);
    expect(previewSignature('g', { header: { exported_at: 't' }, rows, signature: 's2' })).not.toBe(one);
  });
});

const grp = (id, status, extra = {}) => ({ id, label: id.toUpperCase(), status, gitChanges: 0, localEdits: 0, inGit: null, ...extra });

describe('re-seed rules', () => {
  it('labels Re-seed once this PC has seeded', () => {
    expect(seedButtonLabel({ lastSeed: { id: 1 } })).toBe('Re-seed…');
    expect(seedButtonLabel({ lastSeed: null })).toBe('Seed…');
  });
  it('enables seed for any status with an export file, except the refused ones', () => {
    for (const status of ['in_sync', 'local_edits', 'git_newer', 'tokens_missing']) {
      expect(seedBlockReason(grp('a', status, { inGit: {} }))).toBe(null);
    }
    expect(seedBlockReason(grp('a', 'file_missing'))).toBe('no export file');
    expect(seedBlockReason(grp('a', 'never_exported'))).toBe('nothing in git yet');
  });
  it('file_missing allows export', () => {
    expect(exportBlockReason(grp('a', 'file_missing'))).toBe(null);
  });
});

describe('exportAllPlan', () => {
  it('exports local_edits / never_exported / file_missing in order and lists blocked ones', () => {
    const groups = [
      grp('a', 'never_exported'), grp('b', 'in_sync'), grp('q', 'local_edits', { gitChanges: 2 }),
      grp('c', 'file_missing'), grp('d', 'git_newer', { gitChanges: 1 }), grp('e', 'local_edits', { localEdits: 1 }),
      grp('f', 'bad_file'), grp('g', 'schema_newer'),
    ];
    const plan = exportAllPlan(groups);
    expect(plan.toExport.map((g) => g.id)).toEqual(['a', 'c', 'e']);
    expect(plan.skipped).toEqual([
      { id: 'q', label: 'Q', reason: 'seed (preview) first' },
      { id: 'd', label: 'D', reason: 'seed (preview) first' },
      { id: 'f', label: 'F', reason: 'fix or delete the export file first' },
      { id: 'g', label: 'G', reason: 'run migrations first' },
    ]);
  });
  it('message reports successes, failures and skips', () => {
    const msg = exportAllMessage(
      [{ label: 'A', ok: true }, { label: 'B', ok: false, error: 'boom' }],
      [{ label: 'Quests', reason: 'seed (preview) first' }]);
    expect(msg).toContain('Exported 1 of 2 groups');
    expect(msg).toContain('Failed: B — boom');
    expect(msg).toContain('Skipped: Quests — seed (preview) first');
  });
});

describe('seedAllGroups', () => {
  it('keeps registry order and only groups with a usable file', () => {
    const groups = [
      grp('a', 'in_sync', { inGit: {} }), grp('b', 'never_exported'), grp('c', 'bad_file'),
      grp('d', 'schema_newer', { inGit: {} }), grp('e', 'file_missing'), grp('f', 'git_newer', { inGit: {} }),
    ];
    expect(seedAllGroups(groups).map((g) => g.id)).toEqual(['a', 'f']);
  });
});

describe('seedAllGate', () => {
  it('blocks on undecided rows in any section and on an all-empty preview', () => {
    const red = row('r', 'only_here', null);
    const ok = row('o', 'changed', 'git');
    expect(seedAllGate([{ rows: [ok], decisions: { o: 'git' } }, { rows: [red], decisions: {} }]))
      .toEqual({ canApply: false, undecided: 1, rows: 2 });
    expect(seedAllGate([{ rows: [ok], decisions: { o: 'git' } }, { rows: [red], decisions: { r: 'local' } }]).canApply).toBe(true);
    expect(seedAllGate([{ rows: [], decisions: {} }]).canApply).toBe(false);
  });
});

describe('historyPageCount', () => {
  it('is at least one page and rounds up', () => {
    expect(historyPageCount(0, 15)).toBe(1);
    expect(historyPageCount(15, 15)).toBe(1);
    expect(historyPageCount(16, 15)).toBe(2);
    expect(historyPageCount(undefined, 15)).toBe(1);
  });
});

describe('pluralize', () => {
  it('uses singular only for 1', () => {
    expect(pluralize(1, 'red row')).toBe('1 red row');
    expect(pluralize(0, 'group')).toBe('0 groups');
    expect(pluralize(3, 'group')).toBe('3 groups');
    expect(pluralize(2, 'entry', 'entries')).toBe('2 entries');
  });
});

describe('multi-table helpers (SOMET-639)', () => {
  it('tableLabel maps known tables and falls back to the raw name', () => {
    expect(tableLabel('creature_drops')).toBe('Drops');
    expect(tableLabel('class_loadouts')).toBe('Class loadouts');
    expect(tableLabel('passive_edges')).toBe('Edges');
    expect(tableLabel('ai_providers')).toBe('AI providers');
    expect(tableLabel('mystery_table')).toBe('mystery_table');
  });
  it('warningText covers all four codes', () => {
    expect(warningText({ code: 'schema_older' })).toContain('older database schema');
    expect(warningText({ code: 'dangling_name', key: 'Goblin', column: 'aura', name: 'Frost Ring' }))
      .toBe("Goblin: aura 'Frost Ring' does not exist here");
    expect(warningText({ code: 'missing_ref', key: 'Goblin → Sword', column: 'item', target: 'item_types' }))
      .toBe('Goblin → Sword: item points to a missing Items row — it will be refused');
    expect(warningText({ code: 'dangling_name' })).toBe("?: ? '?' does not exist here");
    expect(warningText({ code: 'missing_ref' })).not.toContain('undefined');
    expect(warningText({ code: 'invalid_value', key: 'xp_rate', error: 'must be > 0' }))
      .toBe('Setting xp_rate: must be > 0 — it will be refused');
    expect(warningText({ code: 'zzz' })).toBe('zzz');
  });
  it('only refusal-predicting warnings are errors', () => {
    expect(warningIsError({ code: 'missing_ref' })).toBe(true);
    expect(warningIsError({ code: 'invalid_value' })).toBe(true);
    expect(warningIsError({ code: 'dangling_name' })).toBe(false);
    expect(warningIsError({ code: 'schema_older' })).toBe(false);
  });
  it('refusalText builds readable toasts', () => {
    const refs = [{ table: 'creature_drops', key: 'Goblin → Sword', column: 'item', target: 'item_types', value: 'Sword' }, { table: 'x', key: 'y', target: 'z' }];
    expect(refusalText('Creatures', { code: 'missing_ref', details: { refs } }))
      .toBe('Can\'t seed Creatures: 2 rows point to missing rows — e.g. Drops "Goblin → Sword": item → Items (Sword)');
    expect(refusalText('C', { code: 'missing_ref', details: { refs: [{ table: 'quests', key: 'k', column: 'c', target: 'item_types', syncUuid: 'abcdef1234567' }] } }))
      .toBe('Can\'t seed C: 1 row points to missing rows — e.g. Quests "k": c → Items (abcdef12)');
    expect(refusalText('Creatures', { code: 'missing_ref', details: { refs: [refs[0]] } })).toContain('1 row points');
    expect(refusalText('Progression', { code: 'invalid_value', details: { key: 'xp_rate', error: 'must be > 0' } }))
      .toBe("Can't seed Progression: setting xp_rate is invalid (must be > 0)");
    expect(refusalText('X', { code: 'stale_preview', details: {} })).toBeNull();
    expect(refusalText('X', { code: 'missing_ref' })).toBeNull();
    // A null / non-object first ref never throws: the count alone.
    expect(refusalText('C', { code: 'missing_ref', details: { refs: [null] } }))
      .toBe("Can't seed C: 1 row points to missing rows");
    expect(refusalText('C', { code: 'missing_ref', details: { refs: [undefined, { table: 'x' }] } }))
      .toBe("Can't seed C: 2 rows point to missing rows");
  });
  it('groupRowsByTable follows the diff table order and drops empty tables', () => {
    const tables = [{ table: 'entity_types' }, { table: 'creature_drops' }, { table: 'creature_behaviors' }];
    const rows = [
      { syncUuid: '1', table: 'creature_behaviors' }, { syncUuid: '2', table: 'entity_types' },
      { syncUuid: '3', table: 'entity_types' }, { syncUuid: '4', table: 'other' },
    ];
    const g = groupRowsByTable(rows, tables);
    expect(g.map((s) => s.table)).toEqual(['entity_types', 'creature_behaviors', 'other']);
    expect(g.map((s) => s.label)).toEqual(['Entities', 'Behaviors', 'other']);
    expect(g[0].rows.map((r) => r.syncUuid)).toEqual(['2', '3']);
    expect(groupRowsByTable(rows, undefined)[0].table).toBe('creature_behaviors');
  });
});

describe('isRename', () => {
  it('flags name changes on entities and auras only', () => {
    expect(isRename({ table: 'entity_types', fields: [{ name: 'name' }] })).toBe(true);
    expect(isRename({ table: 'aura_effects', fields: [{ name: 'name' }] })).toBe(true);
    expect(isRename({ table: 'entity_types', fields: [{ name: 'hp' }] })).toBe(false);
    expect(isRename({ table: 'quests', fields: [{ name: 'name' }] })).toBe(false);
  });
  it('renameNote names where each table\'s references live', () => {
    expect(renameNote({ table: 'entity_types', fields: [{ name: 'name' }] }))
      .toBe('rename — references in worlds/biomes will follow');
    expect(renameNote({ table: 'aura_effects', fields: [{ name: 'name' }] }))
      .toBe("rename — entities' aura lists will follow");
    expect(renameNote({ table: 'entity_types', fields: [{ name: 'hp' }] })).toBeNull();
    expect(renameNote(null)).toBeNull();
  });
});

// SOMET-640 (plan 3): binary groups (Art, Audio) run as background jobs.
import {
  jobProgressText, jobErrorRowsText, jobRunning, jobSettled, binaryGroups, separateNote, assetText, blockedText,
  PAGE_ROWS, nextShown, limitSections, BUSY_TEXT,
} from '../../games/something2/seedExportModel.js';

describe('jobProgressText', () => {
  const job = (extra) => ({ id: 1, groupId: 'art', action: 'export', phase: null, done: 0, total: 0, status: 'running', error: null, ...extra });
  it('names the phase, the group and the counts', () => {
    expect(jobProgressText(job({ phase: 'download', done: 120, total: 1100 }), 'Art')).toBe('Downloading art 120 / 1100');
    expect(jobProgressText(job({ groupId: 'audio', action: 'seed', phase: 'upload', done: 3, total: 40 }), 'Audio')).toBe('Uploading audio 3 / 40');
  });
  it('falls back to the group id when no label is given', () => {
    expect(jobProgressText(job({ phase: 'upload', done: 1, total: 2 }))).toBe('Uploading art 1 / 2');
  });
  it('says Writing database… while there is nothing to count', () => {
    expect(jobProgressText(job({ phase: null, total: 0 }), 'Art')).toBe('Writing database…');
    expect(jobProgressText(job({ phase: 'upload', total: 0 }), 'Art')).toBe('Writing database…');
  });
  it('final states', () => {
    expect(jobProgressText(job({ status: 'cancelled' }), 'Art')).toBe('Cancelled');
    expect(jobProgressText(job({ status: 'failed', error: 'regenerate or clear these images first' }), 'Art'))
      .toBe('Failed: regenerate or clear these images first');
    expect(jobProgressText(job({ status: 'ok' }), 'Art')).toBe('Exported');
    expect(jobProgressText(job({ status: 'ok', action: 'seed' }), 'Art')).toBe('Seeded');
    expect(jobProgressText(job({ cancelRequested: true, phase: 'download', done: 1, total: 9 }), 'Art')).toBe('Cancelling…');
    expect(jobProgressText(null)).toBe('');
  });
  it('error rows: up to 5 keys then +N more', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ table: 'entity_types', key: `k${i}` }));
    expect(jobErrorRowsText({ status: 'failed', errorDetails: { rows } })).toBe('k0, k1, k2, k3, k4 +2 more');
    expect(jobErrorRowsText({ status: 'failed', errorDetails: { rows: rows.slice(0, 2) } })).toBe('k0, k1');
    expect(jobErrorRowsText({ status: 'failed', errorDetails: null })).toBe(null);
    expect(jobErrorRowsText({ status: 'running', errorDetails: { rows } })).toBe(null);
  });
  it('jobRunning', () => {
    expect(jobRunning(job())).toBe(true);
    expect(jobRunning(job({ status: 'ok' }))).toBe(false);
    expect(jobRunning(null)).toBe(false);
  });
});

describe('jobSettled (invalidate once per finished job)', () => {
  it('fires on running -> final only, once', () => {
    let s = jobSettled(null, { id: 1, status: 'running' });
    expect(s.fire).toBe(false);
    s = jobSettled(s.seen, { id: 1, status: 'running' });
    expect(s.fire).toBe(false);
    s = jobSettled(s.seen, { id: 1, status: 'ok' });
    expect(s.fire).toBe(true);
    s = jobSettled(s.seen, { id: 1, status: 'ok' });
    expect(s.fire).toBe(false);
  });
  it('a job already finished at page load does not fire; a new finished job does', () => {
    let s = jobSettled(null, { id: 3, status: 'failed' });
    expect(s.fire).toBe(false);
    s = jobSettled(s.seen, { id: 4, status: 'cancelled' });
    expect(s.fire).toBe(true);
    expect(jobSettled(s.seen, null).fire).toBe(false);
  });
});

describe('binary groups stay out of the batches', () => {
  it('seedAllGroups and exportAllPlan skip binary groups; binaryGroups lists them', () => {
    const groups = [
      grp('a', 'git_newer', { inGit: {} }),
      grp('art', 'git_newer', { inGit: {}, binary: true }),
      grp('b', 'never_exported'),
      grp('audio', 'local_edits', { localEdits: 2, inGit: {}, binary: true }),
    ];
    expect(seedAllGroups(groups).map((g) => g.id)).toEqual(['a']);
    const plan = exportAllPlan(groups);
    expect(plan.toExport.map((g) => g.id)).toEqual(['b']);
    expect(plan.skipped.map((g) => g.id)).toEqual(['a']);
    expect(binaryGroups(groups).map((g) => g.id)).toEqual(['art', 'audio']);
  });

  // SOMET-641: Maps runs as a job (server flag `job`) and is listed with them.
  it('a job group (Maps) is out of the batches too, and the note lists every label', () => {
    const groups = [
      grp('a', 'git_newer', { inGit: {} }),
      grp('maps', 'git_newer', { inGit: {}, job: true, label: 'Maps' }),
      grp('art', 'local_edits', { localEdits: 1, inGit: {}, binary: true, job: true, label: 'Art' }),
      grp('audio', 'local_edits', { localEdits: 1, inGit: {}, binary: true, job: true, label: 'Audio' }),
    ];
    expect(seedAllGroups(groups).map((g) => g.id)).toEqual(['a']);
    expect(exportAllPlan(groups).skipped.map((g) => g.id)).toEqual(['a']);
    expect(binaryGroups(groups).map((g) => g.id)).toEqual(['maps', 'art', 'audio']);
    expect(separateNote(binaryGroups(groups))).toBe('Maps, Art and Audio run separately');
    expect(separateNote([{ label: 'Art' }, { label: 'Audio' }])).toBe('Art and Audio run separately');
    expect(separateNote([{ label: 'Maps' }])).toBe('Maps runs separately');
  });

  // SOMET-641: a PC whose specs match git but whose baseline is not recorded.
  it('baseline_pending: a warn badge with the hint, Seed enabled, and the baseline row applies', () => {
    const g = grp('maps', 'baseline_pending', { inGit: { exported_at: 'x' }, job: true,
      hint: "Seed Maps once to record this PC's baseline — no map data changes" });
    expect(statusBadge(g)).toEqual({ label: "Seed Maps once to record this PC's baseline — no map data changes", tone: 'warn' });
    expect(statusBadge({ ...g, hint: undefined }).label).toMatch(/record this PC's baseline/);
    expect(statusBadge(g).label).not.toBe('in sync');
    expect(seedBlockReason(g)).toBe(null);
    expect(exportBlockReason(g)).toBe(null);
    const rows = [{ syncUuid: 'u1', kind: 'baseline', defaultDecision: 'local', allowedDecisions: ['local'], fields: [] }];
    const decisions = initialDecisions(rows);
    expect(decisions).toEqual({ u1: 'local' });
    expect(applyGate(rows, decisions).canApply).toBe(true);
    expect(seedAllGate([{ rows, decisions }]).canApply).toBe(true);
    expect(decisionLabel(rows[0], 'local')).toBe('Record baseline');
    expect(kindLabel('baseline')).toBe('baseline not recorded here');
    expect(kindLabel('conflict')).toBe('changed here and in git');
    expect(kindLabel('git_newer')).toBe('changed in git');
  });
});

describe('assetText', () => {
  const h = 'abcdef0123456789';
  it('image, audio, sprite and unhashed values', () => {
    expect(assetText({ file: 'textures/items/sword.png', sha256: h })).toBe('textures/items/sword.png · abcdef01');
    expect(assetText({ file: 'audio/sfx/hit-1234abcd.ogg', sha1: h })).toBe('audio/sfx/hit-1234abcd.ogg · abcdef01');
    expect(assetText({ atlas: { file: 'sprites/a.png', sha256: h }, manifest: { file: 'sprites/a.json', sha256: '99887766554433' } }))
      .toBe('atlas sprites/a.png · abcdef01, manifest sprites/a.json · 99887766');
    expect(assetText({ unhashed: 'tiles/grass.png' })).toBe('local art not exported yet');
    expect(assetText({ atlas: { unhashed: 'k' }, manifest: { file: 'm.json', sha256: h } }))
      .toBe('atlas local art not exported yet, manifest m.json · abcdef01');
  });
  it('sprite keeps its other fields visible', () => {
    expect(assetText({ atlas: { file: 'a.png', sha256: h }, frames: 4 })).toBe('atlas a.png · abcdef01, {"frames":4}');
  });
  it('null for anything that is not an asset value', () => {
    expect(assetText({ a: 1 })).toBe(null);
    expect(assetText('x')).toBe(null);
    expect(assetText(null)).toBe(null);
  });
});

describe('blockedText', () => {
  it('asset and owner reasons have their own copy', () => {
    expect(blockedText({ blockedReason: 'asset_file_missing', blockedMessage: 'x' }))
      .toBe('File missing in git checkout — pull again or re-export on the other PC');
    expect(blockedText({ blockedReason: 'asset_file_mismatch' })).toBe('File changed outside the tab — re-export');
    expect(blockedText({ blockedReason: 'owner_missing', blockedMessage: 'seed Entities first' })).toBe('Seed Entities first');
    expect(blockedText({ blockedReason: 'referenced', blockedMessage: 'used by 2 rows' })).toBe('used by 2 rows');
    expect(blockedText({ blockedReason: 'key_clash' })).toBe('key_clash');
    expect(blockedText({ blockedReason: null })).toBe(null);
  });
});

describe('large previews', () => {
  it('pages 200 rows at a time across table sections', () => {
    expect(PAGE_ROWS).toBe(200);
    expect(nextShown(200)).toBe(400);
    const secs = [{ table: 'a', rows: [1, 2, 3] }, { table: 'b', rows: [4, 5] }];
    expect(limitSections(secs, 4)).toEqual([{ table: 'a', rows: [1, 2, 3] }, { table: 'b', rows: [4] }]);
    expect(limitSections(secs, 2)).toEqual([{ table: 'a', rows: [1, 2] }]);
    expect(BUSY_TEXT).toBe('Another export or seed is running');
  });
});
