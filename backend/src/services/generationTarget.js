// SOMET-328: deciding WHICH service generates a given image.
//
// Extracted into a pure function rather than inlined into startGenerationJob
// because the precedence chain is four levels deep and every level has a
// reason to exist. Inline, it would be four nested ternaries nobody can test
// in isolation; here each rule is one line with a name.
//
// THE INVARIANT THAT MATTERS MOST: with no active provider and no per-type
// choice, this returns local. That is today's behaviour, and it is what makes
// this whole epic a no-op for anyone who never opens the Settings tab.

const LOCAL = Object.freeze({ source: 'local' });

// Precedence, highest first:
//
//   1. the request body      -- a one-off "generate this with X" from the
//                               panel's provider selector, which must beat
//                               stored state or the selector does nothing
//   2. the type's own choice -- the admin pinned this tile/entity
//   3. the active provider   -- the global default
//   4. local sprite-gen      -- the fallback, and today's behaviour
//
// `type` may be null (a subject with no catalog row yet); `active` may be null
// (no provider activated, or the active one is disabled).
function resolveGenerationTarget({ request = {}, type = null, active = null } = {}) {
  // 1. Request-level override.
  if (request.ai_provider_local === true) return LOCAL;
  if (Number.isInteger(request.ai_provider_id)) {
    return { source: 'remote', providerId: request.ai_provider_id };
  }

  // 2. The type's stored choice.
  if (type) {
    if (type.ai_provider_mode === 'local') return LOCAL;
    // A 'provider' pin whose target was deleted (ON DELETE SET NULL) falls
    // through deliberately: a dangling pin should degrade to the default, not
    // break generation for that type until somebody notices.
    if (type.ai_provider_mode === 'provider' && Number.isInteger(type.ai_provider_id)) {
      return { source: 'remote', providerId: type.ai_provider_id };
    }
  }

  // 3. The global default.
  if (active && Number.isInteger(active.id)) {
    return { source: 'remote', providerId: active.id };
  }

  // 4. Today's behaviour.
  return LOCAL;
}

// Which catalog table holds the per-type override for a generation `kind`.
// kind 'tile' -> tile_types; 'object' and the directional creature path
// (kind undefined) -> entity_types.
function typeTableForKind(kind) {
  return kind === 'tile' ? 'tile_types' : 'entity_types';
}

// Loads just the two override columns for a subject NAME. Returns null when
// there is no such row, which resolveGenerationTarget treats as "no per-type
// choice" rather than as an error -- generation is allowed to run for a
// subject that has no catalog row yet.
async function loadTypeOverride(db, kind, subject) {
  const table = typeTableForKind(kind);
  const r = await db.query(
    `SELECT ai_provider_mode, ai_provider_id FROM ${table} WHERE name = $1`,
    [subject],
  );
  return r.rows[0] || null;
}

module.exports = { resolveGenerationTarget, typeTableForKind, loadTypeOverride, LOCAL };
