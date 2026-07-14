package game

import (
	"sync"
	"time"
)

// World holds per-map authoritative state. All mutations go through the
// world's mutex; the tick loop reads under the same lock.
type World struct {
	mu           sync.RWMutex
	gridCellSize float64

	maps map[string]*mapState
}

type mapState struct {
	id      string
	players map[int64]*Player
	mobs    map[int64]*Mob
	grid    *Grid
}

func NewWorld(gridCellSize float64) *World {
	return &World{
		gridCellSize: gridCellSize,
		maps:         make(map[string]*mapState),
	}
}

func (w *World) getOrCreateMap(mapID string) *mapState {
	if m, ok := w.maps[mapID]; ok {
		return m
	}
	m := &mapState{
		id:      mapID,
		players: make(map[int64]*Player),
		mobs:    make(map[int64]*Mob),
		grid:    NewGrid(w.gridCellSize),
	}
	w.maps[mapID] = m
	return m
}

// JoinPlayer puts a player on a map at (x, y), removing them from any prior map.
func (w *World) JoinPlayer(userID int64, mapID string, x, y float64, hp int) *Player {
	w.mu.Lock()
	defer w.mu.Unlock()

	w.removePlayerLocked(userID)

	m := w.getOrCreateMap(mapID)
	p := &Player{
		UserID:    userID,
		MapID:     mapID,
		X:         x,
		Y:         y,
		HP:        hp,
		Radius:    defaultPlayerRadius,
		UpdatedAt: time.Now(),
	}
	m.players[userID] = p
	m.grid.Upsert(EntityRef{ID: userID, Kind: KindPlayer, X: x, Y: y, Radius: p.Radius})
	return p
}

// MovePlayer updates a player's position. Returns the player and the map id
// they live on, or (nil, "") if the player isn't joined.
func (w *World) MovePlayer(userID int64, x, y float64) (*Player, string) {
	w.mu.Lock()
	defer w.mu.Unlock()

	for mapID, m := range w.maps {
		if p, ok := m.players[userID]; ok {
			p.X = x
			p.Y = y
			p.UpdatedAt = time.Now()
			m.grid.Upsert(EntityRef{ID: userID, Kind: KindPlayer, X: x, Y: y, Radius: p.Radius})
			return p, mapID
		}
	}
	return nil, ""
}

// RemovePlayer removes a player from whichever map they're on.
func (w *World) RemovePlayer(userID int64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.removePlayerLocked(userID)
}

func (w *World) removePlayerLocked(userID int64) {
	for _, m := range w.maps {
		if _, ok := m.players[userID]; ok {
			delete(m.players, userID)
			m.grid.Remove(userID, KindPlayer)
			return
		}
	}
}

// SpawnMob inserts or updates a mob.
func (w *World) SpawnMob(mob Mob) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if mob.Radius == 0 {
		mob.Radius = defaultMobRadius
	}
	mob.UpdatedAt = time.Now()
	m := w.getOrCreateMap(mob.MapID)
	cp := mob
	m.mobs[mob.ID] = &cp
	m.grid.Upsert(EntityRef{ID: mob.ID, Kind: KindMob, X: mob.X, Y: mob.Y, Radius: mob.Radius})
}

// SnapshotMap returns immutable copies of players and mobs on a map.
func (w *World) SnapshotMap(mapID string) ([]Player, []Mob) {
	w.mu.RLock()
	defer w.mu.RUnlock()
	m, ok := w.maps[mapID]
	if !ok {
		return nil, nil
	}
	players := make([]Player, 0, len(m.players))
	for _, p := range m.players {
		players = append(players, *p)
	}
	mobs := make([]Mob, 0, len(m.mobs))
	for _, mb := range m.mobs {
		mobs = append(mobs, *mb)
	}
	return players, mobs
}

// AllPlayers returns a copy of every active player across every map. Used by
// the flush ticker.
func (w *World) AllPlayers() []Player {
	w.mu.RLock()
	defer w.mu.RUnlock()
	out := make([]Player, 0)
	for _, m := range w.maps {
		for _, p := range m.players {
			out = append(out, *p)
		}
	}
	return out
}

// AllMobs returns a copy of every mob across every map.
func (w *World) AllMobs() []Mob {
	w.mu.RLock()
	defer w.mu.RUnlock()
	out := make([]Mob, 0)
	for _, m := range w.maps {
		for _, mb := range m.mobs {
			out = append(out, *mb)
		}
	}
	return out
}

// MapIDs returns the ids of all live maps. Used for per-tick broadcasts.
func (w *World) MapIDs() []string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	out := make([]string, 0, len(w.maps))
	for id := range w.maps {
		out = append(out, id)
	}
	return out
}

// CollisionsForMap returns all overlapping pairs on a single map.
func (w *World) CollisionsForMap(mapID string) []Collision {
	w.mu.RLock()
	defer w.mu.RUnlock()
	m, ok := w.maps[mapID]
	if !ok {
		return nil
	}
	return m.grid.Collisions()
}
