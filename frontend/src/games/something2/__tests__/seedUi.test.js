import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusHead, PcLabelHint, backdropClick } from '../seedUi.jsx';

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
    const src = fs.readFileSync(path.join(__dirname, '..', 'SeedPreviewModal.jsx'), 'utf8');
    const modals = src.match(/<Modal\b[^>]*>/g) || [];
    expect(modals.length).toBeGreaterThan(0);
    for (const m of modals) expect(m).toContain('closeOnBackdrop={false}');
    const ui = fs.readFileSync(path.join(__dirname, '..', 'seedUi.jsx'), 'utf8');
    expect(ui).toContain('<Backdrop onClick={backdropClick(onClose, closeOnBackdrop)}>');
  });
});
