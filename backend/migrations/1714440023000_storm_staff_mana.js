// 1714440022000_elements set the storm staff to damage 14 / cooldown 1.10 /
// mana 34 so that it would be strictly the worst staff in the game by
// damage-per-mana — the price of carrying all three lightning riders
// (vulnerability, interrupt, mana drain). That intent is right; 34 overshot it.
//
// Measured live (task-10 browser verification, 40s of sustained fire at
// pool 100 / regen 10):
//
//   cooldown 1.10s implies       0.91 shots/s
//   mana 34 at 10/s regen permits 0.29 shots/s   <- the binding constraint
//
// Mana gated it to one shot per ~3.4s, so the cooldown was decorative and the
// pool sawtoothed between empty and one shot's worth. Sustained DPS came out at
// ~4.1 against the apprentice staff's 12.5 — a third of the field — and the
// riders do not cover that gap: the interrupt costs a target only ~13% of its
// action uptime, the drain is small, and the +25% vulnerability mostly benefits
// damage sources OTHER than the storm staff itself.
//
// 22 keeps the intended ordering intact while letting the cooldown bind again:
//
//   apprentice 1.25 > magic-bolt 0.93 > flame 0.89 > frost 0.81
//     > archmage 0.75 > storm 0.64        (was 0.41)
//
// Storm remains strictly last, which is what `storm staff pays for its riders`
// in authority_elements_invariants.test.js enforces — that test is unmodified
// by this change and must stay green.
//
// damage and cooldown are deliberately left where 1714440022000 put them; only
// the mana gate moves. A new migration rather than an edit to that one, because
// it has already run.
exports.up = (pgm) => {
  pgm.sql(`UPDATE item_types SET mana_cost = 22 WHERE name = 'storm staff';`);
};

exports.down = (pgm) => {
  pgm.sql(`UPDATE item_types SET mana_cost = 34 WHERE name = 'storm staff';`);
};
