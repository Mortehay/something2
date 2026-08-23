// SOMET-342: writing the per-type generation pin.
//
// SOMET-328 added `ai_provider_mode` / `ai_provider_id` to entity_types and
// tile_types and taught resolveGenerationTarget to honour them. Nothing ever
// wrote them, so the pin existed and could not be set. This is the write half,
// shared by both type routes because two copies of a three-state rule is how
// the tile editor and the entity editor come to disagree about what "default"
// means.
//
// THE STATE THIS REFUSES: mode 'default' or 'local' carried alongside a
// non-null ai_provider_id. The DB CHECK allows it (it only constrains the mode
// string) and resolveGenerationTarget ignores the id in those modes, so
// nothing breaks loudly -- the row just holds a pin that does nothing, shows
// as "Default" in the editor, and confuses whoever reads the table next.
// Normalizing the id to NULL keeps the stored state and the resolved
// behaviour the same thing.

const PIN_MODES = Object.freeze(['default', 'local', 'provider']);

// Was a pin sent at all? A PUT that omits both keys must leave the stored pin
// exactly as it is -- the same posture prompt/behavior_id already have on
// these routes. `in` on the parsed body distinguishes an absent key from an
// explicit null, which JSON.parse never produces for a present key.
function pinProvided(body) {
  return 'ai_provider_mode' in body || 'ai_provider_id' in body;
}

// Returns an error string for a 400, or null. The DB CHECK would reject a bad
// mode too, but as a 500 with a constraint name in it -- this is the readable
// version, and it also catches the two cases the CHECK cannot see.
// SOMET-453 split this in two. PER-FIELD validity only: is each value a thing
// this column can hold. Deliberately does NOT enforce the cross-field rule
// below, because a body carrying mode 'provider' and no id yet is a perfectly
// well-formed body -- the id may be arriving in the same form, and the type
// editor legitimately holds that state mid-edit.
function providerPinFieldError(body) {
  if (!pinProvided(body)) return null;

  const mode = body.ai_provider_mode;
  if (mode != null && !PIN_MODES.includes(mode)) {
    return `ai_provider_mode must be one of ${PIN_MODES.join(', ')}`;
  }

  const id = body.ai_provider_id;
  if (id != null && (typeof id !== 'number' || !Number.isInteger(id))) {
    return 'ai_provider_id must be an integer';
  }

  return null;
}

// Everything providerPinFieldError checks, PLUS the cross-field rule. This is
// what a WRITE must satisfy; the field-level half is what a generic
// "is this body valid" check consults.
function providerPinError(body) {
  if (!pinProvided(body)) return null;

  const fieldErr = providerPinFieldError(body);
  if (fieldErr) return fieldErr;

  // A 'provider' pin with no target is the half-state that would silently
  // resolve to the global default -- the admin asked for a specific service
  // and would get whichever one happens to be active.
  if (body.ai_provider_mode === 'provider' && body.ai_provider_id == null) {
    return 'ai_provider_mode "provider" needs an ai_provider_id';
  }

  return null;
}

// The values to store, given a body that passed the check above. Only called
// when pinProvided(body).
//
// An id sent with a non-provider mode is dropped rather than rejected: the
// editor sends the whole form back, so a type that WAS pinned and is being set
// to Default legitimately arrives with the old id still in the payload, and
// failing that save would make "unpin" impossible from the obvious UI.
function providerPinValues(body) {
  const mode = body.ai_provider_mode == null ? 'default' : body.ai_provider_mode;
  const id = mode === 'provider' ? body.ai_provider_id : null;
  return { mode, id };
}

module.exports = {
  PIN_MODES, pinProvided, providerPinFieldError, providerPinError, providerPinValues,
};
