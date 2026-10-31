import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A relative import WITHOUT an extension is resolved by trying .js, .jsx, ... in
// order against a filesystem that may ignore case. When two files differ only by
// case (PlayerWorldMap.jsx / playerWorldMap.js), the import can land on the wrong
// one on Windows and macOS while working on Linux: the World Map tab rendered a
// function that is not a component and the page stayed blank, with no error.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe('imports that could resolve to a case-colliding file', () => {
  const files = walk(SRC);
  const byStem = new Map(); // lower-cased path without extension -> real files
  for (const f of files) {
    const stem = f.replace(/\.(js|jsx)$/, '').toLowerCase();
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(f);
  }
  const colliding = new Set([...byStem.values()].filter((v) => v.length > 1).flat());

  it('finds the known colliding pairs (so this test cannot silently pass over nothing)', () => {
    const names = [...colliding].map((f) => path.basename(f));
    expect(names).toEqual(expect.arrayContaining(['PlayerWorldMap.jsx', 'playerWorldMap.js']));
  });

  it('no relative import omits the extension when its target has a case twin', () => {
    const bad = [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        const spec = m[1];
        if (/\.(js|jsx|css|json|svg|png|mjs)$/.test(spec)) continue;
        const target = path.resolve(path.dirname(f), spec).toLowerCase();
        if (byStem.get(target) && byStem.get(target).length > 1) bad.push(`${path.relative(SRC, f)} imports "${spec}"`);
      }
    }
    expect(bad).toEqual([]);
  });
});
