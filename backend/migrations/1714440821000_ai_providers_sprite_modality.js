exports.shorthands = undefined;

// GPU-box sprite sheets (Task 4b): ai_providers gains the 'sprite' modality --
// the box's /api/jobs + /api/action-catalog sprite service, one active per
// modality like image, audio and text (ai_providers_single_active_per_modality
// is keyed on modality, so no index change is needed).
exports.up = (pgm) => {
  pgm.dropConstraint('ai_providers', 'ai_providers_modality_check');
  pgm.addConstraint('ai_providers', 'ai_providers_modality_check', {
    check: "modality IN ('image', 'audio', 'text', 'sprite')",
  });
};

exports.down = (pgm) => {
  pgm.sql("DELETE FROM ai_providers WHERE modality = 'sprite'");
  pgm.dropConstraint('ai_providers', 'ai_providers_modality_check');
  pgm.addConstraint('ai_providers', 'ai_providers_modality_check', {
    check: "modality IN ('image', 'audio', 'text')",
  });
};
