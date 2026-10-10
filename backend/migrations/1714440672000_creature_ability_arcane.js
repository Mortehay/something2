// SOMET-603: creature_abilities.element accepts 'arcane'.
// entity_types.attack_element already does (1714440670000) and the sim's
// damage.js ELEMENTS has it; without this, an arcane ability passes the
// validator (creatureBehaviors.ELEMENTS) and dies on the CHECK as a raw 500.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE creature_abilities DROP CONSTRAINT creature_abilities_element_check;
    ALTER TABLE creature_abilities ADD CONSTRAINT creature_abilities_element_check
      CHECK (element IS NULL OR element IN ('physical','arcane','fire','ice','lightning'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE creature_abilities SET element = NULL WHERE element = 'arcane';
    ALTER TABLE creature_abilities DROP CONSTRAINT creature_abilities_element_check;
    ALTER TABLE creature_abilities ADD CONSTRAINT creature_abilities_element_check
      CHECK (element IS NULL OR element IN ('physical','fire','ice','lightning'));
  `);
};
