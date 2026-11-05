/* eslint-disable camelcase */
// entity_types.body_plan: what the creature's sheet is drawn as. NULL = not
// decided yet, drawn as today. 'other' = neither shape the box can pose, so it
// is not queued. body_plan_source: 'llm' may be redone, 'admin' is never overwritten.
// sprite_sets.body_plan: what the row was queued with.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('entity_types', {
    body_plan: { type: 'text', check: "body_plan IN ('humanoid', 'quadruped', 'other')" },
    body_plan_source: { type: 'text', check: "body_plan_source IN ('llm', 'admin')" },
  });
  pgm.addColumn('sprite_sets', { body_plan: { type: 'text' } });
};

exports.down = (pgm) => {
  pgm.dropColumn('sprite_sets', 'body_plan');
  pgm.dropColumn('entity_types', ['body_plan', 'body_plan_source']);
};
