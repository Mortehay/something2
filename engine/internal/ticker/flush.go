package ticker

import (
	"context"
	"log"
	"time"

	"github.com/something2/engine/internal/game"
	"github.com/something2/engine/internal/store"
)

// Flusher periodically batch-UPSERTs world state from memory into Postgres.
// Redis remains the source of truth for live data; this is durability only.
type Flusher struct {
	world    *game.World
	pg       *store.Postgres
	interval time.Duration
}

func NewFlusher(world *game.World, pg *store.Postgres, interval time.Duration) *Flusher {
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	return &Flusher{world: world, pg: pg, interval: interval}
}

// Run blocks until ctx is cancelled. It performs a final flush on shutdown so
// in-flight state isn't lost when the engine exits cleanly.
func (f *Flusher) Run(ctx context.Context) {
	t := time.NewTicker(f.interval)
	defer t.Stop()

	log.Printf("flush ticker: every %s", f.interval)
	for {
		select {
		case <-ctx.Done():
			log.Printf("flush ticker: shutting down, doing final flush")
			f.flush(context.Background())
			return
		case <-t.C:
			f.flush(ctx)
		}
	}
}

func (f *Flusher) flush(ctx context.Context) {
	start := time.Now()
	players := f.world.AllPlayers()
	mobs := f.world.AllMobs()

	pn, perr := f.pg.FlushPlayers(ctx, players)
	if perr != nil {
		log.Printf("flush players: %v", perr)
	}
	mn, merr := f.pg.FlushMobs(ctx, mobs)
	if merr != nil {
		log.Printf("flush mobs: %v", merr)
	}
	log.Printf("flush: players=%d mobs=%d in %s", pn, mn, time.Since(start))
}
