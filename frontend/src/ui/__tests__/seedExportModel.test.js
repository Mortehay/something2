import { describe, it, expect } from 'vitest';
import {
  statusBadge, initialDecisions, bulkSet, applyGate, allowedDecisions, kindLabel,
} from '../../games/something2/seedExportModel.js';

const row = (syncUuid, kind, defaultDecision, blockedReason = null) => (
  { syncUuid, key: syncUuid, kind, defaultDecision, fields: [], blockedReason });

describe('statusBadge', () => {
  it('maps each status to copy and tone', () => {
    expect(statusBadge({ status: 'in_sync' })).toEqual({ label: 'in sync', tone: 'ok' });
    expect(statusBadge({ status: 'local_edits', localEdits: 14 })).toEqual({ label: '14 edits not exported', tone: 'warn' });
    expect(statusBadge({ status: 'git_newer' })).toEqual({ label: 'git is newer', tone: 'info' });
    expect(statusBadge({ status: 'never_exported' })).toEqual({ label: 'never exported', tone: 'info' });
    expect(statusBadge({ status: 'tokens_missing', tokensMissing: 2 })).toEqual({ label: '2 tokens missing', tone: 'warn' });
    expect(statusBadge({ status: 'tokens_missing', tokensMissing: 1 }).label).toBe('1 token missing');
    expect(statusBadge({ status: 'bad_file' })).toEqual({ label: 'bad export file', tone: 'bad' });
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
    expect(g.summary).toEqual({ updated: 3, created: 2, deleted: 1, kept: 1 });
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
