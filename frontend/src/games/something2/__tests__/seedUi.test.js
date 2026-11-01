import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusHead, PcLabelHint, backdropClick, MigrationsButton } from '../seedUi.jsx';

// Final-review fixes of the Seed / Export tab (SOMET-638).

describe('StatusHead', () => {
  it('notes the running game still uses old data while a restart is pending', () => {
    expect(renderToStaticMarkup(h(StatusHead, { restartRequired: true }))).toContain('running game still uses old data');
    expect(renderToStaticMarkup(h(StatusHead, { restartRequired: false }))).not.toContain('old data');
  });
});

describe('PcLabelHint', () => {
  it('asks to set SEED_PC_LABEL only when it is unset', () => {
    expect(renderToStaticMarkup(h(PcLabelHint, { meta: { pcLabel: 'unnamed-pc', pcLabelSet: false } })))
      .toContain('Set SEED_PC_LABEL in .env so exports say which PC they came from');
    expect(renderToStaticMarkup(h(PcLabelHint, { meta: { pcLabel: 'desk', pcLabelSet: true } }))).toBe('');
    expect(renderToStaticMarkup(h(PcLabelHint, { meta: undefined }))).toBe('');
  });
});

describe('preview modal backdrop', () => {
  it('backdropClick closes only when allowed', () => {
    const close = vi.fn();
    expect(backdropClick(close)).toBe(close);
    expect(backdropClick(close, true)).toBe(close);
    expect(backdropClick(close, false)).toBeUndefined();
  });
  // vitest runs in node (no DOM to click), so the wiring is checked on source.
  it('every Modal of the seed preview opts out of backdrop close', () => {
    for (const f of ['SeedPreviewModal.jsx', 'SeedAllModal.jsx']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      const modals = src.match(/<Modal\b[^>]*>/g) || [];
      expect(modals.length).toBeGreaterThan(0);
      for (const m of modals) expect(m).toContain('closeOnBackdrop={false}');
    }
    const ui = fs.readFileSync(path.join(__dirname, '..', 'seedUi.jsx'), 'utf8');
    expect(ui).toContain('<Backdrop onClick={backdropClick(onClose, closeOnBackdrop)}>');
  });
});

describe('MigrationsButton', () => {
  const html = (migrations, extra = {}) => renderToStaticMarkup(h(MigrationsButton, { migrations, onClick: () => {}, ...extra }));

  it('is disabled with no count when every migration is applied', () => {
    const out = html({ pending: [], appliesOnRestart: true });
    expect(out).toContain('disabled');
    expect(out).toContain('>Update migrations<');
    expect(out).toContain('all migrations applied');
  });

  it('is enabled with the count and lists the pending files', () => {
    const out = html({ pending: ['1_a', '2_b'], appliesOnRestart: true });
    expect(out).not.toContain('disabled');
    expect(out).toContain('Update migrations (2)');
    expect(out).toContain('1_a');
    expect(out).toContain('2_b');
  });

  it('stays disabled when a restart would not run them (no boot migration)', () => {
    const out = html({ pending: ['1_a'], appliesOnRestart: false });
    expect(out).toContain('disabled');
    expect(out).toContain('Update migrations (1)');
    expect(out).toContain('migrations run at deploy');
  });

  it('is disabled while unknown or while a restart is in flight', () => {
    expect(html(undefined)).toContain('disabled');
    expect(html({ pending: ['1_a'], appliesOnRestart: true }, { busy: true })).toContain('disabled');
  });
});
