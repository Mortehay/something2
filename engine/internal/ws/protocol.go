package ws

import "github.com/something2/engine/internal/game"

// Wire-format message types. The `Type` discriminator is matched on both ends.
const (
	MsgJoin      = "join"
	MsgMove      = "move"
	MsgPing      = "ping"
	MsgJoined    = "joined"
	MsgState     = "state"
	MsgCollision = "collision"
	MsgError     = "error"
	MsgPong      = "pong"
)

type Inbound struct {
	Type  string  `json:"type"`
	MapID string  `json:"map_id,omitempty"`
	X     float64 `json:"x,omitempty"`
	Y     float64 `json:"y,omitempty"`
}

type JoinedPayload struct {
	Type     string `json:"type"`
	PlayerID int64  `json:"player_id"`
	MapID    string `json:"map_id"`
	Tick     uint64 `json:"tick"`
}

type StatePayload struct {
	Type    string        `json:"type"`
	Tick    uint64        `json:"tick"`
	MapID   string        `json:"map_id"`
	Players []game.Player `json:"players"`
	Mobs    []game.Mob    `json:"mobs"`
}

type CollisionPayload struct {
	Type string `json:"type"`
	With string `json:"with"` // "player" | "mob"
	ID   int64  `json:"id"`
}

type ErrorPayload struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

type PongPayload struct {
	Type string `json:"type"`
}
