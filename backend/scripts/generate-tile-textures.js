#!/usr/bin/env node
// Point every tile at one AI provider and generate the textures that are
// missing. Run via `make tiles-generate` (see the Makefile for the options).
//
// WHY THIS EXISTS. Texturing the catalog through the admin UI is 50 modals:
// open a tile, pick a provider, pick a biome, click Generate, wait, click
// Approve, close, repeat. Every one of those clicks is a chance to leave a
// tile on a different provider or no biome at all, and the result is a world
// where some tiles are drawn and some are flat colour with no record of which.
//
// This does the same work the UI does, in the same order, for the whole
// catalog:
//
//   1. PIN   -- set ai_provider_mode/ai_provider_id so the tile permanently
//               generates on the chosen provider (the UI's "Generation
//               service"). Skipped with --no-pin.
//   2. BIOME -- if art_biome is empty, adopt a biome that actually lists this
//               tile in terrain_tiles (the UI's "Biome art context"). A tile
//               no biome claims keeps '' rather than borrowing a palette that
//               has nothing to do with it.
//   3. DRAW  -- generate on the provider (the UI's "Generate with") and store
//               the result, then point the catalog row at it, which is what
//               the Approve button does.
//
// IDEMPOTENT BY DEFAULT: a tile that already has a texture is left alone, so a
// re-run only fills gaps. --force redraws everything.
//
// MUST RUN INSIDE THE BACKEND CONTAINER. It writes to MinIO through the same
// assetStore the API uses, so it needs that container's MINIO_* environment.
// The Makefile target already does this; running it on the host will fail to
// reach the object store even with a working DATABASE_URL.

const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const aiProviders = require('../src/services/aiProviders.js');
const remoteImageProvider = require('../src/services/remoteImageProvider.js');
const { composeBiomePrompt } = require('../src/services/biomePrompt.js');

function parseArgs(argv) {
  const args = { provider: null, force: false, pin: true, biome: true, only: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--no-pin') args.pin = false;
    else if (a === '--no-biome') args.biome = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--provider') { args.provider = argv[i + 1]; i += 1; }
    else if (a === '--only') { args.only = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean); i += 1; }
  }
  return args;
}

// Accepts a name or an id, and falls back to whichever provider is active.
// Named lookup is what the Makefile exposes, because an admin knows their box
// as "desktop gpu" and has no reason to know it is row 4.
async function resolveProvider(pool, wanted) {
  if (!wanted) {
    const active = await aiProviders.loadActiveProviderWithSecret(pool);
    if (!active) {
      throw new Error('no provider given and none is active -- pass --provider "<name>" '
        + 'or activate one in Settings');
    }
    return active;
  }
  const byId = /^\d+$/.test(String(wanted))
    ? await aiProviders.loadProviderWithSecret(pool, Number(wanted))
    : null;
  if (byId) return byId;
  const r = await pool.query('SELECT id FROM ai_providers WHERE name = $1', [wanted]);
  if (!r.rows[0]) throw new Error(`no AI provider named '${wanted}'`);
  return aiProviders.loadProviderWithSecret(pool, r.rows[0].id);
}

// The biome art context a tile should adopt when it has none.
//
// Deterministic on purpose -- lowest biome id wins, not "whichever row the
// planner happened to return first". Re-running this script must not silently
// re-style a tile because an unrelated biome was added.
function pickBiome(tileName, biomes) {
  const claiming = biomes
    .filter((b) => Array.isArray(b.terrain_tiles) && b.terrain_tiles.includes(tileName))
    .sort((a, b) => a.id - b.id);
  return claiming[0] || null;
}

