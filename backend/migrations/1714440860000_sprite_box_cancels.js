/* eslint-disable camelcase */
// sprite_box_cancels: every cancel something2 sends to the GPU box for a sheet
// job (SOMET-695). The box's DELETE sometimes marks a job cancelled while its
// worker keeps drawing, so each cancel is recorded and then verified against
// GET /api/jobs/{id}. At most one OPEN (not stopped) row per box job; stopped
// rows stay as history.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('sprite_box_cancels', {
    id: { type: 'bigserial', primaryKey: true },
    box_job_id: { type: 'text', notNull: true },
    sprite_set_id: { type: 'uuid' },
    subject: { type: 'text' },
    source: { type: 'text', notNull: true },
    state: {
      type: 'text', notNull: true, default: 'stopping',
      check: "state IN ('stopping','still_drawing','stopped')",
    },
    requested_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_progress: { type: 'text' },
    last_box_updated_at: { type: 'text' },
    last_change_at: { type: 'timestamptz' },
    checked_at: { type: 'timestamptz' },
    stopped_at: { type: 'timestamptz' },
  });
  pgm.createIndex('sprite_box_cancels', 'box_job_id', {
    name: 'sprite_box_cancels_open_uq', unique: true, where: "state <> 'stopped'",
  });
};

exports.down = (pgm) => {
  pgm.dropTable('sprite_box_cancels');
};
