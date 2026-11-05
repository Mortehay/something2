import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { inviteDraft, madeText, listSummary, canRevoke, inviteStatus, INVITES_HELP } from '../boardInvitesModel.js';

vi.mock('../useBoard.js', () => ({}));
vi.mock('../useBoardInvites.js', () => ({}));
const { default: BoardInvites, RevokeDialog } = await import('../BoardInvites.jsx');
const { BoardAdminView } = await import('../BoardAdmin.jsx');

describe('invite draft', () => {
  it('accepts 1 to 20 whole numbers and trims the note', () => {
    expect(inviteDraft({ count: '3', note: '  for alice ' })).toEqual({ ok: true, count: 3, note: 'for alice' });
    expect(inviteDraft({ count: 20, note: '' }).ok).toBe(true);
    expect(inviteDraft({ count: '1' }).note).toBe('');
  });
  it('refuses everything else, with a plain sentence', () => {
    for (const count of ['0', '21', '-1', '1.5', '', 'x', '1e1', ' ', null]) {
      const d = inviteDraft({ count, note: '' });
      expect(d.ok, String(count)).toBe(false);
      expect(d.message).toMatch(/1 to 20/);
    }
    expect(inviteDraft({ count: 1, note: 'x'.repeat(81) }).ok).toBe(false);
    expect(inviteDraft({ count: 1, note: 'x'.repeat(80) }).ok).toBe(true);
    expect(inviteDraft({ count: 1, note: 'a\nb' }).ok).toBe(false);
    for (const note of ["é'; cmd;'", 'a$b', 'a"b']) expect(inviteDraft({ count: 1, note }).ok, note).toBe(false);
    expect(inviteDraft({ count: 1, note: 'для Олени (QA)' }).ok).toBe(true);
  });
});

describe('invite words', () => {
  it('names the three statuses and lets only an unused code be revoked', () => {
    expect(inviteStatus({ status: 'unused' }).label).toBe('Unused');
    expect(inviteStatus({ status: 'used' }).label).toBe('Used');
    expect(inviteStatus({ status: 'revoked' }).label).toBe('Revoked');
    expect(canRevoke({ status: 'unused' })).toBe(true);
    expect(canRevoke({ status: 'used' })).toBe(false);
    expect(canRevoke({ status: 'revoked' })).toBe(false);
  });
  it('says what was made, including a partial batch', () => {
    expect(madeText({ codes: ['A'], requested: 1 })).toBe('Made 1 code.');
    expect(madeText({ codes: ['A', 'B'], requested: 2 })).toBe('Made 2 codes.');
    expect(madeText({ codes: ['A'], requested: 3, partial: true })).toMatch(/1 of 3/);
    expect(madeText(null)).toBe(null);
  });
  it('summarises the list', () => {
    expect(listSummary({ invites: [], total: 0 })).toBe('No invite codes yet.');
    expect(listSummary({ invites: [{ status: 'unused' }, { status: 'used' }], total: 2 })).toBe('1 unused of 2.');
    expect(listSummary({ needsUpdate: true, invites: [] })).toBe(null);
  });
});

// A regex literal that opens with `<button` is read as JSX in a .js file, so it is built from a string.
const MAKE_DISABLED = new RegExp('<button[^>]*disabled[^>]*>Make codes');
const inv = (o) => ({ code: 'ABCD-EFGH-JKMN', note: null, createdAt: '2026-11-04T10:00:00.000Z', usedAt: null, usedBy: null, status: 'unused', ...o });
const box = (p = {}) => renderToStaticMarkup(h(BoardInvites, { data: { needsUpdate: false, invites: [], total: 0 }, onMake: () => {}, onRevoke: () => {}, ...p }));

describe('Invite codes box', () => {
  it('has the make form, the sign-up hint, and an empty list', () => {
    const html = box();
    expect(html).toContain('Invite codes');
    expect(html).toContain('Make codes');
    expect(html).toContain('maxLength="80"');
    expect(html).toContain('No invite codes yet.');
    expect(html).toContain(INVITES_HELP.replace(/"/g, '&quot;'));
  });
  it('lists each code with its status; Copy on each, Revoke only on an unused one', () => {
    const html = box({ data: { needsUpdate: false, total: 3, invites: [
      inv({ code: 'AAAA-AAAA-AAAA' }),
      inv({ code: 'BBBB-BBBB-BBBB', status: 'used', usedAt: '2026-11-05T10:00:00.000Z', usedBy: 7 }),
      inv({ code: 'CCCC-CCCC-CCCC', status: 'revoked', usedAt: '2026-11-05T10:00:00.000Z' }),
    ] } });
    for (const c of ['AAAA-AAAA-AAAA', 'BBBB-BBBB-BBBB', 'CCCC-CCCC-CCCC']) expect(html).toContain(c);
    expect(html).toContain('Unused');
    expect(html).toContain('Used');
    expect(html).toContain('Revoked');
    expect((html.match(new RegExp('>Copy</button>', 'g')) || []).length).toBe(3);
    expect((html.match(new RegExp('>Revoke</button>', 'g')) || []).length).toBe(1);
  });
  it('shows a note as text, never as markup', () => {
    const html = box({ data: { needsUpdate: false, total: 1, invites: [inv({ note: '<img src=x onerror=alert(1)> $(x)' })] } });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });
  it('an older board image says to press Update', () => {
    const html = box({ data: { needsUpdate: true, invites: [], total: 0 } });
    expect(html).toContain('Press Update');
  });
  it('shows loading, the error and the codes just made', () => {
    expect(box({ data: undefined, loading: true })).toContain('Loading');
    expect(box({ data: undefined, error: 'The board could not be reached.' })).toContain('The board could not be reached.');
    const html = box({ made: { codes: ['DDDD-DDDD-DDDD'], requested: 1, partial: false } });
    expect(html).toContain('Made 1 code.');
    expect(html).toContain('DDDD-DDDD-DDDD');
  });
  it('is read-only while the board is offline or a request is in flight', () => {
    const off = box({ disabledReason: 'The board is offline' });
    expect(off).toMatch(MAKE_DISABLED);
    expect(box({ pending: true })).toMatch(MAKE_DISABLED);
  });
});

describe('placement and confirm', () => {
  const status = { available: true, online: true, host: 'opiz03', commit: 'a1b2c3d', behindMain: 0, healthCode: 200, checkedAt: 1, tunnels: {} };
  const view = (p) => renderToStaticMarkup(h(BoardAdminView, { status, samples: [], job: null, preview: null, range: '1h', now: 1, onAction: () => {}, onRange: () => {}, ...p }));
  it('the left column shows the box when the tab has invite data, and not otherwise', () => {
    expect(view({ invites: { data: { needsUpdate: false, invites: [], total: 0 }, onMake: () => {}, onRevoke: () => {} } })).toContain('aria-label="Invite codes"');
    expect(view({})).not.toContain('aria-label="Invite codes"');
  });
  it('revoking asks first and names the code', () => {
    const html = renderToStaticMarkup(h(RevokeDialog, { code: 'AAAA-AAAA-AAAA', onConfirm: () => {}, onClose: () => {} }));
    expect(html).toContain('Revoke this code?');
    expect(html).toContain('AAAA-AAAA-AAAA');
  });
});
