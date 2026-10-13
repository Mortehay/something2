// Pure rules behind the entity editor's world-point-kind controls, kept out
// of EntityTypesAdmin.jsx so they are reachable from a test (that suite has
// no DOM).

// A point-kind type is never placed by the sim: walkable / spawn tiles /
// spawn chance / is_creature are meaningless for it and the world ignores
// them (loadDecorationDefs only reads rows with spawn_tiles).
export function pointKindHidesWorldFields(pointKind) {
  return typeof pointKind === 'string' && pointKind !== '';
}

// The server's PUT treats an ABSENT point_kind as "leave alone" and an
// explicit null as "clear" (same rule as behavior_id), so the form always
// sends the key.
export function pointKindPayload(formData) {
  const k = formData && formData.point_kind;
  return { point_kind: typeof k === 'string' && k !== '' ? k : null };
}

// savedPointKind is the entity's point_kind as last persisted (editingEntity),
// separate from pointKind (the form's live value). When they differ, the
// server does not yet know this entity as a member of pointKind -- clicking
// the button would ask for a default pointing at a type the kind's own FK
// check does not (yet) recognize as one. Omitted entirely (not passed), the
// check is skipped -- callers that don't track an unsaved edit still work.
export function defaultButtonState({ pointKind, savedPointKind, entityId, kinds }) {
  if (!pointKindHidesWorldFields(pointKind) || entityId == null) {
    return { visible: false, disabled: true, label: '' };
  }
  const row = (kinds || []).find((k) => k.kind === pointKind);
  const currentId = row ? row.default_entity_type_id : null;
  if (currentId === entityId) {
    return { visible: true, disabled: true, label: `Default for ${pointKind}` };
  }
  const current = row && row.default_name ? row.default_name : 'none';
  const label = `Make default for ${pointKind} (currently: ${current})`;
  if (savedPointKind !== undefined && savedPointKind !== pointKind) {
    return { visible: true, disabled: true, label };
  }
  return { visible: true, disabled: false, label };
}
