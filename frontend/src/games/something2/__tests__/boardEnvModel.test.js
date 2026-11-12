import { describe, it, expect } from 'vitest';
import { statusLabel, copyable, visibleRows, envSummary, copyResultText, LOCKED_TIP, RESTART_ENV_NOTE } from '../boardEnvModel.js';

describe('statusLabel', () => {
  it('names each status', () => {
    expect(statusLabel('passed')).toBe('Passed');
    expect(statusLabel('not_passed')).toBe('Not passed');
    expect(statusLabel('different')).toBe('Different on board');
    expect(statusLabel('board_only')).toBe('Only on board');
  });
  it('is empty for anything else', () => {
    expect(statusLabel('weird')).toBe('');
    expect(statusLabel(undefined)).toBe('');
  });
});

describe('copyable', () => {
  it('allows only unlocked keys that are missing or different on the board', () => {
    expect(copyable({ key: 'A', status: 'not_passed', locked: false })).toBe(true);
    expect(copyable({ key: 'A', status: 'different', locked: false })).toBe(true);
    expect(copyable({ key: 'A', status: 'passed', locked: false })).toBe(false);
    expect(copyable({ key: 'A', status: 'board_only', locked: false })).toBe(false);
    expect(copyable({ key: 'A', status: 'different', locked: true })).toBe(false);
    expect(copyable({ key: 'A', status: 'not_passed', locked: true })).toBe(false);
  });
});

describe('visibleRows', () => {
  const rows = [{ key: 'A', status: 'passed' }, { key: 'B', status: 'different' }];
  it('hides passed rows only when asked', () => {
    expect(visibleRows(rows, false)).toEqual(rows);
    expect(visibleRows(rows, true)).toEqual([rows[1]]);
    expect(visibleRows(undefined, true)).toEqual([]);
  });
});

describe('texts', () => {
  it('summarises the counts', () => {
    expect(envSummary([{ status: 'passed' }, { status: 'passed' }, { status: 'not_passed' }, { status: 'different' }, { status: 'board_only' }]))
      .toEqual({ passed: 2, not_passed: 1, different: 1, board_only: 1 });
  });
  it('lists the written keys and the skipped ones', () => {
    expect(copyResultText({ written: ['A', 'B'], skipped: [] })).toBe('Copied to the board: A, B');
    expect(copyResultText({ written: [], skipped: [{ key: 'C', reason: 'locked' }] })).toBe('Nothing was copied. Skipped: C (locked)');
    expect(copyResultText({ written: ['A'], skipped: [{ key: 'C', reason: 'empty' }] })).toBe('Copied to the board: A. Skipped: C (empty)');
  });
  it('has the fixed copy', () => {
    expect(LOCKED_TIP).toBe('Board-specific — not copied');
    expect(RESTART_ENV_NOTE).toBe('Restart the backend on the board for changes to apply');
  });
});
