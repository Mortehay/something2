// Kept sprite concepts: one per subject (entity, or entity + appearance variant).

const norm = (variant) => (variant == null ? null : Number(variant));

async function getKept(db, { entityTypeId, variant }) {
  const { rows } = await db.query(
    `SELECT * FROM sprite_concepts
      WHERE entity_type_id = $1 AND COALESCE(appearance_variant, 0) = COALESCE($2::smallint, 0)`,
    [entityTypeId, norm(variant)],
  );
  return rows[0] || null;
}

async function upsertKept(db, { entityTypeId, variant, conceptKey, boxConceptPath, providerId, boxOrigin }) {
  const { rows } = await db.query(
    `INSERT INTO sprite_concepts
       (entity_type_id, appearance_variant, concept_key, box_concept_path, provider_id, box_origin)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (entity_type_id, COALESCE(appearance_variant, 0)) DO UPDATE SET
       appearance_variant = EXCLUDED.appearance_variant,
       concept_key = EXCLUDED.concept_key,
       box_concept_path = EXCLUDED.box_concept_path,
       provider_id = EXCLUDED.provider_id,
       box_origin = EXCLUDED.box_origin,
       created_at = now()
     RETURNING *`,
    [entityTypeId, norm(variant), conceptKey, boxConceptPath, providerId ?? null, boxOrigin],
  );
  return rows[0];
}

// Forgets the kept concepts of the given subjects, except those with a running
// job (their sheet is being drawn from it). Returns the subjects skipped.
async function clearKept(db, targets) {
  const seen = new Map();
  for (const t of targets || []) {
    const variant = norm(t.variant);
    seen.set(`${t.entityId}:${variant ?? ''}`, { entityId: Number(t.entityId), variant });
  }
  let cleared = 0;
  const skipped_running = [];
  for (const { entityId, variant } of seen.values()) {
    const { rows: running } = await db.query(
      `SELECT 1 FROM sprite_sets
        WHERE entity_type_id = $1 AND COALESCE(appearance_variant, 0) = COALESCE($2::smallint, 0)
          AND status = 'running' LIMIT 1`,
      [entityId, variant],
    );
    if (running[0]) {
      skipped_running.push(variant == null ? String(entityId) : `${entityId}:${variant}`);
      continue;
    }
    const res = await db.query(
      `DELETE FROM sprite_concepts
        WHERE entity_type_id = $1 AND COALESCE(appearance_variant, 0) = COALESCE($2::smallint, 0)`,
      [entityId, variant],
    );
    cleared += res.rowCount;
  }
  return { cleared, skipped_running };
}

module.exports = { getKept, upsertKept, clearKept };
