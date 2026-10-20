// SOMET-645. Read-only drift probe: for every region on the GPU box, rebuild it with the local
// JS port from the box's stored params (and biome_plan) and compare sha256 with the box's ETag.
// MATCH everywhere = the box generator still equals the vendored reference. Usage (from backend/):
//   GAME_DB_URL=<db with the ai_providers row> node tools/world_gen_ref/drift-probe.js
// Never writes to the box or the DB (provider lookup is a SELECT).
const path = require('path');
const crypto = require('crypto');
const BK = path.resolve(__dirname, '../..');
const { Pool } = require(path.join(BK, 'node_modules/pg'));
const svc = require(path.join(BK, 'src/services/worldGenService.js'));
const W = require(path.join(BK, 'src/services/worldGen/worldGen.js'));
(async () => {
  const pool = new Pool({ connectionString: process.env.GAME_DB_URL || process.env.DATABASE_URL, max: 2 });
  try {
    const list = await svc.listWorlds(pool);
    for (const r of list.items) {
      const { etag } = await svc.getWorldSpecWithEtag(pool, r.name);
      const rep = await svc.getWorldReport(pool, r.name);
      const p = (rep && rep.params) || r.params || null;
      const keys = Object.keys(r).join(',');
      if (!p) { console.log(`${r.name}: no params exposed (listing keys: ${keys}; report keys: ${Object.keys(rep || {}).join(',')})`); continue; }
      const plan = p.biome_plan || null;
      const spec = W.planRegion({ name: p.name || r.name, world_count: p.worlds, target_per_screen: p.target_per_screen,
        size: p.size, chunk_size: p.chunk_size, biome_cell: p.biome_cell, ...(plan ? { biome_plan: plan } : {}) });
      const sha = crypto.createHash('sha256').update(W.toJson(spec)).digest('hex');
      console.log(`${r.name}: author=${p.author} hand_edited=${r.hand_edited} biome_plan=${plan ? 'stored' : 'none'} -> ${`"${sha}"` === etag ? 'MATCH' : 'DIFFERS'}`);
    }
  } catch (e) { console.error('FAILED:', e.code || '', e.message); process.exitCode = 1; } finally { await pool.end(); }
})();
