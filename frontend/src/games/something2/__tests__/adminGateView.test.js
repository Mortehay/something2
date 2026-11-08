import { describe, it, expect } from 'vitest';
import { adminGateView, showAdminTab, codeToSend } from '../adminGateView.js';
import { showWorldBossTestPanel } from '../worldBossPanelGate.js';

describe('adminGateView', () => {
  it('is "checking" before the server answers', () => {
    expect(adminGateView(null).mode).toBe('checking');
  });
  it('has nothing to offer a player on a server with no code', () => {
    expect(adminGateView({ admin: false, required: false, unlocked: false, allowed: false }).mode).toBe('none');
  });
  it('is "open" for an admin account when the server has no code', () => {
    const v = adminGateView({ admin: true, required: false, unlocked: true, allowed: true });
    expect(v.mode).toBe('open');
    expect(v.message).toMatch(/ADMIN_MENU_CODE/);
  });
  it('is "locked" until the code is entered, then "unlocked" - for a player as for an admin', () => {
    for (const admin of [true, false]) {
      expect(adminGateView({ admin, required: true, unlocked: false, allowed: false }).mode).toBe('locked');
      expect(adminGateView({ admin, required: true, unlocked: true, allowed: true }).mode).toBe('unlocked');
    }
  });
  it('reports a wrong code and a lock-out, only after an unlock attempt', () => {
    const base = { admin: false, required: true, unlocked: false };
    expect(adminGateView({ ...base, op: 'status', ok: true }).error).toBeNull();
    expect(adminGateView({ ...base, op: 'unlock', ok: false, error: 'wrong code' }).error).toBe('Wrong code.');
    expect(adminGateView({ ...base, op: 'unlock', ok: false, error: 'too many attempts', retryMs: 42_100 }).error).toMatch(/43 s/);
    expect(adminGateView({ ...base, op: 'unlock', ok: false, error: 'too many attempts' }).error).toMatch(/1 s/);
  });
});

describe('showAdminTab', () => {
  it('is drawn for an admin account, or when there is a code to enter', () => {
    expect(showAdminTab({ admin: true, required: false })).toBe(true);
    expect(showAdminTab({ admin: false, required: true })).toBe(true);
  });
  it('is not drawn for a player on a server with no code, or before the server answers', () => {
    expect(showAdminTab({ admin: false, required: false })).toBe(false);
    expect(showAdminTab(null)).toBe(false);
    expect(showAdminTab(undefined)).toBe(false);
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

describe('showWorldBossTestPanel follows the server verdict', () => {
  it('keeps the old rule when the server was not asked', () => {
    expect(showWorldBossTestPanel({ isPlaying: true, isAdmin: true })).toBe(true);
    expect(showWorldBossTestPanel({ isPlaying: true, isAdmin: false })).toBe(false);
    expect(showWorldBossTestPanel({ isPlaying: false, isAdmin: true })).toBe(false);
  });
  it('stays hidden until the server has answered', () => {
    expect(showWorldBossTestPanel({ isPlaying: true, adminGate: { pending: true } })).toBe(false);
    expect(showWorldBossTestPanel({ isPlaying: true, isAdmin: true, adminGate: null })).toBe(false);
  });
  it('is shown exactly when the server says allowed, whatever the account role', () => {
    expect(showWorldBossTestPanel({ isPlaying: true, isAdmin: false, adminGate: { allowed: true } })).toBe(true);
    expect(showWorldBossTestPanel({ isPlaying: true, isAdmin: true, adminGate: { allowed: false } })).toBe(false);
    expect(showWorldBossTestPanel({ isPlaying: true, isAdmin: true, adminGate: { admin: true, required: true, unlocked: false } })).toBe(false);
  });
  it('never when not playing', () => {
    expect(showWorldBossTestPanel({ isPlaying: false, adminGate: { allowed: true } })).toBe(false);
  });
});
