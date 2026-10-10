import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toggleAura, missingAuras, aurasForPayload, danglingAuras } from '../entityAuras.js';

describe('entity aura picker helpers', () => {
  it('toggling onto a never-authored (null) list starts a list', () => {
    expect(toggleAura(null, 'pack_leader')).toEqual(['pack_leader']);
  });
  it('toggling the last aura off leaves [] (an explicit removal), never null', () => {
    expect(toggleAura(['pack_leader'], 'pack_leader')).toEqual([]);
  });
  it('preserves order and never duplicates', () => {
    expect(toggleAura(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(toggleAura(['a', 'b'], 'a')).toEqual(['b']);
  });
  it('names a bound aura that no longer exists in the library', () => {
    expect(missingAuras(['pack_leader', 'ghost'], [{ name: 'pack_leader' }])).toEqual(['ghost']);
    expect(missingAuras(null, [])).toEqual([]);
  });
  it('payload keeps null as null and [] as []', () => {
    expect(aurasForPayload({ auras: null })).toBeNull();
    expect(aurasForPayload({ auras: [] })).toEqual([]);
  });
  it('payload keeps the existing binding when the picker never loaded or was touched', () => {
    expect(aurasForPayload({ auras: ['pack_leader'], name: 'x' })).toEqual(['pack_leader']);
    expect(aurasForPayload({ name: 'x' })).toBeNull();
  });
  it('flags no dangling names while the library is still loading', () => {
    expect(danglingAuras(['pack_leader'], [], true)).toEqual([]);
    expect(danglingAuras(['pack_leader'], [], false)).toEqual(['pack_leader']);
  });
});

describe('EntityTypesAdmin wiring', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(dir, '../EntityTypesAdmin.jsx'), 'utf8');
  const picker = fs.readFileSync(path.join(dir, '../EntityAuraPicker.jsx'), 'utf8');
  it('binds auras from the LIBRARY (checkboxes over fetched names), never free text', () => {
    expect(src).toMatch(/useAuraEffectsAdmin\(\)/);
    expect(src).toMatch(/toggleAura\(/);
    expect(src).not.toMatch(/<input[^>]*value=\{formData\.auras/);
    expect(picker).toMatch(/type="checkbox"/);
  });
  it('carries the stored value into the edit form (null survives as null)', () => {
    expect(src).toMatch(/auras: editingEntity\.auras \?\? null/);
  });
  it('submits auras', () => {
    expect(src).toMatch(/auras: aurasForPayload\(formData\)/);
  });
  it('the picker hides dangling warnings while loading and offers Remove', () => {
    expect(picker).toMatch(/danglingAuras\(/);
    expect(picker).toMatch(/Remove/);
    expect(picker).toMatch(/not in the library/);
  });
});
