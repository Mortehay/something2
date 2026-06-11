package ws

import (
	"context"
	"encoding/json"
	"log"
	"sync"

	"github.com/something2/engine/internal/game"
	"github.com/something2/engine/internal/store"
)

// Hub owns the set of live connections, routes inbound messages into the
// world, and fans tick broadcasts back out. It is the only goroutine that
// touches a client's send queue (besides the writer itself).
type Hub struct {
	world *game.World
	redis *store.Redis

	mu      sync.RWMutex
	clients map[*Client]struct{}
	byUser  map[int64]*Client
}

func NewHub(world *game.World, redis *store.Redis) *Hub {
	return &Hub{
		world:   world,
		redis:   redis,
		clients: make(map[*Client]struct{}),
		byUser:  make(map[int64]*Client),
	}
}

func (h *Hub) register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[c] = struct{}{}
	if existing, ok := h.byUser[c.userID]; ok && existing != c {
		// Drop the previous connection for this user (single-session policy).
		existing.close()
		delete(h.clients, existing)
	}
	h.byUser[c.userID] = c
}

func (h *Hub) unregister(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[c]; !ok {
		return
	}
	delete(h.clients, c)
	if cur, ok := h.byUser[c.userID]; ok && cur == c {
		delete(h.byUser, c.userID)
	}
	c.close()
	h.world.RemovePlayer(c.userID)
	log.Printf("leave: user=%d (remaining clients=%d)", c.userID, len(h.clients))
}

// HandleInbound applies a client message to world state and may push a reply
// back on that client.
func (h *Hub) HandleInbound(c *Client, msg Inbound) {
	switch msg.Type {
	case MsgPing:
		c.enqueue(PongPayload{Type: MsgPong})
	case MsgJoin:
		if msg.MapID == "" {
			c.enqueue(ErrorPayload{Type: MsgError, Message: "join: map_id required"})
			return
		}
		// Spawn at origin for now; a real implementation would consult Postgres
		// for last known position.
		p := h.world.JoinPlayer(c.userID, msg.MapID, 0, 0, 100)
		c.mapID = msg.MapID
		_ = h.persistPlayer(*p)
		log.Printf("join: user=%d map=%s (total clients=%d)", c.userID, msg.MapID, len(h.clients))
		c.enqueue(JoinedPayload{
			Type:     MsgJoined,
			PlayerID: c.userID,
			MapID:    msg.MapID,
		})
	case MsgMove:
		p, mapID := h.world.MovePlayer(c.userID, msg.X, msg.Y)
		if p == nil {
			c.enqueue(ErrorPayload{Type: MsgError, Message: "move: not joined"})
			return
		}
		c.mapID = mapID
		_ = h.persistPlayer(*p)
	default:
		c.enqueue(ErrorPayload{Type: MsgError, Message: "unknown message type: " + msg.Type})
	}
}

func (h *Hub) persistPlayer(p game.Player) error {
	if h.redis == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), redisOpTimeout)
	defer cancel()
	if err := h.redis.SavePlayer(ctx, p, redisPlayerTTL); err != nil {
		log.Printf("redis save player %d: %v", p.UserID, err)
		return err
	}
	return nil
}

// BroadcastTick is called by the game loop. Implements game.Broadcaster.
func (h *Hub) BroadcastTick(mapID string, tick uint64, players []game.Player, mobs []game.Mob, collisions []game.Collision) {
	state := StatePayload{
		Type:    MsgState,
		Tick:    tick,
		MapID:   mapID,
		Players: players,
		Mobs:    mobs,
	}
	body, err := json.Marshal(state)
	if err != nil {
		log.Printf("ws: marshal state: %v", err)
		return
	}

	collisionMsgs := buildCollisionMessages(collisions)

	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		if c.mapID != mapID {
			continue
		}
		c.enqueueRaw(body)
		if events, ok := collisionMsgs[c.userID]; ok {
			for _, ev := range events {
				c.enqueue(ev)
			}
		}
	}
}

// buildCollisionMessages turns world-wide collision pairs into per-player
// notifications. A pair (player A, player B) → two messages, one for each user.
func buildCollisionMessages(collisions []game.Collision) map[int64][]CollisionPayload {
	out := make(map[int64][]CollisionPayload)
	for _, col := range collisions {
		if col.A.Kind == game.KindPlayer {
			out[col.A.ID] = append(out[col.A.ID], CollisionPayload{
				Type: MsgCollision,
				With: kindString(col.B.Kind),
				ID:   col.B.ID,
			})
		}
		if col.B.Kind == game.KindPlayer {
			out[col.B.ID] = append(out[col.B.ID], CollisionPayload{
				Type: MsgCollision,
				With: kindString(col.A.Kind),
				ID:   col.A.ID,
			})
		}
	}
	return out
}

func kindString(k game.EntityKind) string {
	switch k {
	case game.KindPlayer:
		return "player"
	case game.KindMob:
		return "mob"
	}
	return "unknown"
}

// CloseAll terminates every active connection. Used during shutdown.
func (h *Hub) CloseAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		c.close()
	}
	h.clients = make(map[*Client]struct{})
	h.byUser = make(map[int64]*Client)
}
