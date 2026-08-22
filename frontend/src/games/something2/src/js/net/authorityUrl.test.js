import { describe, it, expect } from 'vitest';
import { authorityWsUrl } from './authorityUrl.js';

describe('authorityWsUrl', () => {
  it('rewrites an http apiUrl to ws, ignoring loc', () => {
    const loc = { protocol: 'https:', host: 'should-not-be-used.example' };
    expect(authorityWsUrl('http://localhost:13101', loc)).toBe('ws://localhost:13101/authority');
  });

  it('rewrites an https apiUrl to wss, ignoring loc', () => {
    const loc = { protocol: 'http:', host: 'should-not-be-used.example' };
    expect(authorityWsUrl('https://api.example.com', loc)).toBe('wss://api.example.com/authority');
  });

  it('derives wss from an https page when apiUrl is empty (same-origin default)', () => {
    const loc = { protocol: 'https:', host: 'random-tunnel.trycloudflare.com' };
    expect(authorityWsUrl('', loc)).toBe('wss://random-tunnel.trycloudflare.com/authority');
  });

  it('derives ws from a plain http page when apiUrl is empty', () => {
    const loc = { protocol: 'http:', host: 'localhost:5173' };
    expect(authorityWsUrl('', loc)).toBe('ws://localhost:5173/authority');
  });
});
