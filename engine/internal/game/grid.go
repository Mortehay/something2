package game

import "math"

// EntityKind distinguishes what's stored in a cell so callers can filter.
type EntityKind uint8

const (
	KindPlayer EntityKind = iota + 1
	KindMob
)

// EntityRef is a lightweight handle into the spatial index.
type EntityRef struct {
	ID     int64
	Kind   EntityKind
	X, Y   float64
	Radius float64
}

// Grid is a uniform spatial hash for 2D AABB/circle queries on a sparse world.
// CellSize is in world units; pick it close to typical entity radius for best
// performance. Not safe for concurrent mutation — guard externally.
type Grid struct {
	cellSize float64
	cells    map[cellKey]map[refKey]EntityRef
	index    map[refKey]cellKey // reverse lookup so updates can move refs
}

type cellKey struct{ cx, cy int32 }
type refKey struct {
	id   int64
	kind EntityKind
}

func NewGrid(cellSize float64) *Grid {
	if cellSize <= 0 {
		cellSize = 4
	}
	return &Grid{
		cellSize: cellSize,
		cells:    make(map[cellKey]map[refKey]EntityRef),
		index:    make(map[refKey]cellKey),
	}
}

func (g *Grid) cell(x, y float64) cellKey {
	return cellKey{
		cx: int32(math.Floor(x / g.cellSize)),
		cy: int32(math.Floor(y / g.cellSize)),
	}
}

// Upsert inserts or moves a ref to its current (x, y) cell.
func (g *Grid) Upsert(ref EntityRef) {
	rk := refKey{id: ref.ID, kind: ref.Kind}
	newCell := g.cell(ref.X, ref.Y)
	if oldCell, ok := g.index[rk]; ok && oldCell != newCell {
		g.removeFromCell(oldCell, rk)
	}
	bucket, ok := g.cells[newCell]
	if !ok {
		bucket = make(map[refKey]EntityRef)
		g.cells[newCell] = bucket
	}
	bucket[rk] = ref
	g.index[rk] = newCell
}

// Remove deletes a ref by id+kind. No-op if not present.
func (g *Grid) Remove(id int64, kind EntityKind) {
	rk := refKey{id: id, kind: kind}
	cell, ok := g.index[rk]
	if !ok {
		return
	}
	g.removeFromCell(cell, rk)
	delete(g.index, rk)
}

func (g *Grid) removeFromCell(c cellKey, rk refKey) {
	if bucket, ok := g.cells[c]; ok {
		delete(bucket, rk)
		if len(bucket) == 0 {
			delete(g.cells, c)
		}
	}
}

// Len returns the total number of indexed refs.
func (g *Grid) Len() int { return len(g.index) }

// QueryCircle returns refs whose center is within `radius` of (x, y).
// Excludes the ref matching (excludeID, excludeKind) when both are non-zero.
func (g *Grid) QueryCircle(x, y, radius float64, excludeID int64, excludeKind EntityKind) []EntityRef {
	if radius <= 0 {
		return nil
	}
	r2 := radius * radius
	minCX := int32(math.Floor((x - radius) / g.cellSize))
	maxCX := int32(math.Floor((x + radius) / g.cellSize))
	minCY := int32(math.Floor((y - radius) / g.cellSize))
	maxCY := int32(math.Floor((y + radius) / g.cellSize))

	out := make([]EntityRef, 0, 8)
	for cx := minCX; cx <= maxCX; cx++ {
		for cy := minCY; cy <= maxCY; cy++ {
			bucket, ok := g.cells[cellKey{cx, cy}]
			if !ok {
				continue
			}
			for rk, ref := range bucket {
				if excludeKind != 0 && rk.id == excludeID && rk.kind == excludeKind {
					continue
				}
				dx := ref.X - x
				dy := ref.Y - y
				if dx*dx+dy*dy <= r2 {
					out = append(out, ref)
				}
			}
		}
	}
	return out
}

// Collisions returns pairs of refs whose circles overlap. Each pair is reported
// once, ordered by (kind, id) so output is deterministic for tests.
type Collision struct {
	A, B EntityRef
}

func (g *Grid) Collisions() []Collision {
	out := make([]Collision, 0)
	seen := make(map[[2]refKey]struct{})
	for c, bucket := range g.cells {
		// Pairs within this cell + neighbors (right/down/diag) so we don't
		// double-count.
		neighborOffsets := [...]cellKey{{0, 0}, {1, 0}, {0, 1}, {1, 1}, {-1, 1}}
		for _, off := range neighborOffsets {
			other, ok := g.cells[cellKey{c.cx + off.cx, c.cy + off.cy}]
			if !ok {
				continue
			}
			for ak, a := range bucket {
				for bk, b := range other {
					if ak == bk {
						continue
					}
					// Canonical pair order to dedupe across the symmetric pass.
					p := canonicalPair(ak, bk)
					if _, dup := seen[p]; dup {
						continue
					}
					dx := a.X - b.X
					dy := a.Y - b.Y
					rsum := a.Radius + b.Radius
					if dx*dx+dy*dy <= rsum*rsum {
						seen[p] = struct{}{}
						out = append(out, Collision{A: a, B: b})
					}
				}
			}
		}
	}
	return out
}

func canonicalPair(a, b refKey) [2]refKey {
	if a.kind < b.kind || (a.kind == b.kind && a.id < b.id) {
		return [2]refKey{a, b}
	}
	return [2]refKey{b, a}
}
