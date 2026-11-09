// backend/migrations/1714440875000_archer_evasion_nodes.js
//
// The Archer's defence was one dodge notable and one keystone. This turns a handful of dexterity
// nodes that granted a resist (or life) the Archer had no use for into EVASION nodes, and gives the
// dodge two effects beyond the chance itself (new rules dodgeStamina and dodgeRiposte, consumed in
// skillBalance.mitigateIncoming):
//
//   Light Feet  +dodge chance          Slipstream  stamina back for every dodge
//   Riposte     part of a dodged blow is sent back at the attacker
//   Hunter's Reflexes 3% -> 5%         Phantom Step also pays stamina and returns 25% of the blow
//
// Rows are matched by key AND their current label, so a node an admin has already edited is left
// alone, and a character's allocations (character_passives.node_id) are untouched: only what the node
// grants changes. The generator spec (seeds/data/passiveTree.js) carries the same nodes as templates,
// so a fresh tree has them too; a FORCE reseed of an existing tree would put the old resist nodes back.
exports.shorthands = undefined;

const R = (rule, value) => ({ type: 'rule', rule, value });

// [key, old label, old grants, new label, new grants]
const CHANGES = [
  ['dexterity-r1-3-2', 'Fireproof', [{ type: 'resist', element: 'fire', value: 5 }], 'Light Feet', [R('dodgeChance', 0.02)]],
  ['dexterity-r3-1-8', 'Fireproof', [{ type: 'resist', element: 'fire', value: 5 }], 'Light Feet', [R('dodgeChance', 0.03)]],
  ['dexterity-r4-2-23', 'Fireproof', [{ type: 'resist', element: 'fire', value: 5 }], 'Light Feet', [R('dodgeChance', 0.03)]],
  ['dexterity-r3-2-17', 'Grounding', [{ type: 'resist', element: 'lightning', value: 5 }], 'Slipstream', [R('dodgeStamina', 5), R('dodgeChance', 0.01)]],
  ['dexterity-r4-1-6', 'Grounding', [{ type: 'resist', element: 'lightning', value: 5 }], 'Slipstream', [R('dodgeStamina', 5), R('dodgeChance', 0.01)]],
  ['dexterity-r4-3-0', 'Grounding', [{ type: 'resist', element: 'lightning', value: 5 }], 'Slipstream', [R('dodgeStamina', 5), R('dodgeChance', 0.01)]],
  ['dexterity-r1-1-7', 'Plating', [{ type: 'resist', element: 'physical', value: 5 }], 'Riposte', [R('dodgeRiposte', 0.2)]],
  ['dexterity-r3-2-6', 'Thick Skin', [{ type: 'resource', pool: 'hp', value: 25 }], 'Riposte', [R('dodgeRiposte', 0.3)]],
  ['dexterity-r3-1-23', "Hunter's Reflexes", [R('dodgeChance', 0.03)], "Hunter's Reflexes", [R('dodgeChance', 0.05)]],
  [
    'dexterity-r3-2-19',
    'Phantom Step — 15% chance to dodge a blow outright, +20 max stamina',
    [R('dodgeChance', 0.15), { type: 'resource', pool: 'stamina', value: 20 }],
    'Phantom Step — 15% chance to dodge a blow outright, +20 max stamina; a dodge restores 8 stamina and returns 25% of the blow',
    [R('dodgeChance', 0.15), { type: 'resource', pool: 'stamina', value: 20 }, R('dodgeStamina', 8), R('dodgeRiposte', 0.25)],
  ],
];

const SQL = 'UPDATE passive_nodes SET label = $1, grants = $2::jsonb WHERE key = $3 AND label = $4';

exports.up = async (pgm) => {
  for (const [key, oldLabel, , newLabel, newGrants] of CHANGES) {
    await pgm.db.query(SQL, [newLabel, JSON.stringify(newGrants), key, oldLabel]);
  }
};

exports.down = async (pgm) => {
  for (const [key, oldLabel, oldGrants, newLabel] of CHANGES) {
    await pgm.db.query(SQL, [oldLabel, JSON.stringify(oldGrants), key, newLabel]);
  }
};

