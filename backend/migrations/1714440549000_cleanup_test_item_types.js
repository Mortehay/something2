// Cleans up dangling test fixture item_types, test characters, and test users
// left behind by automated test runs on shared databases.

exports.up = (pgm) => {
  // 1. Delete player_equipment, player_item_affixes, and player_items referencing test item types
  pgm.sql(`
    DELETE FROM player_equipment WHERE item_id IN (
      SELECT id FROM player_items WHERE item_type_id IN (
        SELECT id FROM item_types WHERE
          name ~ '^(resp|noop|req|ok|dep|free|over|atcap|circ|s496|s484|s498|s500|probe|test|zz)-'
          OR name ~ '-test-'
          OR name ~ '^s[0-9]+[_-]'
          OR name ~ '-resp-[0-9]+'
          OR name ~ '-noop-[0-9]+'
          OR name ~ '-lvl-[0-9]+'
          OR name ~ '-okeq-[0-9]+'
          OR name ~ '-dep-[0-9]+'
          OR name ~ '-free-[0-9]+'
          OR name ~ '-over-[0-9]+'
          OR name ~ '-atcap-[0-9]+'
          OR name ~ '-circ-[0-9]+'
      )
    );

    DELETE FROM player_item_affixes WHERE player_item_id IN (
      SELECT id FROM player_items WHERE item_type_id IN (
        SELECT id FROM item_types WHERE
          name ~ '^(resp|noop|req|ok|dep|free|over|atcap|circ|s496|s484|s498|s500|probe|test|zz)-'
          OR name ~ '-test-'
          OR name ~ '^s[0-9]+[_-]'
          OR name ~ '-resp-[0-9]+'
          OR name ~ '-noop-[0-9]+'
          OR name ~ '-lvl-[0-9]+'
          OR name ~ '-okeq-[0-9]+'
          OR name ~ '-dep-[0-9]+'
          OR name ~ '-free-[0-9]+'
          OR name ~ '-over-[0-9]+'
          OR name ~ '-atcap-[0-9]+'
          OR name ~ '-circ-[0-9]+'
      )
    );

    DELETE FROM stone_instances WHERE player_item_id IN (
      SELECT id FROM player_items WHERE item_type_id IN (
        SELECT id FROM item_types WHERE
          name ~ '^(resp|noop|req|ok|dep|free|over|atcap|circ|s496|s484|s498|s500|probe|test|zz)-'
          OR name ~ '-test-'
          OR name ~ '^s[0-9]+[_-]'
          OR name ~ '-resp-[0-9]+'
          OR name ~ '-noop-[0-9]+'
          OR name ~ '-lvl-[0-9]+'
          OR name ~ '-okeq-[0-9]+'
          OR name ~ '-dep-[0-9]+'
          OR name ~ '-free-[0-9]+'
          OR name ~ '-over-[0-9]+'
          OR name ~ '-atcap-[0-9]+'
          OR name ~ '-circ-[0-9]+'
      )
    );

    DELETE FROM merchant_stock WHERE item_type_id IN (
      SELECT id FROM item_types WHERE
        name ~ '^(resp|noop|req|ok|dep|free|over|atcap|circ|s496|s484|s498|s500|probe|test|zz)-'
        OR name ~ '-test-'
        OR name ~ '^s[0-9]+[_-]'
        OR name ~ '-resp-[0-9]+'
        OR name ~ '-noop-[0-9]+'
        OR name ~ '-lvl-[0-9]+'
        OR name ~ '-okeq-[0-9]+'
        OR name ~ '-dep-[0-9]+'
        OR name ~ '-free-[0-9]+'
        OR name ~ '-over-[0-9]+'
        OR name ~ '-atcap-[0-9]+'
        OR name ~ '-circ-[0-9]+'
    );

    DELETE FROM world_items WHERE item_type_id IN (
      SELECT id FROM item_types WHERE
        name ~ '^(resp|noop|req|ok|dep|free|over|atcap|circ|s496|s484|s498|s500|probe|test|zz)-'
        OR name ~ '-test-'
        OR name ~ '^s[0-9]+[_-]'
        OR name ~ '-resp-[0-9]+'
        OR name ~ '-noop-[0-9]+'
        OR name ~ '-lvl-[0-9]+'
        OR name ~ '-okeq-[0-9]+'
        OR name ~ '-dep-[0-9]+'
        OR name ~ '-free-[0-9]+'
        OR name ~ '-over-[0-9]+'
        OR name ~ '-atcap-[0-9]+'
        OR name ~ '-circ-[0-9]+'
    );

    DELETE FROM account_items WHERE item_type_id IN (
      SELECT id FROM item_types WHERE
        name ~ '^(resp|noop|req|ok|dep|free|over|atcap|circ|s496|s484|s498|s500|probe|test|zz)-'
        OR name ~ '-test-'
        OR name ~ '^s[0-9]+[_-]'
        OR name ~ '-resp-[0-9]+'
        OR name ~ '-noop-[0-9]+'
        OR name ~ '-lvl-[0-9]+'
        OR name ~ '-okeq-[0-9]+'
        OR name ~ '-dep-[0-9]+'
        OR name ~ '-free-[0-9]+'
        OR name ~ '-over-[0-9]+'
        OR name ~ '-atcap-[0-9]+'
        OR name ~ '-circ-[0-9]+'
    );

    DELETE FROM player_items WHERE item_type_id IN (
      SELECT id FROM item_types WHERE
        name ~ '^(resp|noop|req|ok|dep|free|over|atcap|circ|s496|s484|s498|s500|probe|test|zz)-'
        OR name ~ '-test-'
        OR name ~ '^s[0-9]+[_-]'
        OR name ~ '-resp-[0-9]+'
        OR name ~ '-noop-[0-9]+'
        OR name ~ '-lvl-[0-9]+'
        OR name ~ '-okeq-[0-9]+'
        OR name ~ '-dep-[0-9]+'
        OR name ~ '-free-[0-9]+'
        OR name ~ '-over-[0-9]+'
        OR name ~ '-atcap-[0-9]+'
        OR name ~ '-circ-[0-9]+'
    );

    DELETE FROM item_types WHERE
      name ~ '^(resp|noop|req|ok|dep|free|over|atcap|circ|s496|s484|s498|s500|probe|test|zz)-'
      OR name ~ '-test-'
      OR name ~ '^s[0-9]+[_-]'
      OR name ~ '-resp-[0-9]+'
      OR name ~ '-noop-[0-9]+'
      OR name ~ '-lvl-[0-9]+'
      OR name ~ '-okeq-[0-9]+'
      OR name ~ '-dep-[0-9]+'
      OR name ~ '-free-[0-9]+'
      OR name ~ '-over-[0-9]+'
      OR name ~ '-atcap-[0-9]+'
      OR name ~ '-circ-[0-9]+';

    -- Delete leftover test users and their cascading characters/progression
    DELETE FROM users WHERE
      username ~ '^(reqtest|gearladder|s496|s484|s498|s500|zzTest)-';
  `);
};

exports.down = () => {
  // Irreversible cleanup of test garbage
};
