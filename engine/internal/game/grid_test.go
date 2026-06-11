package game

import (
	"sort"
	"testing"
)

func TestGrid_UpsertAndQueryCircle(t *testing.T) {
	g := NewGrid(4)
	g.Upsert(EntityRef{ID: 1, Kind: KindPlayer, X: 0, Y: 0, Radius: 1})
	g.Upsert(EntityRef{ID: 2, Kind: KindMob, X: 2, Y: 2, Radius: 1})
	g.Upsert(EntityRef{ID: 3, Kind: KindMob, X: 100, Y: 100, Radius: 1})

	got := g.QueryCircle(0, 0, 5, 0, 0)
	if len(got) != 2 {
		t.Fatalf("expected 2 hits, got %d (%v)", len(got), got)
	}
}

func TestGrid_QueryCircleExcludesSelf(t *testing.T) {
	g := NewGrid(4)
	g.Upsert(EntityRef{ID: 1, Kind: KindPlayer, X: 0, Y: 0, Radius: 1})
	g.Upsert(EntityRef{ID: 2, Kind: KindMob, X: 1, Y: 0, Radius: 1})

	got := g.QueryCircle(0, 0, 3, 1, KindPlayer)
	if len(got) != 1 || got[0].ID != 2 {
		t.Fatalf("expected only mob 2, got %v", got)
	}
}

func TestGrid_UpsertMovesEntity(t *testing.T) {
	g := NewGrid(4)
	g.Upsert(EntityRef{ID: 1, Kind: KindPlayer, X: 0, Y: 0, Radius: 1})
	g.Upsert(EntityRef{ID: 1, Kind: KindPlayer, X: 50, Y: 50, Radius: 1})

	if got := g.QueryCircle(0, 0, 3, 0, 0); len(got) != 0 {
		t.Fatalf("expected no hits at origin, got %v", got)
	}
	if got := g.QueryCircle(50, 50, 3, 0, 0); len(got) != 1 {
		t.Fatalf("expected 1 hit at (50,50), got %v", got)
	}
	if g.Len() != 1 {
		t.Fatalf("expected len=1, got %d", g.Len())
	}
}

func TestGrid_Remove(t *testing.T) {
	g := NewGrid(4)
	g.Upsert(EntityRef{ID: 1, Kind: KindPlayer, X: 0, Y: 0, Radius: 1})
	g.Remove(1, KindPlayer)
	if g.Len() != 0 {
		t.Fatalf("expected len=0 after remove, got %d", g.Len())
	}
	if got := g.QueryCircle(0, 0, 3, 0, 0); len(got) != 0 {
		t.Fatalf("expected no hits after remove, got %v", got)
	}
}

func TestGrid_CollisionsAcrossCells(t *testing.T) {
	g := NewGrid(4)
	// Two entities sit on opposite sides of a cell boundary but overlap.
	g.Upsert(EntityRef{ID: 1, Kind: KindPlayer, X: 3.9, Y: 0, Radius: 0.5})
	g.Upsert(EntityRef{ID: 2, Kind: KindMob, X: 4.1, Y: 0, Radius: 0.5})
	// Far away — no collision.
	g.Upsert(EntityRef{ID: 3, Kind: KindMob, X: 100, Y: 100, Radius: 1})

	cs := g.Collisions()
	if len(cs) != 1 {
		t.Fatalf("expected 1 collision across cell boundary, got %d (%v)", len(cs), cs)
	}
	pair := []int64{cs[0].A.ID, cs[0].B.ID}
	sort.Slice(pair, func(i, j int) bool { return pair[i] < pair[j] })
	if pair[0] != 1 || pair[1] != 2 {
		t.Fatalf("expected pair (1,2), got (%d,%d)", pair[0], pair[1])
	}
}

func TestGrid_CollisionsNoDuplicates(t *testing.T) {
	g := NewGrid(4)
	g.Upsert(EntityRef{ID: 1, Kind: KindPlayer, X: 0, Y: 0, Radius: 1})
	g.Upsert(EntityRef{ID: 2, Kind: KindMob, X: 1, Y: 1, Radius: 1})
	g.Upsert(EntityRef{ID: 3, Kind: KindMob, X: 0.5, Y: 0.5, Radius: 1})

	cs := g.Collisions()
	// 3 entities all overlapping → C(3,2) = 3 pairs.
	if len(cs) != 3 {
		t.Fatalf("expected 3 unique pairs, got %d (%v)", len(cs), cs)
	}
}
