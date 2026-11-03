// Pure text helpers for the merchant shop's reputation UI.

export function bannerText(rep) {
  if (!rep || !rep.tier) return "";
  const name = rep.villageKey ? String(rep.villageKey).replace(/^\w/, (c) => c.toUpperCase()) : "Reputation";
  const off = Number(rep.discountPct) || 0;
  const sell = Number(rep.sellBonusPct) || 0;
  const perks = [];
  if (off > 0) perks.push(`${off}% off`);
  if (sell > 0) perks.push(`+${sell}% sell price`);
  let text = `${name}: ${rep.tier} (${rep.points ?? 0} rep)` + (perks.length ? ` - ${perks.join(", ")}` : "");
  if (rep.nextTier && rep.nextTier.name) text += `; next: ${rep.nextTier.name} at ${rep.nextTier.at}`;
  return text;
}

export function lockedRowText(row) {
  if (!row) return "";
  const tier = row.requiredTier || "higher standing";
  const min = row.minReputation != null ? ` (${row.minReputation})` : "";
  return `Requires ${tier}${min}`;
}

export function lockedToastText(row, rep) {
  const need = Number(row && row.minReputation);
  const have = Number(rep && rep.points) || 0;
  const base = lockedRowText(row);
  if (Number.isFinite(need) && need > have) return `${base} - you have ${have}, need ${need - have} more`;
  return base;
}

// -> { price, listPrice|null }; listPrice only when it exceeds the price.
export function priceParts(row) {
  const price = Number(row && row.price) || 0;
  const lp = Number(row && row.listPrice);
  return { price, listPrice: Number.isFinite(lp) && lp > price ? lp : null };
}

// Catalog rows followed by a "Locked wares" header + locked rows, flagged for
// the renderer. Header and locked rows are never buyable.
export function buildShopRows(catalog, locked) {
  const rows = (catalog || []).slice();
  const lk = locked || [];
  if (lk.length) {
    rows.push({ header: "Locked wares", locked: true });
    for (const r of lk) rows.push({ ...r, locked: true });
  }
  return rows;
}
