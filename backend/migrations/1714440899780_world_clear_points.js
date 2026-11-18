/* eslint-disable camelcase */
// SOMET-780: tiles decoration placement must keep blockers off, carried ON
// THE WORLD ROW like dungeon_boss, so every generation site (/chunk, the
// authority, seed-map's guard, the scanners, population) sees them with no new
// query -- the drift SOMET-510 / SOMET-772 ruled out.
//
// worlds.clear_points = [{ row, col }] of the world's AUTHORED vault chest
// (kind 'vault', not a timed boss-death chest) and its waypoints. Kept true by
// triggers on both tables, so no write path (seed-map, admin moves, seed-sync)
// can forget it. Only position/ownership changes fire: a chest opening and
// relocking every few minutes never touches the world row.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('worlds', { clear_points: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") } });
  pgm.sql(`CREATE FUNCTION world_clear_points_refresh(wid uuid) RETURNS void LANGUAGE plpgsql AS $f$
    BEGIN
      IF wid IS NULL THEN RETURN; END IF;
      UPDATE worlds w SET clear_points = p.pts
        FROM (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('row', r, 'col', c) ORDER BY r, c), '[]'::jsonb) AS pts
            FROM (
              SELECT DISTINCT floor(y / 100)::int AS r, floor(x / 100)::int AS c FROM (
                SELECT x, y FROM world_chests WHERE world_id = wid AND kind = 'vault' AND expires_at IS NULL
                UNION ALL
                SELECT x, y FROM waypoints WHERE world_id = wid
              ) s WHERE x IS NOT NULL AND y IS NOT NULL
            ) cells
        ) p
       WHERE w.id = wid AND w.clear_points IS DISTINCT FROM p.pts;
    END $f$`);
  pgm.sql(`CREATE FUNCTION world_clear_points_trigger() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM world_clear_points_refresh(OLD.world_id); END IF;
      IF TG_OP IN ('UPDATE', 'INSERT') AND (TG_OP = 'INSERT' OR NEW.world_id IS DISTINCT FROM OLD.world_id) THEN
        PERFORM world_clear_points_refresh(NEW.world_id);
      END IF;
      RETURN NULL;
    END $f$`);
  pgm.sql(`CREATE TRIGGER world_chests_clear_points
    AFTER INSERT OR DELETE OR UPDATE OF world_id, x, y, kind, expires_at ON world_chests
    FOR EACH ROW EXECUTE FUNCTION world_clear_points_trigger()`);
  pgm.sql(`CREATE TRIGGER waypoints_clear_points
    AFTER INSERT OR DELETE OR UPDATE OF world_id, x, y ON waypoints
    FOR EACH ROW EXECUTE FUNCTION world_clear_points_trigger()`);
  pgm.sql('SELECT world_clear_points_refresh(id) FROM worlds');
};

exports.down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS waypoints_clear_points ON waypoints');
  pgm.sql('DROP TRIGGER IF EXISTS world_chests_clear_points ON world_chests');
  pgm.sql('DROP FUNCTION IF EXISTS world_clear_points_trigger()');
  pgm.sql('DROP FUNCTION IF EXISTS world_clear_points_refresh(uuid)');
  pgm.dropColumns('worlds', ['clear_points']);
};
