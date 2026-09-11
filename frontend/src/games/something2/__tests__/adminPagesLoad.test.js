import { describe, it, expect } from 'vitest';

// SOMET-557. Every *Admin.jsx page must at least parse and export a component.
//
// Why this exists: adding the shared loading spinner touched all 13 admin pages,
// and a bad import placement broke four of them. The suite caught only two --
// ArtConsoleAdmin, EntityTypesAdmin and SettingsAdmin had no smoke test at all,
// so three files that could not even be transformed went green. Per-page smoke
// files only cover the pages someone remembered to write one for, which is
// exactly the set that fails to include a newly added page.
//
// import.meta.glob with eager:true resolves at build time and imports every
// match, so a new *Admin.jsx is covered the day it lands with nothing to
// register. A file that fails to parse throws during collection and fails this
// file rather than passing silently.
const pages = import.meta.glob('../*Admin.jsx', { eager: true });

describe('admin pages', () => {
  it('finds every *Admin.jsx page', () => {
    // Guards the glob itself: a pattern that stops matching would make every
    // assertion below vacuous by iterating an empty object. 13 at the time of
    // writing; >= so adding a page does not fail the suite.
    expect(Object.keys(pages).length).toBeGreaterThanOrEqual(13);
  });

  for (const [path, mod] of Object.entries(pages)) {
    const name = path.split('/').pop();

    it(`${name} exports a component as its default`, () => {
      expect(mod.default, `${name} has no default export`).toBeTypeOf('function');
    });
  }
});
