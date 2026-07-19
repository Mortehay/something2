// Drop-table rolling. Pure and rng-injectable so drops are deterministic under
// test; the caller supplies the rows and performs the INSERTs.

// Roll each drop row independently. Returns one item_type_id per unit of
// quantity (no stacking this slice — every drop is its own instance).
function rollDrops(dropRows, rng = Math.random) {
  const out = [];
  for (const row of dropRows || []) {
    // `chance` is a numeric column, which pg returns as a string.
    const chance = Number(row.chance);
    if (!Number.isFinite(chance) || chance <= 0) continue;
    if (rng() >= chance) continue;
    const min = Math.max(1, Number(row.min_qty) || 1);
    const max = Math.max(min, Number(row.max_qty) || min);
    const qty = min + Math.floor(rng() * (max - min + 1));
    for (let i = 0; i < qty; i++) out.push(row.item_type_id);
  }
  return out;
}

module.exports = { rollDrops };
