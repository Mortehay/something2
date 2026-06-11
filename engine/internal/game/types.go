package game

import "time"

const (
	defaultPlayerRadius = 0.5
	defaultMobRadius    = 0.5
)

// Player is the engine-authoritative state for a connected user. MapID is a
// UUID string because the backend's `maps.id` column is `uuid`.
type Player struct {
	UserID    int64     `json:"user_id"`
	MapID     string    `json:"map_id"`
	X         float64   `json:"x"`
	Y         float64   `json:"y"`
	HP        int       `json:"hp"`
	Radius    float64   `json:"radius"`
	UpdatedAt time.Time `json:"-"`
}

// Mob is an NPC/aggressive entity tracked by the engine.
type Mob struct {
	ID           int64     `json:"id"`
	EntityTypeID int64     `json:"entity_type_id"`
	MapID        string    `json:"map_id"`
	X            float64   `json:"x"`
	Y            float64   `json:"y"`
	HP           int       `json:"hp"`
	Radius       float64   `json:"radius"`
	UpdatedAt    time.Time `json:"-"`
}

// CollisionEvent is emitted by the loop and consumed by the WS hub.
type CollisionEvent struct {
	MapID string
	A     EntityRef
	B     EntityRef
}
