import { describe, it, expect } from "vitest";
import { EntityAnimState, MOVING_HOLD_MS, phaseFor, noteFrameEvents, actorKey } from "../entityAnimState.js";

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

describe("EntityAnimState.noteHit does not restart a flinch already showing", () => {
  it("keeps the first hit's clock for half the damage window, then restarts", () => {
    const s = new EntityAnimState();
    s.noteHit("c:1", 1000);   // impact on the world-state frame
    s.noteHit("c:1", 1100);   // the same hit's hp drop on the creatures frame
    expect(s.stateFor("c:1").hitAt).toBe(1000);
    s.noteHit("c:1", 1150);   // a genuinely new hit
    expect(s.stateFor("c:1").hitAt).toBe(1150);
  });
});

describe("noteFrameEvents", () => {
  const TAU = Math.PI * 2;
  const frame = (over) => ({ attacks: [], impacts: [], sfx: [], ...over });

  it("notes creature and remote-player attacks; a full-circle arc is a cast", () => {
    const s = new EntityAnimState();
    noteFrameEvents(s, frame({ attacks: [
      { a: "c:5", arc: 1.2, x: 0, y: 0 },
      { a: "p:7", arc: TAU, x: 0, y: 0 },
    ] }), 500, "1");
    expect(s.stateFor("c:5").attackAt).toBe(500);
    expect(s.stateFor("c:5").castAt).toBe(-Infinity);
    expect(s.stateFor("p:7").castAt).toBe(500);
    expect(s.stateFor("p:7").attackAt).toBe(-Infinity);
  });

  it("maps the local player's own id to 'self', and skips its plain swings (noted at send)", () => {
    const s = new EntityAnimState();
    noteFrameEvents(s, frame({ attacks: [{ a: "p:1", arc: 1.2 }] }), 500, "1");
    expect(s.stateFor("self")).toBe(null);
    expect(s.stateFor("p:1")).toBe(null);
    noteFrameEvents(s, frame({ attacks: [{ a: "p:1", arc: TAU }] }), 600, "1");
    expect(s.stateFor("self").castAt).toBe(600);
  });

  it("ignores refused attacks and junk actors", () => {
    const s = new EntityAnimState();
    noteFrameEvents(s, frame({ attacks: [
      { a: "c:5", arc: 1.2, b: true }, { a: null }, { a: "x:1" }, null, { a: 5 },
    ] }), 500, "1");
    expect(s.size).toBe(0);
  });

  it("notes hits on impact targets", () => {
    const s = new EntityAnimState();
    noteFrameEvents(s, frame({ impacts: [{ t: "c:5" }, { t: "p:1" }, { t: "p:9" }, { t: "" }] }), 700, "1");
    expect(s.stateFor("c:5").hitAt).toBe(700);
    expect(s.stateFor("self").hitAt).toBe(700);
    expect(s.stateFor("p:9").hitAt).toBe(700);
    expect(s.size).toBe(3);
  });

  it("a creature's skill_cast sfx is a cast; other sfx are not", () => {
    const s = new EntityAnimState();
    noteFrameEvents(s, frame({ sfx: [
      { e: "skill_cast", a: "c:5" }, { e: "use", a: "c:6" }, { e: "skill_hit", a: "c:7" },
    ] }), 800, "1");
    expect(s.stateFor("c:5").castAt).toBe(800);
    expect(s.stateFor("c:6")).toBe(null);
    expect(s.stateFor("c:7")).toBe(null);
  });

  it("tolerates a frame with none of the lists", () => {
    const s = new EntityAnimState();
    expect(() => noteFrameEvents(s, {}, 0, "1")).not.toThrow();
    expect(() => noteFrameEvents(null, { attacks: [{ a: "c:1" }] }, 0, "1")).not.toThrow();
  });
});

describe("actorKey", () => {
  it("maps wire actors to anim keys", () => {
    expect(actorKey("c:5", "1")).toBe("c:5");
    expect(actorKey("p:7", "1")).toBe("p:7");
    expect(actorKey("p:1", "1")).toBe("self");
    expect(actorKey("p:1", null)).toBe("p:1");
    expect(actorKey("c:", "1")).toBe(null);
    expect(actorKey("q:1", "1")).toBe(null);
    expect(actorKey(undefined, "1")).toBe(null);
  });
});
