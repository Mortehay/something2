import { describe, it, expect } from 'vitest';
import { biomeRingSvg } from '../biomeRingSvg.js';

const decode = (uri) => decodeURIComponent(uri.replace(/^data:image\/svg\+xml;utf8,/, ''));

describe('biomeRingSvg', () => {
  it('returns a data URI', () => {
    expect(biomeRingSvg(['#5aa84f'])).toMatch(/^data:image\/svg\+xml;utf8,/);
  });

  it('draws one arc per biome colour', () => {
    const svg = decode(biomeRingSvg(['#5aa84f', '#c9a227', '#8fb8d6']));
    expect(svg.match(/<circle/g)).toHaveLength(3);
    expect(svg).toContain('#5aa84f');
    expect(svg).toContain('#c9a227');
    expect(svg).toContain('#8fb8d6');
  });

  it('draws a single neutral ring when there are no biomes', () => {
    const svg = decode(biomeRingSvg([]));
    expect(svg.match(/<circle/g)).toHaveLength(1);
    expect(svg).toContain('#555555');
  });

  it('treats null/undefined like an empty list', () => {
    expect(decode(biomeRingSvg(null))).toContain('#555555');
    expect(decode(biomeRingSvg(undefined))).toContain('#555555');
  });

  it('splits the circumference evenly across arcs', () => {
    const svg = decode(biomeRingSvg(['#111111', '#222222', '#333333', '#444444']));
    const dashes = [...svg.matchAll(/stroke-dasharray="([\d.]+) ([\d.]+)"/g)];
    expect(dashes).toHaveLength(4);
    const [seg, gap] = [Number(dashes[0][1]), Number(dashes[0][2])];
    const circumference = seg + gap;
    expect(seg / circumference).toBeCloseTo(0.25, 5);
    for (const d of dashes) expect(Number(d[1])).toBeCloseTo(seg, 5);
  });

  it('offsets each arc so they do not overlap', () => {
    const svg = decode(biomeRingSvg(['#111111', '#222222']));
    const offsets = [...svg.matchAll(/stroke-dashoffset="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
    expect(new Set(offsets).size).toBe(2);
  });

  // biomes.color is admin-editable free text. It lands inside an SVG attribute
  // in a data URI, so anything that isn't a plain hex colour must be dropped
  // rather than interpolated.
  it('rejects a colour that is not a plain hex value', () => {
    const svg = decode(biomeRingSvg(['#5aa84f', '" onload="alert(1)', 'red; }']));
    expect(svg).not.toContain('onload');
    expect(svg).not.toContain('alert');
    expect(svg).toContain('#5aa84f');
  });

  it('substitutes the neutral colour for a rejected entry, keeping arc count', () => {
    const svg = decode(biomeRingSvg(['#5aa84f', 'not-a-colour']));
    expect(svg.match(/<circle/g)).toHaveLength(2);
  });

  it('accepts 3- and 6-digit hex, case-insensitively', () => {
    const svg = decode(biomeRingSvg(['#ABC', '#AbCdEf']));
    expect(svg).toContain('#ABC');
    expect(svg).toContain('#AbCdEf');
  });

  it('honours size and thickness', () => {
    const svg = decode(biomeRingSvg(['#111111'], { size: 100, thickness: 12 }));
    expect(svg).toContain('width="100"');
    expect(svg).toContain('stroke-width="12"');
  });

  // `empty` reaches the same `stroke` attribute as the caller's colours, so it
  // has to clear the same bar.
  it('sanitises the `empty` option too', () => {
    const svg = decode(biomeRingSvg(['not-a-colour'], { empty: '" onload="alert(1)' }));
    expect(svg).not.toContain('onload');
    expect(svg).not.toContain('alert');
    expect(svg).toContain('#555555');
  });

  it('honours a safe custom `empty` colour', () => {
    const svg = decode(biomeRingSvg([], { empty: '#abc' }));
    expect(svg).toContain('#abc');
  });

  it('falls back to neutral for every rejected entry, keeping arc count', () => {
    const svg = decode(biomeRingSvg(['bad', 'also-bad']));
    expect(svg.match(/<circle/g)).toHaveLength(2);
    expect(svg).toContain('#555555');
  });
});
