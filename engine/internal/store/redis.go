package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/something2/engine/internal/game"
)

// Redis wraps a go-redis client with engine-shaped helpers. Keys:
//   player:<user_id>            → JSON Player
//   map:<map_id>:players        → SET of user_ids
type Redis struct {
	c *redis.Client
}

func NewRedis(ctx context.Context, url string) (*Redis, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}
	c := redis.NewClient(opts)
	if err := c.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping: %w", err)
	}
	return &Redis{c: c}, nil
}

func (r *Redis) Close() error { return r.c.Close() }

func playerKey(userID int64) string    { return fmt.Sprintf("player:%d", userID) }
func mapPlayersKey(mapID string) string { return fmt.Sprintf("map:%s:players", mapID) }

// SavePlayer writes the player's live position. Pipeline-grouped so the SET +
// SADD land together.
func (r *Redis) SavePlayer(ctx context.Context, p game.Player, ttl time.Duration) error {
	body, err := json.Marshal(p)
	if err != nil {
		return err
	}
	pipe := r.c.Pipeline()
	pipe.Set(ctx, playerKey(p.UserID), body, ttl)
	pipe.SAdd(ctx, mapPlayersKey(p.MapID), p.UserID)
	_, err = pipe.Exec(ctx)
	return err
}

// RemovePlayer drops the live state for a user.
func (r *Redis) RemovePlayer(ctx context.Context, userID int64, mapID string) error {
	pipe := r.c.Pipeline()
	pipe.Del(ctx, playerKey(userID))
	pipe.SRem(ctx, mapPlayersKey(mapID), userID)
	_, err := pipe.Exec(ctx)
	return err
}

// LoadPlayer returns the persisted live state, or (nil, nil) if absent.
func (r *Redis) LoadPlayer(ctx context.Context, userID int64) (*game.Player, error) {
	body, err := r.c.Get(ctx, playerKey(userID)).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var p game.Player
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, err
	}
	return &p, nil
}
