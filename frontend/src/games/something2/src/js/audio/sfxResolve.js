// Pure mapping from one wire `sfx` frame event (spec §3 "Wire change -- an sfx
// event channel") to the lookup chain that resolves which clip plays.
//
// The authority (backend/src/authority/sfxEvents.js) already splits what
// could look like "one action, two sounds" into separate events on the wire:
// a creature's swing is its own `use` event (creature/<type>/attack), and the
// landing is a separate `hit` event; a creature's own `hurt` is a THIRD event
// entirely. So each event maps to exactly one fallback chain here -- there is
// no case where a single event needs two independently-resolved sounds. The
// array return keeps room for that without changing callers if one ever
// shows up (e.g. a future event type that legitimately plays two clips).
//
// Unresolvable/malformed events resolve to [] (silence), never a throw --
// this feeds a chain into AudioEngine.playSfxEvents(), which must never break
// the render loop over a wire shape it does not recognise.
const SKILL_PREFIX = 'skill:';
const skillId = (s) => s.slice(SKILL_PREFIX.length);
const isSkill = (s) => typeof s === 'string' && s.startsWith(SKILL_PREFIX);

function chain(keys) {
  return keys && keys.length ? [{ keys, missKey: keys[0] }] : [];
}

export function sfxChains(ev) {
  if (!ev || typeof ev !== 'object') return [];
  const { e, k, s, c } = ev;
  switch (e) {
    case 'use':
      if (isSkill(s)) return chain([`skill/${skillId(s)}/use`, `attack_type/${k}/use`]);
      if (s) return chain([`item/${s}/use`, `attack_type/${k}/use`]);
      if (c) return chain([`creature/${c}/attack`]);
      return [];
    case 'hit':
      if (isSkill(s)) return chain([`skill/${skillId(s)}/hit`, `attack_type/${k}/hit`]);
      if (s) return chain([`item/${s}/hit`, `attack_type/${k}/hit`]);
      // A creature's own hit carries no `s` -- its `attack` sound already
      // played on the earlier `use` event, so only the generic melee-hit
      // (bite/claw landing) plays here.
      if (c) return chain(['attack_type/melee/hit']);
      return [];
    case 'hurt':
      return c ? chain([`creature/${c}/hurt`]) : [];
    case 'death':
      return c ? chain([`creature/${c}/death`]) : [];
    // SOMET-605: a boss's own moments (backend sfxEvents.bossSfx).
    case 'spawn':
    case 'phase':
    case 'enrage':
      return c ? chain([`creature/${c}/${e}`]) : [];
    default:
      return [];
  }
}

// SOMET-605 (spec 4.4): which SfxLimiter tier a wire event plays at.
const BOSS_EVENTS = new Set(['spawn', 'phase', 'enrage']);
export function sfxPriority(ev, ownActor) {
  if (ownActor && ev && ev.a === ownActor) return 'own';
  return ev && BOSS_EVENTS.has(ev.e) ? 'boss' : 'nearest';
}
