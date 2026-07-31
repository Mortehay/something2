import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { offendingLiterals } from './themeGate.js';

const globalStyles = readFileSync(
  fileURLToPath(new URL('../../../styles/GlobalStyles.js', import.meta.url)), 'utf8',
);

// [token, darkValue, lightValue] — copied from the design contract. Do not re-derive.
const TOKENS = [
  ['--s2-bg', '#0f0f1a', '#f4f4f8'],
  ['--s2-bg-sunken', '#12121f', '#ececf3'],
  ['--s2-surface-subtle', '#161625', '#f7f7fb'],
  ['--s2-surface', '#1a1a2e', '#ffffff'],
  ['--s2-surface-raised', '#23233f', '#f0f0f6'],
  ['--s2-border', '#2e2e3e', '#d4d4e0'],
  ['--s2-border-strong', '#3a3a4e', '#8b8ba3'],
  ['--s2-text-strong', '#fff', '#12121f'],
  ['--s2-on-accent', '#fff', '#ffffff'],
  ['--s2-text', '#eee', '#1a1a2e'],
  ['--s2-text-secondary', '#ccc', '#33334a'],
  ['--s2-text-muted', '#aaa', '#4a4a5e'],
  ['--s2-text-dim', '#888', '#6b6b80'],
  ['--s2-btn-neutral', '#555', '#e2e2ea'],
  ['--s2-disabled-bg', '#555', '#ececf3'],
  ['--s2-swatch-border', '#555', '#8b8ba3'],
  ['--s2-accent', '#4a9eff', '#2563eb'],
  ['--s2-selected', '#facc15', '#946005'],
  ['--s2-danger', '#ef4444', '#b91c1c'],
  ['--s2-danger-soft', '#f87171', '#c81e1e'],
  ['--s2-success', '#22c55e', '#15803d'],
  ['--s2-success-alt', '#10b981', '#047857'],
  ['--s2-warning', '#f59e0b', '#b45309'],
  ['--s2-warning-soft', '#fcd34d', '#946005'],
  ['--s2-warning-bright', '#fde047', '#854d0e'],
  ['--s2-warning-mid', '#eab308', '#854d0e'],
];

// Slice the two mode blocks apart so a token defined in only one is caught.
function modeBlocks(source) {
  const darkStart = source.indexOf('&.dark-mode');
  if (darkStart === -1) throw new Error('no &.dark-mode block found');
  const darkEnd = source.indexOf('\n  }', darkStart);
  if (darkEnd === -1) throw new Error('could not find end of &.dark-mode block');
  const lightStart = source.indexOf('&.light-mode');
  if (lightStart === -1) throw new Error('no &.light-mode block found');
  return { light: source.slice(lightStart, darkStart), dark: source.slice(darkStart, darkEnd) };
}

describe('--s2-* theme tokens', () => {
  const { light, dark } = modeBlocks(globalStyles);

  it.each(TOKENS)('defines %s in the light block as %s', (token, _darkValue, lightValue) => {
    expect(light).toMatch(new RegExp(`${token}\\s*:\\s*${lightValue}\\s*;`, 'i'));
  });

  it.each(TOKENS)('defines %s in the dark block as %s', (token, darkValue) => {
    expect(dark).toMatch(new RegExp(`${token}\\s*:\\s*${darkValue}\\s*;`, 'i'));
  });

  it('slices two non-empty, non-overlapping mode blocks', () => {
    expect(light.length).toBeGreaterThan(100);
    expect(dark.length).toBeGreaterThan(100);
    expect(dark).not.toContain('&.light-mode');
  });
});

const IN_SCOPE = [
  'Something2.jsx', 'TileTypesAdmin.jsx', 'EntityTypesAdmin.jsx',
  'ItemTypesAdmin.jsx', 'BiomesAdmin.jsx', 'MapsAdmin.jsx', 'MapGraphAdmin.jsx',
];

// Files not yet swept. Each sweep task deletes its own entry. Must reach [].
const PENDING = [
  'Something2.jsx', 'TileTypesAdmin.jsx', 'EntityTypesAdmin.jsx',
  'ItemTypesAdmin.jsx', 'MapsAdmin.jsx', 'MapGraphAdmin.jsx',
];

const read = (name) => readFileSync(
  fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8',
);

describe('offendingLiterals sentinel handling', () => {
  it('exempts a literal that the single-line sentinel names in parentheses', () => {
    const line = "  color: '#00ff00', // s2-theme-exempt(#00ff00): tile data default, not chrome";
    expect(offendingLiterals(line)).toEqual([]);
  });

  it('still reports a different literal on the same line the sentinel does not name', () => {
    const line = "  color: '#abc123', // s2-theme-exempt(#00ff00): unrelated note";
    expect(offendingLiterals(line)).toEqual(['#abc123']);
  });

  it('a bare sentinel with no parenthesised hex exempts nothing on that line', () => {
    const line = "  color: '#abc123', // s2-theme-exempt: unrelated note";
    expect(offendingLiterals(line)).toEqual(['#abc123']);
  });

  it('still exempts every literal inside a block-sentinel region', () => {
    const source = [
      '/* s2-theme-exempt:start — cytoscape renders to canvas, cannot read CSS vars */',
      "const GRAPH_STYLE = [{ 'background-color': '#23233f', 'line-color': '#4a9eff' }];",
      '/* s2-theme-exempt:end */',
    ].join('\n');
    expect(offendingLiterals(source)).toEqual([]);
  });
});

describe('Something2 admin theme gate', () => {
  const swept = IN_SCOPE.filter((f) => !PENDING.includes(f));

  it.each(swept)('%s has no untokenized colour literals', (file) => {
    expect(offendingLiterals(read(file))).toEqual([]);
  });

  // Reverse assertion: a PENDING file that is already clean means someone swept it
  // and forgot to remove it from the list — or misspelled a filename.
  it.each(PENDING)('%s is still pending and still dirty', (file) => {
    expect(offendingLiterals(read(file)).length).toBeGreaterThan(0);
  });

  it('every PENDING entry is a real in-scope file', () => {
    for (const file of PENDING) expect(IN_SCOPE).toContain(file);
  });

  it('has at least one swept file under the gate', () => {
    expect(swept.length).toBeGreaterThan(0);
  });
});
