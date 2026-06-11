package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/something2/engine/internal/game"
)

// Postgres wraps a pgx pool and exposes batch UPSERTs the flush ticker uses.
type Postgres struct {
	pool *pgxpool.Pool
}

func NewPostgres(ctx context.Context, url string) (*Postgres, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("pgx pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pg ping: %w", err)
	}
	return &Postgres{pool: pool}, nil
}

func (p *Postgres) Close() { p.pool.Close() }

// LoadPlayerSpawn loads a player's last persisted position so we can resume
// them at the same place. Returns (nil, nil) if the player has no saved row.
func (p *Postgres) LoadPlayerSpawn(ctx context.Context, userID int64) (*game.Player, error) {
	row := p.pool.QueryRow(ctx,
		`SELECT user_id, map_id, x, y, hp FROM engine_players WHERE user_id = $1`, userID)
	var pl game.Player
	if err := row.Scan(&pl.UserID, &pl.MapID, &pl.X, &pl.Y, &pl.HP); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &pl, nil
}

// FlushPlayers performs a batched UPSERT of the given player snapshots.
// Returns the number of rows written.
func (p *Postgres) FlushPlayers(ctx context.Context, players []game.Player) (int, error) {
	if len(players) == 0 {
		return 0, nil
	}
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)

	const stmt = `
		INSERT INTO engine_players (user_id, map_id, x, y, hp, last_seen)
		VALUES ($1, $2::uuid, $3, $4, $5, NOW())
		ON CONFLICT (user_id) DO UPDATE SET
			map_id = EXCLUDED.map_id,
			x = EXCLUDED.x,
			y = EXCLUDED.y,
			hp = EXCLUDED.hp,
			last_seen = NOW()
	`
	for _, pl := range players {
		if _, err := tx.Exec(ctx, stmt, pl.UserID, pl.MapID, pl.X, pl.Y, pl.HP); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(players), nil
}

// FlushMobs performs a batched UPSERT of the given mob snapshots.
func (p *Postgres) FlushMobs(ctx context.Context, mobs []game.Mob) (int, error) {
	if len(mobs) == 0 {
		return 0, nil
	}
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)

	const stmt = `
		INSERT INTO engine_mobs (id, entity_type_id, map_id, x, y, hp, updated_at)
		VALUES ($1, $2, $3::uuid, $4, $5, $6, NOW())
		ON CONFLICT (id) DO UPDATE SET
			entity_type_id = EXCLUDED.entity_type_id,
			map_id = EXCLUDED.map_id,
			x = EXCLUDED.x,
			y = EXCLUDED.y,
			hp = EXCLUDED.hp,
			updated_at = NOW()
	`
	for _, m := range mobs {
		if _, err := tx.Exec(ctx, stmt, m.ID, m.EntityTypeID, m.MapID, m.X, m.Y, m.HP); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(mobs), nil
}
