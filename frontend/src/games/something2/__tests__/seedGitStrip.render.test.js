import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// SOMET-642 (plan 5): the git strip states. SSR render (vitest is node-env).
vi.mock('../useSeedExport.js', () => ({}));
const { GitStripView, gitConfirmText } = await import('../SeedGitStrip.jsx');

const ok = { available: true, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, seedsDirty: [], otherDirty: [], lastFetchAt: '2026-10-20T10:00:00Z', suggestedMessage: 'seed export: quests from desk' };
const view = (status, busy = false, pending = false) => renderToStaticMarkup(h(GitStripView, { status, busy, pending, onRun: () => {} }));
const btn = (html, text) => (html.match(new RegExp(`<button[^>]*>${text}</button>`)) || [])[0] || '';

describe('GitStripView', () => {
  it('available: branch line, buttons, reasons as tooltips', () => {
    const html = view(ok);
    expect(html).toContain('main · ↑0 ↓0 · 0 seed changes');
    expect(btn(html, 'Fetch')).not.toContain('disabled');
    expect(btn(html, 'Pull…')).not.toContain('disabled');
    expect(btn(html, 'Commit seeds…')).toContain('title="No seed changes to commit"');
    expect(btn(html, 'Push…')).toContain('title="Nothing to push"');
    expect(html).not.toContain('outside seeds/');
  });
  it('unavailable: the hint copy and no buttons', () => {
    const html = view({ available: false, reason: 'helper_unavailable', hint: 'x' });
    expect(html).toContain('Git buttons need the git helper: run `make git-helper`');
    expect(html).not.toContain('<button');
  });
  it('dirty outside seeds: warn chip, pull blocked, commit enabled', () => {
    const html = view({ ...ok, seedsDirty: ['backend/seeds/sync/a.json'], otherDirty: ['x.js', 'y.js'] });
    expect(html).toContain("2 changes outside seeds/ — won&#x27;t be committed");
    expect(btn(html, 'Pull…')).toContain('disabled');
    expect(btn(html, 'Pull…')).toContain('Uncommitted changes');
    expect(btn(html, 'Commit seeds…')).not.toContain('disabled');
  });
  it('behind: push blocked with pull first, pull enabled', () => {
    const html = view({ ...ok, behind: 3 });
    expect(html).toContain('↑0 ↓3');
    expect(btn(html, 'Push…')).toContain('Behind origin — pull first');
    expect(btn(html, 'Pull…')).not.toContain('disabled');
  });
  it('a running job disables every action with the busy reason', () => {
    const html = view({ ...ok, ahead: 1, seedsDirty: ['a'] }, true);
    for (const t of ['Fetch', 'Pull…', 'Commit seeds…', 'Push…']) {
      expect(btn(html, t)).toContain('disabled');
      expect(btn(html, t)).toContain('Another export or seed is running');
    }
  });
});

describe('GitStripView edge states (SOMET-649)', () => {
  it('helper_error: git failed text, no make git-helper, no buttons', () => {
    const html = view({ available: false, reason: 'helper_error', hint: 'x' });
    expect(html).toContain('Git helper is running but git failed');
    expect(html).toContain('backend/run/git-helper.log');
    expect(html).not.toContain('make git-helper');
    expect(html).not.toContain('<button');
  });
  it('detached HEAD: text and disabled reasons, no null', () => {
    const html = view({ ...ok, branch: null, upstream: null, ahead: 1, seedsDirty: ['a'] });
    expect(html).toContain('detached HEAD');
    expect(html).not.toContain('null');
    for (const t of ['Pull…', 'Commit seeds…', 'Push…']) {
      expect(btn(html, t)).toContain('disabled');
      expect(btn(html, t)).toContain('Not on a branch');
    }
  });
  it('no upstream: text, push and pull blocked, commit enabled, never Nothing to push', () => {
    const html = view({ ...ok, upstream: null, seedsDirty: ['a'] });
    expect(html).toContain('no upstream');
    expect(btn(html, 'Push…')).toContain('No origin/main yet');
    expect(btn(html, 'Pull…')).toContain('No origin/main yet');
    expect(btn(html, 'Commit seeds…')).not.toContain('disabled');
    expect(html).not.toContain('Nothing to push');
  });
  it('a pending seed mutation disables every action with its reason', () => {
    const html = view({ ...ok, ahead: 1, seedsDirty: ['a'] }, false, true);
    for (const t of ['Pull…', 'Commit seeds…', 'Push…']) {
      expect(btn(html, t)).toContain('A seed export or seed is running');
    }
    expect(btn(html, 'Fetch')).toContain('disabled');
  });
});

describe('gitConfirmText', () => {
  it('says exactly what will happen', () => {
    expect(gitConfirmText('pull', { ...ok, behind: 3 })).toBe('Fetch and fast-forward from origin/main (3 new commits known so far).');
    expect(gitConfirmText('pull', { ...ok, behind: 1 })).toBe('Fetch and fast-forward from origin/main (1 new commit known so far).');
    expect(gitConfirmText('pull', ok)).toBe('Fetch and fast-forward from origin/main.');
    expect(gitConfirmText('push', { ...ok, ahead: 1 })).toBe('Push 1 commit to origin/main.');
    // the helper always pushes origin/<branch>, whatever the upstream is
    expect(gitConfirmText('push', { ...ok, ahead: 1, branch: 'feat/x', upstream: 'fork/other' })).toBe('Push 1 commit to origin/feat/x.');
    expect(gitConfirmText('commit', { ...ok, seedsDirty: ['a', 'b'] })).toContain('2 files under backend/seeds/');
  });
});

describe('GitStripView diverged', () => {
  it('blocks pull and push with the terminal hint', () => {
    const html = view({ ...ok, ahead: 1, behind: 3 });
    expect(btn(html, 'Pull…')).toContain('diverged');
    expect(btn(html, 'Push…')).toContain('diverged');
  });
});
