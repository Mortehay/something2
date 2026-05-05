exports.up = (pgm) => {
  pgm.addColumns('entity_types', {
    strength: { type: 'integer', default: 0 },
    dexterity: { type: 'integer', default: 0 },
    constitution: { type: 'integer', default: 0 },
    intelligence: { type: 'integer', default: 0 },
    wisdom: { type: 'integer', default: 0 },
    charisma: { type: 'integer', default: 0 },
    hp: { type: 'integer', default: 0 },
    max_hp: { type: 'integer', default: 0 },
    hp_regen_rate: { type: 'float', default: 0 },
    mana: { type: 'integer', default: 0 },
    max_mana: { type: 'integer', default: 0 },
    mana_regen_rate: { type: 'float', default: 0 },
    image: { type: 'text' }
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('entity_types', [
    'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
    'hp', 'max_hp', 'hp_regen_rate', 'mana', 'max_mana', 'mana_regen_rate', 'image'
  ]);
};
