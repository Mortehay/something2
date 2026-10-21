import { describe, it, expect } from "vitest";
import { EntityAnimState, MOVING_HOLD_MS, phaseFor } from "../entityAnimState.js";

describe("EntityAnimState", () => {
  it("has no state for an entity it never saw", () => {
    const s = new EntityAnimState();
    expect(s.stateFor("c:1")).toBe(null);
  });

  it("records attacks and casts separately", () => {
    const s = new EntityAnimState();
    s.noteAttack("c:1", 100, false);
    s.noteAttack("c:1", 200, true);
    const r = s.stateFor("c:1");
    expect(r.attackAt).toBe(100);
    expect(r.castAt).toBe(200);
  });

  it("records hits", () => {
    const s = new EntityAnimState();
    s.noteHit("p:7", 50);
    expect(s.stateFor("p:7").hitAt).toBe(50);
  });

  it("never seen moving until it has moved since a previous observation", () => {
    const s = new EntityAnimState();
    s.observePosition("self", 100, 100, 0);
    expect(s.stateFor("self").movingUntil).toBe(-Infinity);
    s.observePosition("self", 100.5, 100, 16); // < 1 px (0.01 tile): jitter
    expect(s.stateFor("self").movingUntil).toBe(-Infinity);
    s.observePosition("self", 103, 100, 32);
    expect(s.stateFor("self").movingUntil).toBe(32 + MOVING_HOLD_MS);
  });

  it("holds moving for 150 ms after the last movement (5 Hz snapshots)", () => {
    expect(MOVING_HOLD_MS).toBe(150);
    const s = new EntityAnimState();
    s.observePosition("c:1", 0, 0, 0);
    s.observePosition("c:1", 10, 0, 100);
    s.observePosition("c:1", 10, 0, 200); // stood still this frame
    expect(s.stateFor("c:1").movingUntil).toBe(250);
  });

  it("treats a creature short of its target as moving", () => {
    const s = new EntityAnimState();
    s.observePosition("c:1", 0, 0, 0, 0, 0);
    expect(s.stateFor("c:1").movingUntil).toBe(-Infinity);
    s.observePosition("c:1", 0, 0, 16, 40, 0);
    expect(s.stateFor("c:1").movingUntil).toBe(16 + MOVING_HOLD_MS);
  });

  it("ignores non-finite positions instead of poisoning lastX/lastY", () => {
    const s = new EntityAnimState();
    s.observePosition("c:1", 0, 0, 0);
    s.observePosition("c:1", NaN, 0, 10);
    s.observePosition("c:1", 0, 0, 20);
    const r = s.stateFor("c:1");
    expect(r.lastX).toBe(0);
    expect(r.movingUntil).toBe(-Infinity);
  });

  it("mutates one record per entity (no per-frame allocation)", () => {
    const s = new EntityAnimState();
    s.observePosition("c:1", 0, 0, 0);
    const r = s.stateFor("c:1");
    for (let t = 1; t < 50; t += 1) s.observePosition("c:1", t * 5, 0, t * 16);
    s.noteAttack("c:1", 900, false);
    s.noteHit("c:1", 950);
    expect(s.stateFor("c:1")).toBe(r);
  });

  it("forget drops the record; size reports how many are tracked", () => {
    const s = new EntityAnimState();
    s.noteHit("c:1", 1);
    s.noteHit("c:2", 1);
    expect(s.size).toBe(2);
    s.forget("c:1");
    expect(s.stateFor("c:1")).toBe(null);
    expect(s.size).toBe(1);
    s.clear();
    expect(s.size).toBe(0);
  });

  it("gives each entity a stable phase in [0, 1000) so crowds are not in lockstep", () => {
    const s = new EntityAnimState();
    s.noteHit("c:1", 0);
    s.noteHit("c:2", 0);
    const a = s.stateFor("c:1").phase;
    expect(a).toBe(phaseFor("c:1"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1000);
    const phases = new Set(Array.from({ length: 20 }, (_, i) => phaseFor(`c:${i}`)));
    expect(phases.size).toBeGreaterThan(10);
  });
});
