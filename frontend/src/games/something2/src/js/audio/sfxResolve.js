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
    // SOMET-607 (S5, spec §4.4): "apply" plays when the LOCAL player enters
    // an enemy aura, at 'own' -- a client-synthesized event (Game.js diffs
    // its own debuffs frame to frame), not something the server pushes. `c`
    // carries the aura NAME, same field the other cases reuse for a subject
    // key. sfxPriority's existing ownActor check resolves this to 'own' as
    // long as the caller sets `ev.a` to the local player's own id.
    case 'apply':
      return c ? chain([`aura/${c}/apply`]) : [];
    // SOMET-610 (S7, spec §3.6/§4.4): a creature SKILL's own moments.
    // Distinct wire names from the ordinary attack's use/hit (and from
    // spawn/phase/enrage) so they resolve against the `creature_skill`
    // audio kind -- keyed by skill NAME, which rides on `s` here (no
    // `skill:` prefix needed: the event NAME already scopes it, unlike a
    // player's own cast where `use`/`hit` are shared with every other
    // attack kind).
    case 'skill_telegraph':
      return s ? chain([`creature_skill/${s}/telegraph`]) : [];
    case 'skill_cast':
      return s ? chain([`creature_skill/${s}/use`]) : [];
    case 'skill_hit':
      return s ? chain([`creature_skill/${s}/hit`]) : [];
    default:
      return [];
  }
}

// SOMET-605 (spec 4.4): which SfxLimiter tier a wire event plays at.
const BOSS_EVENTS = new Set(['spawn', 'phase', 'enrage']);
// SOMET-610 (S7, spec §4.4): a creature skill is 'nearest' normally, 'boss'
// when the CASTER is a boss -- unlike spawn/phase/enrage, skill_telegraph/
// _cast/_hit are not boss-exclusive event NAMES (an ordinary creature casts
// them too, e.g. Fire Elemental Guard's scaled-down kit), so the event tuple
// alone cannot answer "is this a boss". `bossActorIds` (optional: a Set of
// `c:<id>` actor keys, built by the caller from its own live creature list --
// see AudioEngine.playSfxEvents/Game.js) is the live cross-reference that
// answers it; omitted, these three fall back to the base rule exactly like
// any other creature event.
const SKILL_EVENTS = new Set(['skill_telegraph', 'skill_cast', 'skill_hit']);
export function sfxPriority(ev, ownActor, bossActorIds) {
  if (ownActor && ev && ev.a === ownActor) return 'own';
  if (!ev) return 'nearest';
  if (BOSS_EVENTS.has(ev.e)) return 'boss';
  if (SKILL_EVENTS.has(ev.e) && bossActorIds && bossActorIds.has(ev.a)) return 'boss';
  return 'nearest';
}
