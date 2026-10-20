import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LOCAL_BANNER, isBoxDown, localRequestBody, reportVerdict, saveOutcome,
} from '../worldGenLocal.js';

// SOMET-644 Task 6: the Generated Worlds tab's local fallback. SSR render
// (vitest is node-env, no DOM); the data hooks are mocked out.
vi.mock('../useWorldGen.js', () => ({}));
const { LocalBanner, LocalPreviewResult } = await import('../WorldGenAdmin.jsx');

const err = (code, message = 'boom') => Object.assign(new Error(message), { code });

describe('isBoxDown', () => {
  it('is true for unreachable and not_configured, false otherwise', () => {
    expect(isBoxDown(err('unreachable'))).toBe(true);
    expect(isBoxDown(err('not_configured'))).toBe(true);
    expect(isBoxDown(err('auth_failed'))).toBe(false);
    expect(isBoxDown(err(undefined))).toBe(false);
    expect(isBoxDown(null)).toBe(false);
  });
  it('LOCAL_BANNER is the agreed wording', () => {
    expect(LOCAL_BANNER).toBe('GPU box unreachable — generate locally (rules only: no LLM biome choice, no preview image)');
  });
});

describe('localRequestBody', () => {
  it('sends the box create fields as numbers and drops theme', () => {
    expect(localRequestBody({
      name: ' Emerald Reach ', worlds: '3', target_per_screen: '4.1', size: '64', chunk_size: '32', biome_cell: '16', theme: 'x',
    })).toEqual({ name: 'Emerald Reach', worlds: 3, target_per_screen: 4.1, size: 64, chunk_size: 32, biome_cell: 16 });
  });
  it('keeps a non-numeric value as typed so the server 400 names it', () => {
    expect(localRequestBody({ name: 'a1', worlds: 'abc', target_per_screen: '', size: 64, chunk_size: 32, biome_cell: 32 }).worlds).toBe('abc');
  });
});

describe('reportVerdict', () => {
  it('keeps problems and caveats apart; ok follows problems only', () => {
    const v = reportVerdict({ ok: true, problems: [], caveats: ['missed by 30%'], totals: { worlds: 3, creatures: 200, mean_per_screen: 4.1 } });
    expect(v).toEqual({ ok: true, problems: [], caveats: ['missed by 30%'], totals: { worlds: 3, creatures: 200, mean_per_screen: 4.1 } });
    expect(reportVerdict({ ok: false, problems: ['x is EMPTY'], caveats: [] }).ok).toBe(false);
    expect(reportVerdict(null)).toEqual({ ok: false, problems: [], caveats: [], totals: null });
  });
});

describe('saveOutcome', () => {
  it('a 409 asks to confirm overwrite; other errors are failures', () => {
    expect(saveOutcome(err('exists'))).toBe('confirm_overwrite');
    expect(saveOutcome(err('invalid_spec'))).toBe('failed');
    expect(saveOutcome(null)).toBe(null);
  });
});

const preview = {
  name: 'emerald-reach', author: 'rules (local fallback)', valid: true, errors: [],
  ignored: ['theme'], note: 'theme ignored: the local fallback has no LLM, so biomes are chosen by the rules.',
  spec: { worlds: [{}, {}, {}], links: [{}, {}] },
  report: { ok: false, problems: ['emerald_reach_2 is EMPTY'], caveats: ['asked 6, got 4.1'], totals: { worlds: 3, creatures: 210, mean_per_screen: 4.1 } },
};
const render = (props) => renderToStaticMarkup(h(LocalPreviewResult, {
  preview, saving: false, confirmOverwrite: false, saved: null, saveError: null,
  onSave: () => {}, onOverwrite: () => {}, onCancelOverwrite: () => {}, ...props,
}));
const btn = (html, text) => (html.match(new RegExp(`<button[^>]*>[^<]*${text}[^<]*</button>`)) || [])[0] || '';

describe('LocalBanner', () => {
  it('shows the fallback wording', () => {
    expect(renderToStaticMarkup(h(LocalBanner))).toContain('GPU box unreachable — generate locally');
  });
});

describe('LocalPreviewResult', () => {
  it('shows the author, verdict, problems and caveats separately, totals, and Save as map spec', () => {
    const html = render();
    expect(html).toContain('rules (local fallback)');
    expect(html).toContain('1 problem(s)');
    expect(html).toContain('emerald_reach_2 is EMPTY');
    expect(html).toContain('caveats');
    expect(html).toContain('asked 6, got 4.1');
    expect(html).toContain('3 worlds');
    expect(html).toContain('210 creatures');
    expect(html).toContain('4.1 per screen');
    expect(html).toContain('theme ignored');
    expect(btn(html, 'Save as map spec')).not.toContain('disabled');
  });
  it('an ok report reads ok', () => {
    const html = render({ preview: { ...preview, report: { ...preview.report, ok: true, problems: [] } } });
    expect(html).toContain('report ok');
    expect(html).not.toContain('problem(s)');
  });
  it('a spec that does not validate disables saving and lists the errors', () => {
    const html = render({ preview: { ...preview, valid: false, errors: ['biome "Meadow" missing'] } });
    expect(html).toContain('biome &quot;Meadow&quot; missing');
    expect(btn(html, 'Save as map spec')).toContain('disabled');
  });
  it('a 409 asks to confirm the overwrite', () => {
    const html = render({ confirmOverwrite: true });
    expect(html).toContain('emerald-reach.map.json already exists');
    expect(btn(html, 'Overwrite')).not.toContain('disabled');
    expect(btn(html, 'Cancel')).toBeTruthy();
  });
  it('after saving it points to Seed / Export → Maps', () => {
    const html = render({ saved: { file: 'emerald-reach.map.json', overwrote: false } });
    expect(html).toContain('Saved seeds/maps/emerald-reach.map.json');
    expect(html).toContain('Seed / Export → Maps');
  });
  it('a save failure is shown', () => {
    expect(render({ saveError: err('invalid_spec', 'does not validate') })).toContain('does not validate');
  });
});
