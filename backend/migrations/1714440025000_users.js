exports.up = async (pgm) => {
  pgm.createExtension('citext', { ifNotExists: true });

  pgm.createTable('users', {
    id: 'id',
    username: { type: 'citext', notNull: true, unique: true },
    password_hash: { type: 'text', notNull: true },
    role: { type: 'text', notNull: true, default: 'player' },
    token_version: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('users', 'users_role_check', "CHECK (role IN ('player','admin'))");

  // Discard anonymous test data, then re-key ownership tables to a real FK.
  // These tables held only test detritus (see spec); wiping them is intended.
  pgm.sql('TRUNCATE player_equipment, player_items, world_players RESTART IDENTITY CASCADE;');
  for (const t of ['player_items', 'player_equipment', 'world_players']) {
    pgm.sql(`ALTER TABLE ${t} ALTER COLUMN user_id TYPE integer USING NULL;`);
    pgm.sql(`ALTER TABLE ${t} ALTER COLUMN user_id SET NOT NULL;`);
    pgm.addConstraint(t, `${t}_user_fk`,
      { foreignKeys: { columns: 'user_id', references: 'users(id)', onDelete: 'CASCADE' } });
  }

  // Canonical world the player spawns into. Guarded so re-running is a no-op.
  // NOTE: worlds.seed is NOT NULL with no default (see
  // 1714440012000_create_worlds_and_chunks.js) — the brief's INSERT omitted
  // it and fails against the live schema. Follow the app's own convention
  // for picking a seed when none is supplied (src/index.js's world-create
  // route: a random 31-bit value) rather than inventing a new one here.
  //
  // Idempotency MUST be a WHERE NOT EXISTS, not `ON CONFLICT DO NOTHING`:
  // worlds has no unique constraint on `name` (only the PK), so a bare
  // ON CONFLICT never fires against a fresh gen_random_uuid() id and every
  // migration re-run would insert ANOTHER 'Overworld'. The client auto-joins
  // "the Overworld", so duplicates would split players across worlds.
  pgm.sql(`INSERT INTO worlds (id, name, seed)
           SELECT gen_random_uuid(), 'Overworld', floor(random() * 2147483647)::bigint
           WHERE NOT EXISTS (SELECT 1 FROM worlds WHERE name = 'Overworld');`);

  // First admin from env. With no env set, NOTHING is created — no default
  // credentials. The hash is computed in JS (bcryptjs) and injected as a
  // literal; migrations run in Node so this is available.
  const u = process.env.ADMIN_USERNAME, p = process.env.ADMIN_PASSWORD;
  if (u && p) {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(p, 12);
    pgm.sql(`INSERT INTO users (username, password_hash, role)
             VALUES (${pgm.func(`'${u.replace(/'/g, "''")}'`)}, '${hash}', 'admin')
             ON CONFLICT (username) DO NOTHING;`);
  }
};

exports.down = (pgm) => {
  for (const t of ['player_items', 'player_equipment', 'world_players']) {
    pgm.dropConstraint(t, `${t}_user_fk`);
    pgm.sql(`ALTER TABLE ${t} ALTER COLUMN user_id TYPE text USING user_id::text;`);
  }
  pgm.dropTable('users');
  // citext + the seeded world are left in place: dropping an extension other
  // objects may use, and a world that may now hold real data, is riskier than
  // the small residue of leaving them.
};