async function generateOne(pool, provider, tile, biome) {
  const prompt = composeBiomePrompt(tile.prompt, biome);
  const jobId = remoteImageProvider.createJob();
  // Awaited rather than fire-and-forget: the API returns early because a
  // browser is polling, but here there is nobody to poll and the next tile
  // should not start until this one is stored.
  await remoteImageProvider.runGeneration(jobId, provider, {
    subject: tile.name, kind: 'tile', prompt, seed: 0, frames: 1,
  });
  const job = remoteImageProvider.getJob(jobId);
  if (!job || job.status !== 'done') {
    return { ok: false, error: (job && job.error) || 'generation did not finish' };
  }
  const key = job.result && job.result.image_key;
  if (!key) return { ok: false, error: 'job finished without an image key' };

  // The same write POST /api/tile-types/:id/image performs on Approve --
  // including clearing `sprite`, so a tile that was animated does not keep a
  // stale atlas beside its new still.
  await pool.query(
    `UPDATE tile_types SET image = $1, sprite = NULL, render_mode = 'image',
      updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [key, tile.id],
  );
  return { ok: true, key };
}

async function generateTileTextures(pool, args) {
  const provider = await resolveProvider(pool, args.provider);
  if (provider.enabled === false) throw new Error(`AI provider '${provider.name}' is disabled`);

  const [tilesR, biomesR] = await Promise.all([
    pool.query(`SELECT id, name, prompt, render_mode, art_biome FROM tile_types ORDER BY name`),
    pool.query(`SELECT id, name, terrain_tiles, palette, art_style, exclusions FROM biomes ORDER BY id`),
  ]);
  const biomes = biomesR.rows;
  const tiles = args.only
    ? tilesR.rows.filter((t) => args.only.includes(t.name))
    : tilesR.rows;

  const stats = { pinned: 0, biomed: 0, drawn: 0, skipped: 0, failed: 0, noPrompt: 0 };
  console.log(`provider: ${provider.name} (id ${provider.id})  tiles: ${tiles.length}`
    + `${args.dryRun ? '  [DRY RUN]' : ''}`);

  for (const tile of tiles) {
    if (args.pin && !args.dryRun) {
      await pool.query(
        `UPDATE tile_types SET ai_provider_mode = 'provider', ai_provider_id = $1,
          updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [provider.id, tile.id],
      );
      stats.pinned += 1;
    }

    // --no-biome draws the bare material with no palette steering. Some
    // subjects are actively hurt by their biome's art_style: "abandoned deep
    // foundry fantasy" pushes a floor-plate prompt toward drawing the
    // foundry's machinery instead of its floor.
    let biome = args.biome ? (biomes.find((b) => b.name === tile.art_biome) || null) : null;
    if (!biome && args.biome) {
      biome = pickBiome(tile.name, biomes);
      if (biome && !args.dryRun) {
        await pool.query('UPDATE tile_types SET art_biome = $1 WHERE id = $2', [biome.name, tile.id]);
        stats.biomed += 1;
      }
    }

    // A tile with no prompt cannot be drawn, and a blank prompt would produce
    // a plausible-looking picture of nothing. Report it instead.
    if (!tile.prompt || !tile.prompt.trim()) {
      console.log(`  ${tile.name}: SKIP (no prompt)`);
      stats.noPrompt += 1;
      continue;
    }
    if (tile.render_mode !== 'color' && !args.force) {
      stats.skipped += 1;
      continue;
    }
    if (args.dryRun) {
      console.log(`  ${tile.name}: would draw${biome ? ` [${biome.name}]` : ''}`);
      stats.drawn += 1;
      continue;
    }

    const started = Date.now();
    const r = await generateOne(pool, provider, tile, biome);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    if (r.ok) {
      console.log(`  ${tile.name}: ok (${secs}s)${biome ? ` [${biome.name}]` : ''}`);
      stats.drawn += 1;
    } else {
      // Keep going. One unreachable moment on somebody's desktop should not
      // cost the other 49 tiles their run.
      console.log(`  ${tile.name}: FAILED ${r.error}`);
      stats.failed += 1;
    }
  }
  return stats;
}

module.exports = { generateTileTextures, resolveProvider, pickBiome, parseArgs };

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  const args = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: url });
  generateTileTextures(pool, args)
    .then((s) => {
      console.log(`pinned ${s.pinned}, biome set on ${s.biomed}, drawn ${s.drawn}, `
        + `skipped ${s.skipped} already textured, ${s.noPrompt} without a prompt, ${s.failed} failed`);
      if (s.failed) process.exitCode = 1;
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
