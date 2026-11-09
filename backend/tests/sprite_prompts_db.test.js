const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const sp = require('../src/services/spritePrompts.js');
const desc = require('../src/services/artPromptDescriptions.js');

// The Sprite tab's prompt lane. What matters is which prompt comes OUT for a
// subject: a creature never touched from the Sprite tab must keep today's
// template even when the art console has described it; a creature opted in
// from the Sprite tab follows its active description, whichever tool wrote it.

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

const fake = () => {
  const calls = [];
  return {
    calls,
    describeSubject: async (_db, s, opts) => { calls.push({ s, opts }); return { text: `new ${s.kind}`, model: 'stub' }; },
  };
};

let pool;
let boltColor = null;
const wipe = async () => {
  await pool.query("DELETE FROM art_prompt_descriptions WHERE subject_key LIKE 'sx_sp_%'");
  await pool.query("DELETE FROM art_prompt_descriptions WHERE subject_kind IN ('vfx','aura') AND subject_key IN ('bolt_fire','shade_veil')");
};
test.before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: url, max: 4 });
  await wipe();
  await pool.query("DELETE FROM entity_types WHERE name LIKE 'sx_sp_%'");
  for (const [name, prompt] of [['sx_sp_wolf', 'grey wolf'], ['sx_sp_bat', ''], ['sx_sp_ogre', 'big ogre']]) {
    await pool.query(
      "INSERT INTO entity_types (name, color, is_creature, prompt) VALUES ($1, '#123456', true, $2)", [name, prompt]);
  }
  const { rows } = await pool.query("SELECT color FROM vfx_effects WHERE name = 'bolt_fire'");
  boltColor = rows[0] ? rows[0].color : null;
  if (boltColor) await pool.query("UPDATE vfx_effects SET color = '#ff7a1a' WHERE name = 'bolt_fire'");
});
test.after(async () => {
  if (skip) return;
  await wipe();
  await pool.query("DELETE FROM entity_types WHERE name LIKE 'sx_sp_%'");
  if (boltColor) await pool.query('UPDATE vfx_effects SET color = $1 WHERE name = $2', [boltColor, 'bolt_fire']);
  await pool.end();
});

const templates = () => new Map([['sx_sp_wolf', 'grey wolf'], ['sx_sp_bat', 'sx_sp_bat'], ['sx_sp_ogre', 'big ogre']]);

test('a never-opted-in entity with an art-console description keeps its template sprite prompt', { skip }, async () => {
  await wipe();
  await desc.replace(pool, 'entity', 'sx_sp_wolf', { text: 'console wolf', model: 'm' });
  const out = await sp.spritePromptsFor(pool, 'entity', templates());
  assert.deepEqual(out.get('sx_sp_wolf'), { prompt: 'grey wolf', source: 'template', descriptionId: null, origin: null });
  assert.equal(out.get('sx_sp_bat').source, 'template');
  assert.equal(out.size, 3);
});

test('a Sprite-tab description becomes the entity\'s sprite prompt; revert returns the template', { skip }, async () => {
  await wipe();
  const row = await sp.savePrompt(pool, 'entity', 'sx_sp_wolf', '  lean grey wolf with amber eyes  ');
  assert.equal(row.text, 'lean grey wolf with amber eyes');
  assert.equal(row.origin, 'sprite');
  assert.equal(row.model, null);
  assert.equal(row.source_prompt, 'grey wolf');
  let out = await sp.spritePromptsFor(pool, 'entity', templates());
  assert.deepEqual(out.get('sx_sp_wolf'),
    { prompt: 'lean grey wolf with amber eyes', source: 'sprite', descriptionId: row.id, origin: 'sprite' });
  assert.equal(out.get('sx_sp_ogre').source, 'template');

  assert.deepEqual(await sp.revertPrompt(pool, 'entity', 'sx_sp_wolf'), { cleared: true });
  out = await sp.spritePromptsFor(pool, 'entity', templates());
  assert.equal(out.get('sx_sp_wolf').prompt, 'grey wolf');
  assert.equal(out.get('sx_sp_wolf').source, 'template');
  assert.deepEqual(await sp.revertPrompt(pool, 'entity', 'sx_sp_wolf'), { cleared: false, reason: 'none' });
});

// CONTROLLER RULING: once opted in, the sprite lane follows the ACTIVE
// description whichever tool wrote it.
test('an opted-in entity whose newest active version is from the art console uses that text', { skip }, async () => {
  await wipe();
  await sp.savePrompt(pool, 'entity', 'sx_sp_wolf', 'sprite wolf');
  const consoleRow = await desc.replace(pool, 'entity', 'sx_sp_wolf', { text: 'console wolf', model: 'm' });
  const out = await sp.spritePromptsFor(pool, 'entity', templates());
  assert.deepEqual(out.get('sx_sp_wolf'),
    { prompt: 'console wolf', source: 'sprite', descriptionId: consoleRow.id, origin: null });
  // And revert does not clear the art console's version.
  assert.deepEqual(await sp.revertPrompt(pool, 'entity', 'sx_sp_wolf'), { cleared: false, reason: 'not-sprite' });
  assert.equal((await desc.getActive(pool, 'entity', 'sx_sp_wolf')).id, consoleRow.id);
});

test('an opted-in entity follows its sprite-origin version', { skip }, async () => {
  await wipe();
  await desc.replace(pool, 'entity', 'sx_sp_ogre', { text: 'console ogre', model: 'm' });
  const row = await sp.savePrompt(pool, 'entity', 'sx_sp_ogre', 'sprite ogre');
  const out = await sp.spritePromptsFor(pool, 'entity', templates());
  assert.equal(out.get('sx_sp_ogre').prompt, 'sprite ogre');
  assert.equal(out.get('sx_sp_ogre').descriptionId, row.id);
});

