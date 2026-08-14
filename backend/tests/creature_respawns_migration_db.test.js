const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('creature_respawns table has the columns the respawn queue needs', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'creature_respawns' ORDER BY column_name`,
    );
    const byName = Object.fromEntries(r.rows.map((c) => [c.column_name, c]));

    assert.equal(byName.world_id.data_type, 'uuid');
    assert.equal(byName.world_id.is_nullable, 'NO');
    assert.equal(byName.type.data_type, 'text');
    assert.equal(byName.level.data_type, 'integer');
    assert.equal(byName.respawn_at.data_type, 'timestamp with time zone');
    assert.equal(byName.respawn_at.is_nullable, 'NO');
    assert.equal(byName.x.data_type, 'real');
    assert.equal(byName.y.data_type, 'real');
  } finally {
    await pool.end();
  }
});

test('deleting a world removes its queued respawns', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT confdeltype FROM pg_constraint
        WHERE conrelid = 'creature_respawns'::regclass AND contype = 'f'
          AND confrelid = 'worlds'::regclass`,
    );
    assert.equal(r.rowCount, 1);
    // 'c' = ON DELETE CASCADE. A queue row outliving its world would be a
    // permanently undeliverable respawn.
    assert.equal(r.rows[0].confdeltype, 'c');
  } finally {
    await pool.end();
  }
});
