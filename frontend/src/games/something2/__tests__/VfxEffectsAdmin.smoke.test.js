import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Slice E (SOMET-162). vitest runs in a plain node environment here, so this
// component cannot be rendered -- the same constraint every other admin screen
// in this project is tested under. These are source-structure guards for the
// wiring that would otherwise go INERT silently.
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');
const admin = read('../VfxEffectsAdmin.jsx');
const hooks = read('../useVfxEffects.js');
const items = read('../ItemTypesAdmin.jsx');

describe('VFX admin screen', () => {
  it('renders the list, a create path and a delete', () => {
    expect(admin).toMatch(/useVfxEffectsAdmin\(\)/);
    expect(admin).toMatch(/useCreateVfxEffect/);
    expect(admin).toMatch(/useUpdateVfxEffect/);
    expect(admin).toMatch(/useDeleteVfxEffect/);
  });

  it('shows a LIVE preview that uses the real particle maths', () => {
    // "a tweak to duration/colour/particles is visible without entering a
    // world" is this item's DONE WHEN. A preview with its own private
    // animation would be a lie that looks like a feature: the author would
    // tune against something the game never draws.
    const preview = read('../vfxPreview.js');
    expect(preview).toMatch(/from '\.\/src\/js\/core\/vfx\.js'/);
    expect(preview).toMatch(/particlesAt\(/);
    expect(admin).toMatch(/drawVfxPreview\(/);
    // Re-armed on form change -- that is what makes it live rather than a
    // snapshot taken once at mount.
    expect(admin).toMatch(/\}, \[form\]\)/);
  });

  it('invalidates the SAME query key the running game reads', () => {
    // The whole "tunable without a deploy" claim rests on this one string. A
    // near-miss key would look right and leave the editor and the canvas
    // disagreeing until a reload.
    expect(hooks).toMatch(/VFX_QUERY_KEY = \["vfxEffects"\]/);
    const game = read('../useMaps.js');
    expect(game).toMatch(/queryKey: \['vfxEffects'\]/);
  });

  it('surfaces the bindings named in a 409 rather than a bare refusal', () => {
    // A 409 saying only "cannot delete" leaves the admin with no way to find
    // what is blocking them.
    expect(hooks).toMatch(/referencing_item_types/);
    expect(hooks).toMatch(/referencing_entity_types/);
    expect(hooks).toMatch(/still bound by/);
  });
});

describe('binding dropdowns', () => {
  it('the Items admin binds via a SELECT, never free text', () => {
    // The agreed mitigation for jsonb bindings having no FK: a typed name that
    // does not exist resolves to nothing and the weapon silently draws the
    // kind default forever.
    expect(items).toMatch(/VFX_MOMENTS\.map/);
    expect(items).toMatch(/vfxEffects\.map\(fx =>/);
    expect(items).toMatch(/<option key=\{fx\.name\} value=\{fx\.name\}>/);
  });

  it('offers an explicit way to UNBIND', () => {
    // Without a "none" option the only way to remove a binding is raw SQL.
    expect(items).toMatch(/\(kind default\)/);
  });

  it('reads the live library rather than a hardcoded list', () => {
    expect(items).toMatch(/useVfxEffects\(\)/);
  });
});
