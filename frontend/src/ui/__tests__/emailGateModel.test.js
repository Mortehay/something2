import { describe, it, expect } from 'vitest';
import { gateStep } from '../emailGateModel.js';

describe('gateStep', () => {
  it('is loading until /me has answered', () => {
    expect(gateStep(null)).toBe('loading');
    expect(gateStep(undefined)).toBe('loading');
  });
  it('is none when the gate is inactive, even with no email', () => {
    expect(gateStep({ emailRequired: false, email: null, emailVerified: false })).toBe('none');
  });
  it('is none for a verified account', () => {
    expect(gateStep({ emailRequired: true, email: 'a@b.co', emailVerified: true })).toBe('none');
  });
  it('asks for an email when there is none', () => {
    expect(gateStep({ emailRequired: true, email: null, emailVerified: false })).toBe('add');
    expect(gateStep({ emailRequired: true, email: '', emailVerified: false })).toBe('add');
  });
  it('asks to verify when an email is set but unverified', () => {
    expect(gateStep({ emailRequired: true, email: 'a@b.co', emailVerified: false })).toBe('verify');
  });
});
