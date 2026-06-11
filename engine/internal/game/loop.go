package game

import (
	"context"
	"log"
	"time"
)

// Broadcaster is implemented by the WS hub. The loop calls it once per tick
// per active map with the current snapshot + collision events.
type Broadcaster interface {
	BroadcastTick(mapID string, tick uint64, players []Player, mobs []Mob, collisions []Collision)
}

// Loop drives the world at a fixed tick rate.
type Loop struct {
	world  *World
	bcast  Broadcaster
	tickHz int
}

func NewLoop(w *World, bcast Broadcaster, tickHz int) *Loop {
	if tickHz <= 0 {
		tickHz = 60
	}
	return &Loop{world: w, bcast: bcast, tickHz: tickHz}
}

// Run drives the loop until ctx is cancelled. Blocks; run in its own goroutine.
func (l *Loop) Run(ctx context.Context) {
	interval := time.Second / time.Duration(l.tickHz)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	var tick uint64
	for {
		select {
		case <-ctx.Done():
			log.Printf("game loop: stopping after %d ticks", tick)
			return
		case <-ticker.C:
			tick++
			l.step(tick)
		}
	}
}

func (l *Loop) step(tick uint64) {
	for _, mapID := range l.world.MapIDs() {
		players, mobs := l.world.SnapshotMap(mapID)
		if len(players) == 0 && len(mobs) == 0 {
			continue
		}
		collisions := l.world.CollisionsForMap(mapID)
		l.bcast.BroadcastTick(mapID, tick, players, mobs, collisions)
	}
}