test('an effect uses its active vfx/aura description, else the template default', { skip }, async () => {
  await wipe();
  const tpl = new Map([['bolt_fire', 'bolt fire, orange'], ['bolt_ice', 'bolt ice, ice blue']]);
  // Effects take any active text, whatever its origin.
  const row = await desc.replace(pool, 'vfx', 'bolt_fire', { text: 'spinning ember bolt', model: 'm' });
  const out = await sp.spritePromptsFor(pool, 'vfx', tpl);
  assert.deepEqual(out.get('bolt_fire'), { prompt: 'spinning ember bolt', source: 'sprite', descriptionId: row.id, origin: null });
  assert.deepEqual(out.get('bolt_ice'), { prompt: 'bolt ice, ice blue', source: 'template', descriptionId: null, origin: null });
});

test('regeneratePrompt writes a new active version with origin sprite and keeps the old one', { skip }, async () => {
  await wipe();
  const d = fake();
  await sp.savePrompt(pool, 'entity', 'sx_sp_wolf', 'first wolf');
  const out = await sp.regeneratePrompt(pool, 'entity', 'sx_sp_wolf', { describer: d });
  assert.deepEqual(out, { text: 'new entity', model: 'stub' });
  assert.deepEqual(d.calls[0].opts, { length: 'medium', boxOnly: true });
  const all = await desc.listAll(pool, 'entity', 'sx_sp_wolf');
  assert.equal(all.length, 2);
  assert.equal(all[0].text, 'new entity');
  assert.equal(all[0].active, true);
  assert.equal(all[0].origin, 'sprite');
  assert.equal(all[0].model, 'stub');
  assert.equal(all[0].length, 'medium');
  assert.equal(all[0].source_prompt, 'grey wolf');
  assert.equal(all[1].text, 'first wolf');
  assert.equal(all[1].active, false);
});

test('regeneratePrompt gives the describer the effect subject', { skip }, async () => {
  await wipe();
  const d = fake();
  await sp.regeneratePrompt(pool, 'vfx', 'bolt_fire', { describer: d });
  const s = d.calls[0].s;
  assert.equal(s.kind, 'vfx');
  assert.equal(s.key, 'bolt_fire');
  assert.equal(s.name, 'bolt_fire');
  assert.equal(s.row.type, 'projectile');
  assert.equal(s.basePrompt, 'bolt fire, orange');
  const active = await desc.getActive(pool, 'vfx', 'bolt_fire');
  assert.equal(active.text, 'new vfx');
  assert.equal(active.origin, 'sprite');
  assert.equal(active.source_prompt, 'bolt fire, orange');
});

test('regeneratePrompt passes describer errors through unchanged, busy included', { skip }, async () => {
  await wipe();
  const err = Object.assign(new Error('switching'), { busy: true });
  await assert.rejects(
    sp.regeneratePrompt(pool, 'entity', 'sx_sp_wolf', { describer: { describeSubject: async () => { throw err; } } }),
    (e) => e === err && e.busy === true);
  assert.equal((await desc.listAll(pool, 'entity', 'sx_sp_wolf')).length, 0);
});

test('savePrompt refuses blank and 401-char text with "prompt must be 1-400 characters" and writes nothing', { skip }, async () => {
  await wipe();
  for (const text of ['   ', '', 'x'.repeat(401), null]) {
    await assert.rejects(sp.savePrompt(pool, 'entity', 'sx_sp_wolf', text),
      (e) => e.status === 400 && e.message === 'prompt must be 1-400 characters');
  }
  assert.equal((await desc.listAll(pool, 'entity', 'sx_sp_wolf')).length, 0);
  // 400 exactly is kept whole, never truncated.
  const row = await sp.savePrompt(pool, 'entity', 'sx_sp_wolf', 'y'.repeat(400));
  assert.equal(row.text.length, 400);
});

test('revertPrompt leaves an art-console description alone (not-sprite)', { skip }, async () => {
  await wipe();
  const row = await desc.replace(pool, 'entity', 'sx_sp_bat', { text: 'console bat', model: 'm' });
  assert.deepEqual(await sp.revertPrompt(pool, 'entity', 'sx_sp_bat'), { cleared: false, reason: 'not-sprite' });
  assert.equal((await desc.getActive(pool, 'entity', 'sx_sp_bat')).id, row.id);
});

test('regeneratePrompt for an unknown subject is a 404; an unknown kind is a 400', { skip }, async () => {
  const d = fake();
  await assert.rejects(sp.regeneratePrompt(pool, 'entity', 'sx_sp_nobody', { describer: d }), (e) => e.status === 404);
  await assert.rejects(sp.regeneratePrompt(pool, 'vfx', 'sx_sp_nobolt', { describer: d }), (e) => e.status === 404);
  await assert.rejects(sp.regeneratePrompt(pool, 'item', 'sword', { describer: d }), (e) => e.status === 400);
  await assert.rejects(sp.savePrompt(pool, 'entity', 'sx_sp_nobody', 'a thing'), (e) => e.status === 404);
  assert.equal(d.calls.length, 0);
});

test('promptSubjectOf: a creature row is an entity, an appearance row is character_appearance', () => {
  assert.deepEqual(sp.promptSubjectOf({ creature: 'wolf', appearance_variant: null }), { kind: 'entity', key: 'wolf' });
  assert.deepEqual(sp.promptSubjectOf({ creature: 'Mage:2', appearance_variant: 2 }), { kind: 'character_appearance', key: 'Mage:2' });
  assert.deepEqual(sp.PROMPT_KINDS, ['entity', 'character_appearance', 'vfx', 'aura']);
});
