// The Druid's active shapeshift form as the SERVER reports it: the form is a buff
// on the local player's snapshot row ([{ id, ... }]), with these ids.
export const FORM_BUFF_IDS = { dru_bear_form: "bear", dru_hawk_form: "hawk", dru_wolf_form: "wolf" };

// 'bear' | 'hawk' | 'wolf', or null when no form buff is present.
export function formFromBuffs(buffs) {
  if (!Array.isArray(buffs)) return null;
  for (const b of buffs) {
    const form = b && FORM_BUFF_IDS[b.id];
    if (form) return form;
  }
  return null;
}
