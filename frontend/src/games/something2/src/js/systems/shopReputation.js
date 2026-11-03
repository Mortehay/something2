// Pure text helpers for the merchant shop's reputation UI.

import { t } from "../i18n/i18n.js";

export function bannerText(rep) {
  if (!rep || !rep.tier) return "";
  const name = rep.villageKey ? t(String(rep.villageKey).replace(/^\w/, (c) => c.toUpperCase())) : t("Reputation");
  const off = Number(rep.discountPct) || 0;
  const sell = Number(rep.sellBonusPct) || 0;
  const perks = [];
  if (off > 0) perks.push(t("{n}% off", { n: off }));
  if (sell > 0) perks.push(t("+{n}% sell price", { n: sell }));
  let text = t("{name}: {tier} ({points} rep)", { name, tier: t(rep.tier), points: rep.points ?? 0 }) + (perks.length ? ` - ${perks.join(", ")}` : "");
  if (rep.nextTier && rep.nextTier.name) text += `; ${t("next: {name} at {at}", { name: t(rep.nextTier.name), at: rep.nextTier.at })}`;
  return text;
}

export function lockedRowText(row) {
  if (!row) return "";
  const tier = row.requiredTier ? t(row.requiredTier) : t("higher standing");
  const min = row.minReputation != null ? ` (${row.minReputation})` : "";
  return t("Requires {tier}{min}", { tier, min });
}

export function lockedToastText(row, rep) {
  const need = Number(row && row.minReputation);
  const have = Number(rep && rep.points) || 0;
  const base = lockedRowText(row);
  if (Number.isFinite(need) && need > have) return t("{base} - you have {have}, need {more} more", { base, have, more: need - have });
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
    // header stays English (tests compare it); translated where drawn
    rows.push({ header: "Locked wares", locked: true });
    for (const r of lk) rows.push({ ...r, locked: true });
  }
  return rows;
}
