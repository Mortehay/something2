// backend/migrations/1714440830000_character_quest_nodes.js
//
// Which quest nodes a character has already used FOR WHICH QUEST. Keyed by
// quest as well as node so that abandoning a quest (which deletes its
// character_quests row) cascades its nodes away and the quest can be redone;
// a per-character-only key would leave the nodes spent and the quest stuck.
//
// The composite FK targets character_quests' primary key
// (character_id, quest_id) -- constraint character_quests_pkey.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS character_quest_nodes (
      character_id integer NOT NULL,
      quest_id integer NOT NULL,
      node_key varchar(96) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (character_id, quest_id, node_key),
      FOREIGN KEY (character_id, quest_id)
        REFERENCES character_quests (character_id, quest_id) ON DELETE CASCADE
    )
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS character_quest_nodes');
};
