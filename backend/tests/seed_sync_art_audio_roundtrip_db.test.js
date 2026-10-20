const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { Pool } = require('pg');
const { withSeedSyncLock, cleanupSx, makeTempSyncDir } = require('./helpers/seedSyncTest.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

const { getGroup, tableSpecs } = require('../src/services/seedSync/registry.js');
const { exportGroup, fileFor } = require('../src/services/seedSync/exportGroup.js');
const { diffGroup } = require('../src/services/seedSync/diffGroup.js');
const { previewSeed, applySeed } = require('../src/services/seedSync/applySeed.js');
const { stableStringify } = require('../src/services/seedSync/canonical.js');
const { encodeRGBA } = require('../src/services/pngTrim.js');

// SOMET-640 plan 3 Task 4: the real Art and Audio groups on the scratch DB,
// with a fake object store and temp sync / assets roots. Fixture rows are
// sx_aa*; the real groups' baselines are snapshotted and restored exactly and
// their runs deleted by watermark (seed_sync_groups_roundtrip_db pattern).
const BINARY = ['art', 'audio'];
const BUCKET = 'sxb';

const baselinesOf = async (pool) => (await pool.query(
  `SELECT group_id, sync_uuid::text AS sync_uuid, hash FROM seed_row_hashes
    WHERE group_id = ANY($1::text[]) ORDER BY group_id, sync_uuid`, [BINARY])).rows;

async function restoreBaselines(pool, snapshot) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM seed_row_hashes WHERE group_id = ANY($1::text[])', [BINARY]);
    if (snapshot.length) {
      await client.query(
        `INSERT INTO seed_row_hashes (group_id, sync_uuid, hash)
         SELECT * FROM unnest($1::text[], $2::uuid[], $3::text[])`,
        [snapshot.map((r) => r.group_id), snapshot.map((r) => r.sync_uuid), snapshot.map((r) => r.hash)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const cleanupCache = (pool) => pool.query("DELETE FROM seed_asset_hashes WHERE object_key LIKE 'sx%'");

function dbTest(name, body) {
  test(name, async (t) => {
    if (!process.env.TEST_DATABASE_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (seed_sync art/audio)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const dir = makeTempSyncDir();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-art-audio-'));
    const prev = { dir: process.env.SEED_SYNC_DIR, root: process.env.SEED_ASSETS_ROOT };
    process.env.SEED_SYNC_DIR = dir;
    process.env.SEED_ASSETS_ROOT = root;
    const pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    t.after(async () => {
      for (const [k, v] of [['SEED_SYNC_DIR', prev.dir], ['SEED_ASSETS_ROOT', prev.root]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
      await pool.end().catch(() => {});
    });
    await withSeedSyncLock(pool, async () => {
      await cleanupSx(pool);
      await cleanupCache(pool);
      const snapshot = await baselinesOf(pool);
      const watermark = (await pool.query('SELECT coalesce(max(id), 0)::int AS m FROM seed_export_runs')).rows[0].m;
      let failure = null;
      try { await body(t, pool, { root, store: fakeStore() }); } catch (e) { failure = e; } finally {
        await cleanupSx(pool).catch(() => {});
        await cleanupCache(pool).catch(() => {});
        await pool.query('DELETE FROM seed_export_runs WHERE id > $1 AND group_id = ANY($2::text[])', [watermark, BINARY])
          .catch(() => {});
        await restoreBaselines(pool, snapshot);
      }
      if (failure) throw failure;
      assert.deepStrictEqual(await baselinesOf(pool), snapshot, 'real baselines restored exactly');
    });
  });
}

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
function png(w, h, rgba) {
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set(rgba, i * 4);
  return encodeRGBA(w, h, px);
}
const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

const TILE = png(8, 8, [10, 200, 10, 255]);
const ATLAS = png(16, 8, [200, 10, 10, 255]);
const MANIFEST = Buffer.from('{"frames":{"idle":2}}\n');
const ICON = png(512, 512, [10, 10, 200, 255]);
const SKILL = png(300, 200, [120, 120, 0, 255]);
const LOOK = png(6, 6, [0, 120, 120, 255]);
const LOOK_ATLAS = png(12, 6, [0, 60, 120, 255]);
const LOOK_MANIFEST = Buffer.from('{"frames":{"idle":3}}\n');
const HIT = Buffer.from('OggS sx hit');
const THEME = Buffer.from('OggS sx theme');
const SPRITE = { atlas_key: 'sx/atlas.png', manifest_key: 'sx/man.json', static_frame: 0, frames: { idle: 2 } };
const SOURCE = {
  'sx/tile.png': TILE, 'sx/atlas.png': ATLAS, 'sx/man.json': MANIFEST, 'sx/icon.png': ICON, 'sx/skill.png': SKILL,
  'sx/look.png': LOOK, 'sx/look_atlas.png': LOOK_ATLAS, 'sx/look_man.json': LOOK_MANIFEST, 'sx/hit.ogg': HIT, 'sx/theme.ogg': THEME,
};

// Fake object store (art_seed_policy.test.js pattern).
function fakeStore(initial = SOURCE) {
  const objects = new Map(Object.entries(initial));
  const store = {
    objects,
    gets: 0,
    puts: [],
    BUCKET: () => BUCKET,
    async ensureBucket() {},
    async getObjectStream(key) {
      store.gets += 1;
      if (!objects.has(key)) {
        const e = new Error(`The specified key does not exist: ${key}`);
        e.code = 'NoSuchKey';
        throw e;
      }
      return Readable.from([objects.get(key)]);
    },
    async putObject(key, buffer, contentType) {
      store.puts.push({ key, buffer, contentType });
      objects.set(key, buffer);
      return key;
    },
    async objectExists(key) { return objects.has(key); },
  };
  return store;
}

const one = async (pool, sql, params) => (await pool.query(sql, params)).rows[0];
const readDoc = (groupId) => JSON.parse(fs.readFileSync(fileFor(groupId), 'utf8'));
function writeDoc(groupId, doc) {
  for (const [tbl, rows] of Object.entries(doc.tables)) doc.header.row_counts[tbl] = rows.length;
  fs.writeFileSync(fileFor(groupId), `${stableStringify(doc)}\n`);
}

// Owner rows (data groups) of the art slices, with their art columns at the
// defaults a data-group seed leaves them: what a fresh PC has.
async function makeOwners(pool, uuids = {}) {
  const ins = async (sql, key, params) => (await one(pool, sql, [uuids[key] || null, ...params])).sync_uuid;
  return {
    tile: await ins(`INSERT INTO tile_types (name, color, sync_uuid) VALUES ('sx_aa_tile', '#111111', coalesce($1, gen_random_uuid()))
      RETURNING sync_uuid`, 'tile', []),
    ent: await ins(`INSERT INTO entity_types (name, color, sync_uuid) VALUES ('sx_aa_ent', '#222222', coalesce($1, gen_random_uuid()))
      RETURNING sync_uuid`, 'ent', []),
    item: await ins(`INSERT INTO item_types (name, category, damage, cooldown, sync_uuid)
      VALUES ('sx_aa_item', 'currency', 0, 0, coalesce($1, gen_random_uuid())) RETURNING sync_uuid`, 'item', []),
  };
}

// The whole fixture: slice art on the owners, every art table, two bound
// clips (binding + prompt) and one unbound clip.
async function seedFixture(pool) {
  const owners = await makeOwners(pool);
  await pool.query("UPDATE tile_types SET image = 'sx/tile.png', render_mode = 'image' WHERE name = 'sx_aa_tile'");
  await pool.query(`UPDATE entity_types SET sprite = $1, render_mode = 'animated', display_width = 48, display_height = 64,
    prompt = 'sx a walking test' WHERE name = 'sx_aa_ent'`, [JSON.stringify(SPRITE)]);
  await pool.query("UPDATE item_types SET icon = 'sx/icon.png' WHERE name = 'sx_aa_item'");
  await pool.query("INSERT INTO catalog_art (subject_kind, subject_key, image) VALUES ('skill', 'sx_aa_skill', 'sx/skill.png')");
  // Two versions: only the active one travels; both share one sync_uuid.
  await pool.query(`INSERT INTO art_prompt_descriptions (subject_kind, subject_key, text, model)
    VALUES ('item', 'sx_aa_item', 'sx first take', 'm1')`);
  await pool.query("UPDATE art_prompt_descriptions SET active = false WHERE subject_key = 'sx_aa_item'");
  await pool.query(`INSERT INTO art_prompt_descriptions (subject_kind, subject_key, text, model)
    VALUES ('item', 'sx_aa_item', 'sx second take', 'm2')`);
  await pool.query(`INSERT INTO art_prompt_notes (subject_kind, subject_key, kind, note, region)
    VALUES ('item', 'sx_aa_item', 'avoid', 'sx no red', '{"x":1,"y":2}'::jsonb)`);
  await pool.query(`INSERT INTO character_appearances (entity_type_id, variant, label, image, sprite, render_mode)
    SELECT id, 1, 'sx look', 'sx/look.png', $1::jsonb, 'static' FROM entity_types WHERE name = 'sx_aa_ent'`,
  [JSON.stringify({ atlas_key: 'sx/look_atlas.png', manifest_key: 'sx/look_man.json', static_frame: 0, frames: { idle: 3 } })]);
  const clip = async (kind, label, key, bytes) => (await one(pool,
    `INSERT INTO audio_clips (kind, label, storage_key, bytes, duration_ms, source, sha1)
     VALUES ($1, $2, $3, $4, 1200, 'generated', $5) RETURNING id`,
    [kind, label, key, bytes ? bytes.length : 1, bytes ? sha1(bytes) : sha1(Buffer.from(label))])).id;
  const hit = await clip('sfx', 'sx_aa_hit', 'sx/hit.ogg', HIT);
  const theme = await clip('music', 'sx_aa_theme', 'sx/theme.ogg', THEME);
  await clip('sfx', 'sx_aa_loose', 'sx/loose.ogg', null); // unbound: never exported (not even in the store)
  await pool.query(`INSERT INTO audio_bindings (subject_kind, subject_key, slot, clip_id, volume) VALUES
    ('entity', 'sx_aa_ent', 'hit', $1, 0.5), ('world', 'sx_aa_world', 'music', $2, 1)`, [hit, theme]);
  await pool.query(`INSERT INTO audio_prompts (subject_kind, subject_key, slot, text, style)
    VALUES ('entity', 'sx_aa_ent', 'hit', 'sx a thud', 'dry')`);
  return owners;
}

// Repo files every asset value of `doc` references.
function filesOf(groupId, doc) {
  const out = new Set();
  for (const spec of tableSpecs(getGroup(groupId))) {
    for (const row of doc.tables[spec.table]) {
      for (const col of Object.keys(spec.assets || {})) {
        const v = row[col];
        if (!v || typeof v !== 'object') continue;
        if (v.file) out.add(v.file);
        for (const k of ['atlas', 'manifest']) if (v[k] && v[k].file) out.add(v[k].file);
      }
    }
  }
  return [...out].sort();
}

// Take git for every listed row (each must allow it).
async function seedAllGit(pool, groupId, store) {
  const p = await previewSeed(pool, groupId);
  const decisions = {};
  for (const r of p.rows) {
    // Every git file is on disk and matches: nothing blocked, git offered.
    assert.strictEqual(r.blockedReason, null, `${groupId} ${r.table} ${r.key} ${r.kind}`);
    assert.ok(r.allowedDecisions.includes('git'), `${groupId} ${r.table} ${r.key} ${r.kind}`);
    decisions[r.syncUuid] = 'git';
  }
  return { preview: p, result: await applySeed(pool, groupId, decisions, { signature: p.signature, store }) };
}

// A fresh PC: none of the fixture's art/audio rows, its owner rows re-created
// (same sync_uuids, new local ids, default art columns), no baselines or
// cache entries for them, an empty store. The git files and repo files stay.
async function wipeLocally(pool, owners) {
  const mine = (await pool.query(`
    SELECT sync_uuid FROM catalog_art WHERE subject_key LIKE 'sx\\_aa%'
    UNION ALL SELECT sync_uuid FROM art_prompt_descriptions WHERE subject_key LIKE 'sx\\_aa%'
    UNION ALL SELECT sync_uuid FROM art_prompt_notes WHERE subject_key LIKE 'sx\\_aa%'
    UNION ALL SELECT a.sync_uuid FROM character_appearances a JOIN entity_types e ON e.id = a.entity_type_id
      WHERE e.name LIKE 'sx\\_aa%'
    UNION ALL SELECT sync_uuid FROM audio_clips WHERE label LIKE 'sx\\_aa%'
    UNION ALL SELECT sync_uuid FROM audio_bindings WHERE subject_key LIKE 'sx\\_aa%'
    UNION ALL SELECT sync_uuid FROM audio_prompts WHERE subject_key LIKE 'sx\\_aa%'`)).rows.map((r) => r.sync_uuid);
  await cleanupSx(pool); // every sx_ row, owners included
  await cleanupCache(pool);
  await pool.query('DELETE FROM seed_row_hashes WHERE sync_uuid = ANY($1::uuid[])', [[...mine, ...Object.values(owners)]]);
  await makeOwners(pool, owners);
}

dbTest('art and audio round trip byte-identical', async (t, pool, { root, store }) => {
  const owners = await seedFixture(pool);
  const first = {};
  const files = new Map();
  for (const g of BINARY) {
    await exportGroup(pool, g, { store });
    first[g] = readDoc(g);
    for (const f of filesOf(g, first[g])) files.set(f, fs.readFileSync(path.join(root, f)));
  }
  const art = first.art.tables;
  const audio = first.audio.tables;

  // What travelled, where.
  const tile = art.tile_types.find((r) => r.name === 'sx_aa_tile');
  assert.deepStrictEqual(Object.keys(tile).sort(), ['image', 'name', 'render_mode', 'sprite', 'sync_uuid']);
  assert.strictEqual(tile.image.file, 'textures/tiles/sx_aa_tile.png');
  const ent = art.entity_types.find((r) => r.name === 'sx_aa_ent');
  assert.strictEqual(ent.sprite.atlas.file, 'textures/sprites/entity_types/sx_aa_ent.atlas.png');
  assert.strictEqual(ent.sprite.manifest.file, 'textures/sprites/entity_types/sx_aa_ent.manifest.json');
  assert.deepStrictEqual([ent.display_width, ent.display_height, ent.render_mode], [48, 64, 'animated']);
  const icon = art.item_types.find((r) => r.name === 'sx_aa_item').icon.file;
  assert.strictEqual(icon, 'textures/items/sx_aa_item.png');
  assert.deepStrictEqual(pngSize(files.get(icon)), { w: 256, h: 256 }, 'item icon capped at 256 px');
  const skill = art.catalog_art.find((r) => r.subject_key === 'sx_aa_skill').image.file;
  // I-3: catalog art is named by subject_key alone (each kind has its own
  // dir), like the legacy exporter -- never 'skill_<key>'.
  assert.strictEqual(skill, 'textures/skills/sx_aa_skill.png');
  assert.ok(Math.max(pngSize(files.get(skill)).w, pngSize(files.get(skill)).h) <= 256, 'skill art capped');
  const look = art.character_appearances.find((r) => r.label === 'sx look');
  assert.strictEqual(look.entity_type_id, owners.ent, 'appearance ref travels as the entity uuid');
  // SOMET-647: '<class name>_<variant>.png' like the legacy Archer_1.png,
  // never '<entity sync_uuid>_1.png'. The in_sync diff below covers the diff
  // side reading the same file.
  assert.strictEqual(look.image.file, 'textures/character-appearances/sx_aa_ent_1.png');
  assert.strictEqual(look.sprite.atlas.file, 'textures/sprites/character_appearances/sx_aa_ent_1.atlas.png');
  assert.strictEqual(look.sprite.manifest.file, 'textures/sprites/character_appearances/sx_aa_ent_1.manifest.json');
  const desc = art.art_prompt_descriptions.filter((r) => r.subject_key === 'sx_aa_item');
  assert.deepStrictEqual(desc.map((r) => r.text), ['sx second take'], 'only the active version travels');
  assert.strictEqual(art.art_prompt_notes.filter((r) => r.subject_key === 'sx_aa_item').length, 1);
  const clips = audio.audio_clips.filter((r) => r.label.startsWith('sx_aa'));
  assert.deepStrictEqual(clips.map((r) => r.label).sort(), ['sx_aa_hit', 'sx_aa_theme'], 'the unbound clip stays here');
  const hit = clips.find((r) => r.label === 'sx_aa_hit');
  assert.deepStrictEqual(hit.storage_key, { file: `audio/sfx/sx_aa_hit-${hit.sync_uuid.slice(0, 8)}.ogg`, sha1: sha1(HIT) });
  assert.ok(!('id' in hit));
  const binding = audio.audio_bindings.find((r) => r.subject_key === 'sx_aa_ent');
  assert.strictEqual(binding.clip_id, hit.sync_uuid, 'binding ref travels as the clip uuid');
  assert.deepStrictEqual(files.get(hit.storage_key.file), HIT);
  assert.ok(files.size >= 8, [...files.keys()].join(' '));
  for (const g of BINARY) assert.strictEqual((await diffGroup(pool, g)).status, 'in_sync', g);

  await wipeLocally(pool, owners);
  const fresh = fakeStore({});
  for (const g of BINARY) {
    const { preview, result } = await seedAllGit(pool, g, fresh);
    assert.ok(preview.rows.length > 0, `${g}: the fresh PC sees the fixture rows`);
    assert.ok(result.summary.created + result.summary.updated > 0, g);
  }
  assert.ok(fresh.puts.length >= 8, 'every file uploaded to the fresh store');
  assert.strictEqual((await one(pool, "SELECT count(*)::int AS n FROM audio_clips WHERE label = 'sx_aa_loose'")).n, 0);
  for (const g of BINARY) {
    const d = await diffGroup(pool, g);
    assert.strictEqual(d.status, 'in_sync', `${g}: ${JSON.stringify(d.rows)}`);
  }

  // Export again from the seeded PC with an empty repo tree: every file is
  // fetched back from the fresh store.
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root);
  for (const g of BINARY) {
    const res = await exportGroup(pool, g, { store: fresh });
    assert.ok(res.downloaded > 0, g);
    const again = readDoc(g);
    assert.strictEqual(stableStringify(again.tables), stableStringify(first[g].tables), `${g}: tables byte-identical`);
    for (const f of filesOf(g, again)) {
      assert.ok(files.get(f).equals(fs.readFileSync(path.join(root, f))), `${f} byte-identical`);
    }
  }
});

dbTest('legacy-seeded PC: same pictures under legacy keys read red, one bulk git syncs them', async (t, pool, { root, store }) => {
  await seedFixture(pool);
  await exportGroup(pool, 'art', { store });
  const doc = readDoc('art');
  // The legacy seeder put the same bytes (the committed files) under its own
  // keys; this PC has no cache entries and no baselines.
  const legacy = fakeStore({});
  const put = (key, file) => legacy.objects.set(key, fs.readFileSync(path.join(root, file)));
  const t0 = doc.tables.tile_types.find((r) => r.name === 'sx_aa_tile');
  const i0 = doc.tables.item_types.find((r) => r.name === 'sx_aa_item');
  const s0 = doc.tables.catalog_art.find((r) => r.subject_key === 'sx_aa_skill');
  put(`${BUCKET}/x/seeded/static.png`, t0.image.file);
  put(`${BUCKET}/x/seeded/icon.png`, i0.icon.file);
  put(`${BUCKET}/x/seeded/skill.png`, s0.image.file);
  await pool.query(`UPDATE tile_types SET image = '${BUCKET}/x/seeded/static.png' WHERE name = 'sx_aa_tile'`);
  await pool.query(`UPDATE item_types SET icon = '${BUCKET}/x/seeded/icon.png' WHERE name = 'sx_aa_item'`);
  await pool.query(`UPDATE catalog_art SET image = '${BUCKET}/x/seeded/skill.png' WHERE subject_key = 'sx_aa_skill'`);
  await cleanupCache(pool);
  await pool.query("DELETE FROM seed_row_hashes WHERE group_id = 'art'");

  // A red row's git file is checked like any other: with the skill file
  // missing, its row does not offer git (bulk take-git would fail on it).
  const skillFile = path.join(root, s0.image.file);
  const skillBytes = fs.readFileSync(skillFile);
  fs.unlinkSync(skillFile);
  const gone = (await previewSeed(pool, 'art')).rows.find((r) => r.syncUuid === s0.sync_uuid);
  assert.deepStrictEqual([gone.defaultDecision, gone.blockedReason, gone.allowedDecisions],
    [null, 'asset_file_missing', ['local']]);
  fs.writeFileSync(skillFile, skillBytes);

  const p = await previewSeed(pool, 'art');
  const red = p.rows.filter((r) => [t0.sync_uuid, i0.sync_uuid, s0.sync_uuid].includes(r.syncUuid));
  assert.strictEqual(red.length, 3, JSON.stringify(p.rows.map((r) => [r.table, r.key, r.kind])));
  for (const r of red) {
    assert.ok(['edited_here', 'changed'].includes(r.kind), `${r.table} ${r.kind}`);
    assert.strictEqual(r.defaultDecision, null, `${r.table}: red`);
    assert.strictEqual(r.blockedReason, null, `${r.table}: its file is there and matches`);
    assert.ok(r.allowedDecisions.includes('git'), r.table);
  }
  await seedAllGit(pool, 'art', legacy);
  const d = await diffGroup(pool, 'art');
  assert.strictEqual(d.status, 'in_sync', JSON.stringify(d.rows));
  const now = await one(pool, "SELECT image FROM tile_types WHERE name = 'sx_aa_tile'");
  assert.strictEqual(now.image, `${BUCKET}/seedsync/${t0.image.sha256}/textures_tiles_sx_aa_tile.png`);
});

// rowFilter on a DELETE: the clip's bindings go first (children first), so a
// filtered DELETE of the clip would no longer find it.
dbTest('git deletes a clip with its bindings: both go', async (t, pool, { store }) => {
  await seedFixture(pool);
  await exportGroup(pool, 'audio', { store });
  const doc = readDoc('audio');
  const hit = doc.tables.audio_clips.find((r) => r.label === 'sx_aa_hit');
  doc.tables.audio_clips = doc.tables.audio_clips.filter((r) => r.sync_uuid !== hit.sync_uuid);
  doc.tables.audio_bindings = doc.tables.audio_bindings.filter((r) => r.clip_id !== hit.sync_uuid);
  writeDoc('audio', doc);
  const p = await previewSeed(pool, 'audio');
  assert.deepStrictEqual(p.rows.map((r) => [r.table, r.kind, r.defaultDecision, r.blockedReason]).sort(), [
    ['audio_bindings', 'deleted_in_git', 'delete', null],
    ['audio_clips', 'deleted_in_git', 'delete', null],
  ]);
  const res = await applySeed(pool, 'audio', {}, { signature: p.signature, store });
  assert.strictEqual(res.summary.deleted, 2);
  assert.strictEqual((await one(pool, 'SELECT count(*)::int AS n FROM audio_clips WHERE sync_uuid = $1', [hit.sync_uuid])).n, 0);
  assert.strictEqual((await diffGroup(pool, 'audio')).status, 'in_sync');
});

// A note deactivated here keeps its sync_uuid (full UNIQUE): take-git must
// bring that row back, not update it in place while it stays inactive.
dbTest('a note deactivated here comes back active on take-git', async (t, pool, { store }) => {
  await seedFixture(pool);
  await exportGroup(pool, 'art', { store });
  const note = await one(pool, "SELECT sync_uuid FROM art_prompt_notes WHERE subject_key = 'sx_aa_item'");
  await pool.query("UPDATE art_prompt_notes SET active = false WHERE subject_key = 'sx_aa_item'");
  const p = await previewSeed(pool, 'art');
  assert.deepStrictEqual(p.rows.map((r) => [r.table, r.kind]), [['art_prompt_notes', 'deleted_here']]);
  await applySeed(pool, 'art', { [note.sync_uuid]: 'git' }, { signature: p.signature, store });
  assert.deepStrictEqual((await pool.query("SELECT active FROM art_prompt_notes WHERE subject_key = 'sx_aa_item'")).rows,
    [{ active: true }]);
  assert.strictEqual((await diffGroup(pool, 'art')).status, 'in_sync');
});

dbTest('audio export refuses a bound clip without sha1, before writing any file', async (t, pool, { root, store }) => {
  await seedFixture(pool);
  await pool.query("UPDATE audio_clips SET sha1 = NULL WHERE label = 'sx_aa_theme'");
  const theme = await one(pool, "SELECT sync_uuid FROM audio_clips WHERE label = 'sx_aa_theme'");
  await assert.rejects(exportGroup(pool, 'audio', { store }), (e) => {
    assert.strictEqual(e.code, 'audio_sha1_missing');
    assert.deepStrictEqual(e.details.rows, [{ table: 'audio_clips', key: theme.sync_uuid, label: 'sx_aa_theme' }]);
    return true;
  });
  assert.deepStrictEqual(fs.readdirSync(root), [], 'no asset file written');
  assert.ok(!fs.existsSync(fileFor('audio')), 'no sync file written');
  assert.strictEqual(store.gets, 0, 'nothing downloaded');
});

// character_appearances is referenced by player data (characters) and by the
// machine-local sprite queue (sprite_sets, EXCLUDED but NO ACTION): either
// blocks a delete from git.
dbTest('an appearance a character or a sprite set uses is never deleted', async (t, pool, { store }) => {
  await seedFixture(pool);
  await exportGroup(pool, 'art', { store });
  const ent = await one(pool, "SELECT id FROM entity_types WHERE name = 'sx_aa_ent'");
  const look = await one(pool, 'SELECT sync_uuid FROM character_appearances WHERE entity_type_id = $1', [ent.id]);
  const user = await one(pool, "INSERT INTO users (username, password_hash) VALUES ('sx_aa_user', 'x') RETURNING id");
  await pool.query(`INSERT INTO characters (user_id, entity_type_id, slot, name, appearance_variant)
    VALUES ($1, $2, 1, 'sx_aa_char', 1)`, [user.id, ent.id]);
  await pool.query(`INSERT INTO sprite_sets (creature, backend, entity_type_id, appearance_variant, status)
    VALUES ('sx_aa_set', 'stub', $1, 1, 'done')`, [ent.id]);
  const doc = readDoc('art');
  doc.tables.character_appearances = doc.tables.character_appearances.filter((r) => r.sync_uuid !== look.sync_uuid);
  writeDoc('art', doc);

  const row = async () => (await previewSeed(pool, 'art')).rows.find((r) => r.syncUuid === look.sync_uuid);
  let r = await row();
  assert.deepStrictEqual([r.kind, r.blockedReason, r.defaultDecision, r.allowedDecisions],
    ['deleted_in_git', '1 rows in characters reference this; 1 rows in sprite_sets reference this', 'local', ['local']]);
  await pool.query("DELETE FROM users WHERE username = 'sx_aa_user'");
  r = await row();
  assert.strictEqual(r.blockedReason, '1 rows in sprite_sets reference this');
  const p = await previewSeed(pool, 'art');
  await assert.rejects(applySeed(pool, 'art', { [look.sync_uuid]: 'delete' }, { signature: p.signature, store }),
    (e) => e.code === 'blocked');
  assert.strictEqual((await pool.query('SELECT 1 FROM character_appearances WHERE sync_uuid = $1', [look.sync_uuid])).rowCount, 1);
});
