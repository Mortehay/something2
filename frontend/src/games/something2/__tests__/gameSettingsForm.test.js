import { describe, it, expect } from 'vitest';
import { SETTING_FIELDS, parseSettingInput } from '../gameSettingsForm.js';

describe('SETTING_FIELDS', () => {
  it('describes the keys the backend whitelists, in editor order', () => {
    expect(SETTING_FIELDS.map((f) => f.key)).toEqual([
      'passive_points_per_level',
      'ground_item_ttl_seconds',
      'respec_base_gold',
      'rarity_weights',
      'amber_max_seconds',
      'amber_after_ready_seconds',
    ]);
  });

  it('gives every field a label, a kind and a hint', () => {
    for (const f of SETTING_FIELDS) {
      expect(f.label, `${f.key} label`).toBeTruthy();
      expect(['integer', 'json'], `${f.key} kind`).toContain(f.kind);
      expect(f.hint, `${f.key} hint`).toBeTruthy();
    }
  });
});

describe('parseSettingInput', () => {
  it('turns an integer field\'s string input into a number', () => {
    expect(parseSettingInput('passive_points_per_level', '3')).toEqual({ value: 3 });
    expect(parseSettingInput('ground_item_ttl_seconds', '180')).toEqual({ value: 180 });
  });

  it('rejects a non-integer, a negative and an empty integer input', () => {
    expect(parseSettingInput('passive_points_per_level', '1.5').error).toMatch(/whole number/);
    expect(parseSettingInput('passive_points_per_level', '-1').error).toMatch(/0 or more/);
    expect(parseSettingInput('ground_item_ttl_seconds', '0').error).toMatch(/1 or more/);
    expect(parseSettingInput('passive_points_per_level', '').error).toMatch(/whole number/);
    expect(parseSettingInput('passive_points_per_level', 'three').error).toMatch(/whole number/);
  });

  it('parses a json field and reports the parse error verbatim', () => {
    const good = '[{"item_level":1,"white":90,"blue":9,"yellow":1,"foxy":0}]';
    expect(parseSettingInput('rarity_weights', good)).toEqual({
      value: [{ item_level: 1, white: 90, blue: 9, yellow: 1, foxy: 0 }],
    });
    expect(parseSettingInput('rarity_weights', '[{').error).toMatch(/not valid JSON/);
  });

  it('rejects an unknown key rather than passing it through to the server', () => {
    expect(parseSettingInput('passive_points_per_lvl', '1').error).toMatch(/unknown setting/);
  });
});

// Amber Stance final review I3: the two timing settings are editable, with the
// backend's ranges (services/gameSettings.js assertValid).
describe('Amber Stance settings', () => {
  it('amber_max_seconds accepts 1..300', () => {
    expect(parseSettingInput('amber_max_seconds', '1')).toEqual({ value: 1 });
    expect(parseSettingInput('amber_max_seconds', ' 30 ')).toEqual({ value: 30 });
    expect(parseSettingInput('amber_max_seconds', '300')).toEqual({ value: 300 });
    expect(parseSettingInput('amber_max_seconds', '0').error).toMatch(/1 or more/);
    expect(parseSettingInput('amber_max_seconds', '301').error).toMatch(/300 or less/);
    expect(parseSettingInput('amber_max_seconds', '2.5').error).toMatch(/whole number/);
  });

  it('amber_after_ready_seconds accepts 0..300', () => {
    expect(parseSettingInput('amber_after_ready_seconds', '0')).toEqual({ value: 0 });
    expect(parseSettingInput('amber_after_ready_seconds', '10')).toEqual({ value: 10 });
    expect(parseSettingInput('amber_after_ready_seconds', '300')).toEqual({ value: 300 });
    expect(parseSettingInput('amber_after_ready_seconds', '-1').error).toMatch(/0 or more/);
    expect(parseSettingInput('amber_after_ready_seconds', '301').error).toMatch(/300 or less/);
  });

  it('both are integer fields whose hint says when a change takes effect', () => {
    for (const key of ['amber_max_seconds', 'amber_after_ready_seconds']) {
      const f = SETTING_FIELDS.find((x) => x.key === key);
      expect(f.kind).toBe('integer');
      expect(f.max).toBe(300);
      expect(f.hint).toMatch(/30 s/);
    }
  });
});
