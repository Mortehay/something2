import { describe, it, expect } from 'vitest';
import { adminGateView, codeToSend } from '../adminGateView.js';
import { showWorldBossTestPanel } from '../worldBossPanelGate.js';

describe('adminGateView', () => {
  it('is "checking" before the server answers', () => {
    expect(adminGateView(null).mode).toBe('checking');
  });
  it('says so when the account is not an admin', () => {
    expect(adminGateView({ admin: false }).mode).toBe('none');
  });
  it('is "open" when the server has no code set', () => {
    const v = adminGateView({ admin: true, required: false, unlocked: true });
    expect(v.mode).toBe('open');
    expect(v.message).toMatch(/ADMIN_MENU_CODE/);
  });
  it('is "locked" until the code is entered, then "unlocked"', () => {
    expect(adminGateView({ admin: true, required: true, unlocked: false }).mode).toBe('locked');
    expect(adminGateView({ admin: true, required: true, unlocked: true }).mode).toBe('unlocked');
  });
  it('reports a wrong code and a lock-out, only after an unlock attempt', () => {
    const base = { admin: true, required: true, unlocked: false };
    expect(adminGateView({ ...base, op: 'status', ok: true }).error).toBeNull();
    expect(adminGateView({ ...base, op: 'unlock', ok: false, error: 'wrong code' }).error).toBe('Wrong code.');
    expect(adminGateView({ ...base, op: 'unlock', ok: false, error: 'too many attempts', retryMs: 42_100 }).error).toMatch(/43 s/);
    expect(adminGateView({ ...base, op: 'unlock', ok: false, error: 'too many attempts' }).error).toMatch(/1 s/);
  });
});

describe('codeToSend', () => {
  it('trims, refuses blank, refuses what the server would cut', () => {
    expect(codeToSend('  abc  ')).toBe('abc');
    expect(codeToSend('')).toBeNull();
    expect(codeToSend('   ')).toBeNull();
    expect(codeToSend(null)).toBeNull();
    expect(codeToSend(42)).toBeNull();
    expect(codeToSend('x'.repeat(201))).toBeNull();
    expect(codeToSend('x'.repeat(200))).toBe('x'.repeat(200));
  });
});

describe('showWorldBossTestPanel with the code lock', () => {
  const on = { isPlaying: true, isAdmin: true };
  it('keeps the old rule when the lock is not consulted', () => {
    expect(showWorldBossTestPanel(on)).toBe(true);
    expect(showWorldBossTestPanel({ ...on, isAdmin: false })).toBe(false);
    expect(showWorldBossTestPanel({ ...on, isPlaying: false })).toBe(false);
  });
  it('stays hidden until the server has answered', () => {
    expect(showWorldBossTestPanel({ ...on, adminGate: { pending: true } })).toBe(false);
    expect(showWorldBossTestPanel({ ...on, adminGate: null })).toBe(false);
  });
  it('is shown when no code is required, or the code was entered', () => {
    expect(showWorldBossTestPanel({ ...on, adminGate: { admin: true, required: false, unlocked: true } })).toBe(true);
    expect(showWorldBossTestPanel({ ...on, adminGate: { admin: true, required: true, unlocked: true } })).toBe(true);
  });
  it('is hidden while a required code has not been entered', () => {
    expect(showWorldBossTestPanel({ ...on, adminGate: { admin: true, required: true, unlocked: false } })).toBe(false);
  });
  it('is never shown for an account the server says is not an admin', () => {
    expect(showWorldBossTestPanel({ ...on, adminGate: { admin: false, required: false, unlocked: false } })).toBe(false);
  });
});
