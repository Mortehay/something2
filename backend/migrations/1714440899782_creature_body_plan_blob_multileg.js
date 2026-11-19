/* eslint-disable camelcase */
// Two more creature bodies, set from the concept picture: blob (no limbs,
// squash and stretch) and multileg (spider, crab, tentacles). Additive: the
// three earlier values keep their meaning. Whether the GPU box can draw a body
// is its action catalog's call (actions[].body_plans), checked at queue time.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.dropConstraint('entity_types', 'entity_types_body_plan_check');
  pgm.addConstraint('entity_types', 'entity_types_body_plan_check', {
    check: "body_plan IN ('humanoid', 'quadruped', 'other', 'blob', 'multileg')",
  });
};

exports.down = (pgm) => {
  pgm.sql("UPDATE entity_types SET body_plan = NULL, body_plan_source = NULL WHERE body_plan IN ('blob', 'multileg')");
  pgm.dropConstraint('entity_types', 'entity_types_body_plan_check');
  pgm.addConstraint('entity_types', 'entity_types_body_plan_check', {
    check: "body_plan IN ('humanoid', 'quadruped', 'other')",
  });
};
