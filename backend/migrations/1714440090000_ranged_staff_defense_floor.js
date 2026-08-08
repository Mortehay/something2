// authority_elements_invariants.test.js's "every seeded resistance changes
// real dealt damage by more than the damage floor" test went red once
// SOMET-250 (P4) seeded real Apex-tier creatures: Apex's defense (13, from
// template.js's RUNGS table) sits right at frost staff's damage (13) and
// one point under storm staff's (14).
//
// applyDamage subtracts defense BEFORE applying resistance
// (raw2 = raw - defense; final = max(MIN_DAMAGE, raw2 * (1 - resist))). At
// raw2 <= 1, an 0.8 or 0.5 resistance can no longer separate the resisted
// result from the unresisted one -- both floor to MIN_DAMAGE (1), so the
// resistance has zero observable effect. That made ice or lightning
// resistance mechanically invisible on 15 of 32 Apex creatures (every line
// whose primary or shared element is ice or lightning) -- a real, if
// narrow, weapon-catalog gap that simply had no Apex-tier content to expose
// it before now.
//
// raw2 needs to reach 2 for an 0.8 (or 0.5) resistance to clear the floor
// (verified: raw2=1 -> resisted and unresisted both floor to 1, diff 0;
// raw2=2 -> unresisted 2, resisted floors to 1, diff 1 == MIN_DAMAGE). With
// Apex's defense at 13, that means damage 15 for both staves.
//
// Storm staff's damage/mana_cost/cooldown were carefully tuned in
// 1714440022000/1714440023000 so it sits strictly worst-damage-per-mana of
// any staff (it carries all three lightning riders and must pay for them).
// mana_cost and cooldown are untouched here, so that DPS analysis still
// holds; a +1 damage bump moves its dpm from 0.636 to 0.682, still well
// below frost staff's (now 0.938) -- confirmed against the real catalog,
// storm remains strictly last.
//
// Frost staff carries no equivalent documented balance analysis; bumping it
// from 13 to 15 has no other invariant to disturb (checked: no other test
// pins its exact damage).
exports.up = (pgm) => {
  pgm.sql(`UPDATE item_types SET damage = 15 WHERE name = 'frost staff'`);
  pgm.sql(`UPDATE item_types SET damage = 15 WHERE name = 'storm staff'`);
};

exports.down = (pgm) => {
  pgm.sql(`UPDATE item_types SET damage = 13 WHERE name = 'frost staff'`);
  pgm.sql(`UPDATE item_types SET damage = 14 WHERE name = 'storm staff'`);
};
