import { describe, it, expect } from 'vitest';
import {
  buildPayload, validateClient, formFromType, emptyForm,
  isReservedItemType, RESERVED_ITEM_TYPE_NAMES, RESERVED_ITEM_CATEGORIES,
} from '../itemTypeForm.js';

// SOMET-284. SOMET-278 made the seeded `gold` row (category `currency`) safe:
// DELETE and any rename/recategorize PUT answer 409, while value/icon/sprite
// stay editable. But this form's category <select> only ever offered
// weapon/armor/ammo, so opening gold in ItemTypesAdmin could not produce a
// payload the API would take -- the row became protected AND uneditable.
//
// These pin the client mirror of the backend's reserved rule:
//   * a reserved row keeps its own category through validateClient +
//     buildPayload, untouched;
//   * `currency` is still refused on an ordinary row, because the API refuses
//     it there too -- the form must not offer an edit that can only fail.
//
// The mirror is deliberate and documented in itemTypeForm.js: GET
// /api/item-types is a bare `SELECT *` and exposes no `reserved` flag, so the
// client has no way to be told. If the backend's RESERVED_* constants change,
// these constants and this file change with them.

const GOLD = {
  id: 28,
  name: 'gold',
  category: 'currency',
  slot: null,
  kind: null,
  damage: 0,
  cooldown: 0,
  stackable: true,
  value: 0,
  defense: null,
  element: null,
  resistances: null,
  vfx: null,
};

describe('isReservedItemType (mirror of the backend predicate)', () => {
  it('matches the seeded gold row', () => {
    expect(isReservedItemType(GOLD)).toBe(true);
  });

  it('matches on EITHER the reserved name or the reserved category, like the backend', () => {
    // A currency row that was renamed out of band is still reserved...
    expect(isReservedItemType({ name: 'coin', category: 'currency' })).toBe(true);
    // ...and so is a row still named gold, whatever its category says.
    expect(isReservedItemType({ name: 'gold', category: 'weapon' })).toBe(true);
  });

  it('does not match ordinary catalog rows, and tolerates no row at all', () => {
    expect(isReservedItemType({ name: 'shortsword', category: 'weapon' })).toBe(false);
    expect(isReservedItemType({ name: 'plate', category: 'armor' })).toBe(false);
    expect(isReservedItemType(null)).toBe(false);
    expect(isReservedItemType(undefined)).toBe(false);
  });

  it('mirrors the backend constant sets exactly', () => {
    // Guards the drift this file exists to make visible: if backend/src/index.js
    // grows a reserved name or category, this fails until the client follows.
    expect(RESERVED_ITEM_TYPE_NAMES).toEqual(['gold']);
    expect(RESERVED_ITEM_CATEGORIES).toEqual(['currency']);
  });
});

describe('buildPayload for a reserved row', () => {
  it('preserves the stored category so the PUT round-trips instead of 409ing', () => {
    // HONEST NOTE: this assertion alone already held before SOMET-284 --
    // `base.category` has always been copied straight from form state and
    // formFromType keeps `currency`, so the category was never the field that
    // got coerced. It stays as a regression guard (a future refactor that
    // normalizes category here would 409 the gold row), but the assertion that
    // actually goes red on the pre-fix helper is the next one.
    const payload = buildPayload(formFromType(GOLD), GOLD);
    expect(payload.category).toBe('currency');
    expect(payload.name).toBe('gold');
  });

  it('does not fall through to the armor branch (no empty slot, no invented defense)', () => {
    // The armor branch sends `slot: f.slot` -- '' for gold -- which the backend
    // rejects with 400 "slot must be one of ...", since '' is not null.
    const payload = buildPayload(formFromType(GOLD), GOLD);
    expect(payload.slot).toBeNull();
    expect(payload.defense).toBeNull();
    expect(payload.kind).toBeNull();
    expect(payload.resistances).toEqual({});
  });

  it('still sends the admin\'s edited value and keeps gold stackable', () => {
    const form = { ...formFromType(GOLD), value: '5' };
    const payload = buildPayload(form, GOLD);
    expect(payload.value).toBe(5);
    expect(payload.stackable).toBe(true);
    expect(payload.category).toBe('currency');
  });

  it('round-trips the stored icon rather than blanking it', () => {
    // The editor shows no icon input, but the PUT writes `icon = b.icon ?? null`
    // unconditionally -- so an omitted icon is an ERASED icon. The ticket keeps
    // gold's icon editable; the form must at least not destroy it.
    const payload = buildPayload(formFromType({ ...GOLD, icon: 'gold-pile.png' }), GOLD);
    expect(payload.icon).toBe('gold-pile.png');
  });

  it('is keyed on the STORED row: without it the currency category is not preserved', () => {
    // The create path (existing = null) must be unaffected -- that is the same
    // keying the backend uses, where a body-keyed check would be bypassable.
    const payload = buildPayload({ ...emptyForm(), name: 'plate', category: 'armor', slot: 'chest', defense: '3' }, null);
    expect(payload.category).toBe('armor');
    expect(payload.slot).toBe('chest');
  });
});

describe('validateClient for a reserved row', () => {
  it('accepts a reserved row keeping its own category', () => {
    expect(validateClient(formFromType(GOLD), GOLD)).toBeNull();
  });

  it('is the stored row that unlocks it — the same form without it is still refused', () => {
    // Pins WHY it passes above rather than just that it passes: drop the
    // `existing` argument (what the form did before SOMET-284) and the very
    // same gold form is rejected before the request is ever sent.
    expect(validateClient(formFromType(GOLD))).toMatch(/category must be/);
  });

  it('still rejects `currency` on an ordinary row, which the API would refuse too', () => {
    const form = { ...emptyForm(), name: 'fake-coin', category: 'currency' };
    expect(validateClient(form, null)).toMatch(/category must be/);
    // ...and also when EDITING a non-reserved row: the relaxation is keyed on
    // what is stored, not on what the form claims.
    const stored = { id: 3, name: 'shortsword', category: 'weapon' };
    expect(validateClient(form, stored)).toMatch(/category must be/);
  });

  it('does not let a reserved row change to some other category', () => {
    // Recategorizing gold is a 409 on the server; the form must not pass it.
    const form = { ...formFromType(GOLD), category: 'armor', slot: '', defense: '' };
    expect(validateClient(form, GOLD)).toMatch(/armor needs slot and defense/);
  });

  it('still applies the shared checks to a reserved row (value stays validated)', () => {
    const form = { ...formFromType(GOLD), value: '-1' };
    expect(validateClient(form, GOLD)).toMatch(/value/i);
  });
});
