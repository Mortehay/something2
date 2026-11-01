// Druid form bar: while shapeshifted the hotbar keys 1-9 show the skills of that
// form instead of the normal hotbar. Pure -- Game passes in what it owns.
import { formOfSkill } from "./skillsData.js";

export const FORM_BAR_SLOTS = 9;
export const FORM_BUFF_IDS = { dru_bear_form: "bear", dru_hawk_form: "hawk", dru_wolf_form: "wolf" };

// The server-authoritative form, from the local player's snapshot buffs ([{id}]).
export function formFromBuffs(buffs) {
  if (!Array.isArray(buffs)) return null;
  for (const b of buffs) {
    const form = b && FORM_BUFF_IDS[b.id];
    if (form) return form;
  }
  return null;
}

// Map<slot, skill>: the form's skills by reqLvl (first 8) in slots 1..8, and the
// form skill itself in the LAST slot so the player can leave the form.
export function buildFormBar({ activeForm, ownedSkills, formSkillId } = {}) {
  const bar = new Map();
  if (!activeForm) return bar;
  const seen = new Set();
  const list = [];
  for (const s of ownedSkills || []) {
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    list.push(s);
  }
  const id = formSkillId || `dru_${activeForm}_form`;
  const formSkill = list.find((s) => s.id === id) || null;
  const picked = list
    .filter((s) => s.id !== id && formOfSkill(s) === activeForm)
    .sort((a, b) => (a.reqLvl || 0) - (b.reqLvl || 0))
    .slice(0, FORM_BAR_SLOTS - 1);
  picked.forEach((s, i) => bar.set(i + 1, s));
  if (formSkill) bar.set(FORM_BAR_SLOTS, formSkill);
  return bar;
}
