import { describe, it, expect } from 'vitest';
import { statusLabel, canDecide, historyStatus, STATUS_FILTERS } from '../inviteRequestsModel.js';

describe('statusLabel', () => {
  it('names each state', () => {
    expect(statusLabel({ status: 'pending' })).toBe('pending');
    expect(statusLabel({ status: 'rejected' })).toBe('rejected');
    expect(statusLabel({ status: 'approved', codeUsed: false })).toBe('approved — code unused');
    expect(statusLabel({ status: 'approved', codeUsed: true })).toBe('approved — code used');
  });
  it('treats a missing codeUsed on an approved row as unused', () => {
    expect(statusLabel({ status: 'approved' })).toBe('approved — code unused');
  });
  it('falls back to the raw status, and to empty for nothing', () => {
    expect(statusLabel({ status: 'weird' })).toBe('weird');
    expect(statusLabel(null)).toBe('');
  });
});

describe('canDecide', () => {
  it('is true only for pending rows', () => {
    expect(canDecide({ status: 'pending' })).toBe(true);
    expect(canDecide({ status: 'approved' })).toBe(false);
    expect(canDecide({ status: 'rejected' })).toBe(false);
    expect(canDecide(null)).toBe(false);
  });
});

describe('historyStatus', () => {
  it('always sends an explicit status because the server defaults a missing one to pending', () => {
    expect(historyStatus('all')).toBe('all');
    expect(historyStatus('approved')).toBe('approved');
    expect(historyStatus('rejected')).toBe('rejected');
    expect(historyStatus('pending')).toBe('all');
    expect(historyStatus(undefined)).toBe('all');
    expect(STATUS_FILTERS).toEqual(['all', 'approved', 'rejected']);
  });
});
