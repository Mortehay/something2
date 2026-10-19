#!/usr/bin/env python3
"""Golden fixtures for the JavaScript port of the box's world-spec generator.

    python3 -I backend/tools/world_gen_ref/make_fixtures.py

Run on the HOST, never inside the backend container. Imports the vendored
`world_gen.py` next to this file by path (no sys.path games, no bytecode
written), runs it over a fixed case matrix and writes JSON into
backend/tests/fixtures/world_gen/. Deterministic: two runs give byte-identical
files, whatever PYTHONHASHSEED is.

What the files hold, and why each shape:

  plan_cases.json   `to_json(plan_region(**args))` stored VERBATIM as a JSON
                    string (the byte-parity target), plus `report(spec, target)`
                    as a JSON value.
  box_parity.json   the live box's POST /api/worlds response for
                    parity-somet644, and the proof (asserted here) that the
                    vendored module reproduces it byte for byte.
  report_only.json  hand-built and checked-in specs run through `report()` only.
  helpers.json      helper inputs and outputs. Wherever an output contains a
                    Python float, `result_json` holds `json.dumps(result)` so
                    float-vs-int survives (4.0 vs 4) - JSON.parse loses it.
  constants.json    the module's tables, for a port to diff against.

Every file records the sha256 of the reference it was generated from, so a
stale fixture is detectable.
"""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(BACKEND, "tests", "fixtures", "world_gen")
SEED_MAPS = os.path.join(BACKEND, "seeds", "maps")
INPUTS = os.path.join(HERE, "box_parity")

_spec = importlib.util.spec_from_file_location(
    "world_gen", os.path.join(HERE, "world_gen.py"))
wg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wg)


def _sha(name):
    with open(os.path.join(HERE, name), "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


REFERENCE = {n: _sha(n) for n in
             ("world_gen.py", "bestiary_p4.json", "smoke-world-gen.py")}


def _has_float(v):
    if isinstance(v, float):
        return True
    if isinstance(v, dict):
        return any(_has_float(x) for x in v.values())
    if isinstance(v, (list, tuple)):
        return any(_has_float(x) for x in v)
    return False


def _jsonable(v):
    """Tuples -> lists, sets -> sorted lists, recursively."""
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, (set, frozenset)):
        return sorted(_jsonable(x) for x in v)
    return v


def _call(fn, *args, **kwargs):
    """One helper call: its args, its result, and the float-pinning text."""
    result = _jsonable(fn(*args, **kwargs))
    row = {"args": _jsonable(list(args))}
    if kwargs:
        row["kwargs"] = _jsonable(kwargs)
    row["result"] = result
    if _has_float(result):
        row["result_json"] = json.dumps(result)
    return row


def _write(name, payload):
    doc = {
        "generated_by": "backend/tools/world_gen_ref/make_fixtures.py",
        "reference_sha256": REFERENCE,
        **payload,
    }
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    with open(os.path.join(OUT, name), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    return name


# --- plan_region cases -----------------------------------------------------
#
# (id, covers, kwargs, report_target). report_target "default" means the
# effective target_per_screen the plan used; None exercises the no-target path.

DEFAULT = "default"

PLAN_CASES = [
    ("solo-one-world", "world_count 1, other defaults (6.0, 128, 32, 32): no links, no roads/waypoints; caveat",
     {"name": "Solo", "world_count": 1}, DEFAULT),
    ("all-defaults", "only a name: world_count 6, target 6.0, size 128, chunk/cell 32",
     {"name": "Defaults"}, DEFAULT),
    ("pair-size32-chunk8", "world_count 2, size 32, chunk/cell 8, target 2 (sparse, EMPTY verdict)",
     {"name": "Pair", "world_count": 2, "target_per_screen": 2, "size": 32,
      "chunk_size": 8, "biome_cell": 8}, DEFAULT),
    ("six-default", "world_count 6 at defaults; smoke's 'Emerald Reach'",
     {"name": "Emerald Reach", "world_count": 6}, DEFAULT),
    ("twelve-horde-224", "world_count 12, size 224, target 14 (horde) -> one region-wide socket warning",
     {"name": "Twelve Peaks", "world_count": 12, "target_per_screen": 14,
      "size": 224}, DEFAULT),
    ("thirtysix-swarm-224", "world_count 36, size 224, target 25 (swarm), deep pool cycling",
     {"name": "Long March", "world_count": 36, "target_per_screen": 25,
      "size": 224}, DEFAULT),
    ("hollow-half", "target 0.5 -> sparse at size 32, EMPTY verdicts, caveat",
     {"name": "Hollow", "world_count": 3, "target_per_screen": 0.5, "size": 32},
     DEFAULT),
    ("chunk64-cell64", "chunk_size and biome_cell 64, target 6",
     {"name": "Wide Chunks", "world_count": 4, "target_per_screen": 6,
      "chunk_size": 64, "biome_cell": 64}, DEFAULT),
    ("chunk8-horde", "horde at chunk 8: socket cost falls with chunk_size squared, no warning",
     {"name": "Tiny Chunks", "world_count": 6, "target_per_screen": 14,
      "chunk_size": 8, "biome_cell": 8}, DEFAULT),
    ("cell64-dense-on-tier", "size 224, cell 64, target 8.1 is on a tier -> no caveat",
     {"name": "Mixed Cells", "world_count": 2, "target_per_screen": 8.1,
      "size": 224, "biome_cell": 64}, DEFAULT),
    ("nine-linkage", "world_count 9: full 3x3 spiral, symmetric links, gate_edge choice",
     {"name": "Linkage", "world_count": 9, "target_per_screen": 6.0}, DEFAULT),
    ("eight-bands", "world_count 8 at 8.1: surface/deep band ramp",
     {"name": "Bands", "world_count": 8, "target_per_screen": 8.1}, DEFAULT),
    ("twenty-horde", "world_count 20 at 14.0: socket warning emitted exactly once",
     {"name": "B", "world_count": 20, "target_per_screen": 14.0}, DEFAULT),
    ("plan-deep", "explicit biome_plan with deep biomes, a mixed-depth world, flora/variety repairs",
     {"name": "Deep Plan", "world_count": 5, "target_per_screen": 8.1,
      "biome_plan": [["Meadow"], ["Catacombs", "Deepvault"], ["Infernal Gate"],
                     ["The Maw", "Mire"], ["Abyssal Rift"]]}, DEFAULT),
    ("plan-invalid-names", "biome_plan with unknown names and an empty list -> names[i % 32] fallback",
     {"name": "Bad Names", "world_count": 4,
      "biome_plan": [["Nowhere"], ["Mire", "Fake"], [], ["Atlantis", "Narnia"]]},
     DEFAULT),
    ("plan-short-dupes", "biome_plan shorter than world_count (rest descends), a duplicated biome, entry_biomes ignored",
     {"name": "Short Plan", "world_count": 6, "biome_plan": [["Mire", "Mire"], ["Highlands"]],
      "entry_biomes": ["Arid Dunes"]}, DEFAULT),
    ("entry-arid", "entry_biomes Arid Dunes alone (2 flora) -> flora repair; smoke's 'Bare'",
     {"name": "Bare", "world_count": 1, "target_per_screen": 6.0,
      "entry_biomes": ["Arid Dunes"]}, DEFAULT),
    ("entry-invalid", "entry_biomes with only an unknown name -> Meadow",
     {"name": "Nope Entry", "world_count": 3, "entry_biomes": ["Nope"]}, DEFAULT),
    ("entry-deep-mixed", "entry_biomes The Maw + Mire: a mixed-depth entry takes a deep band",
     {"name": "Dark Start", "world_count": 4, "entry_biomes": ["The Maw", "Mire"]},
     DEFAULT),
    ("entry-empty", "entry_biomes empty -> Meadow",
     {"name": "Empty Entry", "world_count": 2, "entry_biomes": []}, DEFAULT),
    ("bestiary-false-thin", "bestiary False: thin deep biomes are NOT variety-repaired",
     {"name": "No Bestiary", "world_count": 4, "bestiary": False,
      "biome_plan": [["Infernal Gate"], ["Cavern"], ["The Maw"], ["Ossuary"]]},
     DEFAULT),
    ("bestiary-true-thin", "same plan as bestiary-false-thin with bestiary True, for contrast",
     {"name": "No Bestiary", "world_count": 4, "bestiary": True,
      "biome_plan": [["Infernal Gate"], ["Cavern"], ["The Maw"], ["Ossuary"]]},
     DEFAULT),
    ("bestiary-false-default", "bestiary False on the default descent",
     {"name": "Legacy", "world_count": 6, "bestiary": False}, DEFAULT),
    ("name-accents", "accented Latin name: isalnum/lower, ensure_ascii escapes, sha256 over UTF-8",
     {"name": "Café Noir Ümlaut", "world_count": 4}, DEFAULT),
    ("name-cjk", "CJK name: CJK letters are alnum in Python",
     {"name": "東京 地下", "world_count": 3}, DEFAULT),
    ("name-emoji", "astral-plane emoji: surrogate-pair escapes in to_json, not alnum",
     {"name": "🐉 Lair", "world_count": 2}, DEFAULT),
    ("name-symbols-only", "all-symbol name -> slug 'region'",
     {"name": "!!!", "world_count": 2}, DEFAULT),
    ("name-spaces", "leading/trailing/repeated spaces and dashes collapse in the slug",
     {"name": "  Spaced   Out--Name  ", "world_count": 3}, DEFAULT),
    ("name-case-traps", "İ lowers to two code points, Greek capitals, ß, superscript digit (isalnum)",
     {"name": "İstanbul ΣΟΦΟΣ Straße x²", "world_count": 2}, DEFAULT),
    ("size-odd-33", "odd size 33: floor division in mid/centre/village",
     {"name": "Odd", "world_count": 5, "size": 33}, DEFAULT),
    ("target-midpoint", "target exactly between sparse and normal (3.0375): tie-break by DENSITY_ORDER",
     {"name": "Midpoint", "world_count": 2, "target_per_screen": 3.0375}, DEFAULT),
    ("target-zero", "target 0 -> sparse; report target 0 is falsy so no caveat",
     {"name": "Zero", "world_count": 2, "target_per_screen": 0}, DEFAULT),
    ("swarm-clamp-256", "size 256 at swarm: 5833 > 5000 -> clamped problem",
     {"name": "Clamp", "world_count": 2, "target_per_screen": 25, "size": 256},
     DEFAULT),
    ("no-report-target", "report() called without a target: never a caveat",
     {"name": "Quiet", "world_count": 4, "target_per_screen": 6.0}, None),
]

_PLAN_DEFAULT_TARGET = 6.0


def plan_cases():
    out = []
    for cid, covers, kwargs, target in PLAN_CASES:
        spec = wg.plan_region(**kwargs)
        text = wg.to_json(spec)
        if target == DEFAULT:
            target = kwargs.get("target_per_screen", _PLAN_DEFAULT_TARGET)
        out.append({
            "id": cid,
            "covers": covers,
            "args": kwargs,
            "report_target": target,
            "to_json": text,
            "report": wg.report(spec, target),
        })
    ids = [c["id"] for c in out]
    assert len(ids) == len(set(ids)), "duplicate plan case id"
    return out


def plan_errors():
    rows = []
    for n in (0, -1):
        try:
            wg.plan_region("Nothing", world_count=n)
        except ValueError as e:
            rows.append({"args": {"name": "Nothing", "world_count": n},
                         "error": "ValueError", "message": str(e)})
        else:
            raise AssertionError(f"world_count {n} did not raise")
    return rows


# --- the live box ----------------------------------------------------------

def box_parity():
    """The box's own output, and proof the vendored module reproduces it.

    The box router maps the POST body onto plan_region like this (inferred from
    the signature and from the `params` echoed in the response; the router
    itself is not vendored): name -> name, worlds -> world_count,
    target_per_screen/size/chunk_size/biome_cell pass through, biome_plan ->
    biome_plan (None for author "rules"). theme, sfx_engine and author pick the
    biome author and audio, not plan_region arguments. entry_biomes and
    bestiary keep their defaults.
    """
    with open(os.path.join(INPUTS, "create-params.json"), encoding="utf-8") as fh:
        params = json.load(fh)
    with open(os.path.join(INPUTS, "create-response.json"), encoding="utf-8") as fh:
        response = json.load(fh)

    echoed = response["params"]
    for k, v in params.items():
        assert echoed.get(k) == v, f"box echoed {k}={echoed.get(k)!r}, POST had {v!r}"
    assert echoed["author"] == "rules" and echoed["biome_plan"] is None, echoed

    args = {
        "name": echoed["name"],
        "world_count": echoed["worlds"],
        "target_per_screen": echoed["target_per_screen"],
        "size": echoed["size"],
        "chunk_size": echoed["chunk_size"],
        "biome_cell": echoed["biome_cell"],
        "biome_plan": echoed["biome_plan"],
    }
    spec = wg.plan_region(**args)
    ours = wg.to_json(spec)
    theirs = wg.to_json(response["spec"])

    # Parsed objects first (a structural diff is readable), then the bytes.
    if json.loads(ours) != response["spec"]:
        raise SystemExit("BOX PARITY FAILED: parsed spec differs from the box's")
    if ours != theirs:
        raise SystemExit("BOX PARITY FAILED: to_json bytes differ from the box's")
    rep = wg.report(spec, args["target_per_screen"])
    if rep != response["report"]:
        raise SystemExit("BOX PARITY FAILED: report differs from the box's")

    return {
        "id": "box_parity-somet644",
        "covers": "live box POST /api/worlds (author rules) for parity-somet644; "
                  "the vendored module reproduces spec bytes and report exactly",
        "post_body": params,
        "box_params": echoed,
        "plan_region_args": args,
        "report_target": args["target_per_screen"],
        "box_spec": response["spec"],
        "box_report": response["report"],
        "to_json": ours,
        "report": rep,
    }


# --- report-only cases -----------------------------------------------------

def _w(key, biomes, density="normal", size=128, entry=False, types=None, **extra):
    w = {"key": key, "name": key, "biomes": biomes, "density": density,
         "width": size, "height": size, "is_entry": entry,
         "allowed_creature_types": wg.spawnable(biomes) if types is None else types}
    w.update(extra)
    return w


def _load_seed(name):
    with open(os.path.join(SEED_MAPS, name), encoding="utf-8") as fh:
        return json.load(fh)


def report_only():
    cases = []

    def add(cid, covers, spec, target=None):
        spec = copy.deepcopy(spec)
        assert not _has_float(spec), f"{cid}: float in a spec input loses its type in JSON"
        cases.append({"id": cid, "covers": covers, "spec": spec,
                      "target": target, "report": wg.report(copy.deepcopy(spec), target)})

    base = wg.plan_region("Links", world_count=3)

    s = copy.deepcopy(base)
    s["links"].append({"from": "links_hub", "edge": "N", "to_name": "Other Region Crossing"})
    s["links"].append({"from": "ghost", "edge": "S", "to_name": "Elsewhere"})
    add("link-to-name", "cross-region doorway: to_name and no to (valid), plus one from an unknown world",
        s, 6.0)

    s = copy.deepcopy(base)
    s["worlds"].append(_w("links_lonely", ["Mire"]))
    s["links"].append({"from": "links_lonely", "edge": "W", "to_name": "Far Away"})
    add("to-name-only-exit", "a world whose only exit is a to_name doorway counts as linked", s)

    s = copy.deepcopy(base)
    s["links"] = [dict({"kind": "edge"}, **l) for l in s["links"]]
    s["links"].append({"kind": "edge", "from": "links_hub", "edge": "N", "to": "nowhere"})
    s["links"].append({"kind": "portal", "from": "links_1", "from_x": 450, "from_y": 450,
                       "to": "missing", "to_x": 450, "to_y": 450})
    s["links"].append("not a dict")
    s["links"].append({"kind": "portal", "from": "links_2", "from_x": 450, "from_y": 450,
                       "to": "links_hub", "to_x": 6450, "to_y": 6450})
    add("link-kind-edge", "kind:'edge' links, a dangling edge link, a portal (no edge -> '?'), a non-dict link",
        s, 6.0)

    g = {"name": "Graphy", "topology": "graph", "worlds": [
        _w("g_a", ["Meadow"], entry=True), _w("g_b", ["Deep Forest", "Mire"]),
        _w("g_c", ["Catacombs", "Cavern", "Gloomfen"], density="dense")],
        "links": [{"from": "g_a", "edge": "E", "to": "g_b"},
                  {"from": "g_b", "edge": "W", "to": "g_a"},
                  {"kind": "portal", "from": "g_b", "from_x": 650, "from_y": 650,
                   "to": "g_c", "to_x": 650, "to_y": 650}]}
    add("graph-no-grid", "topology graph, worlds without grid; g_c reached only as a portal target", g, 6.0)

    for name in ("vale-region.map.json", "p5-descent.map.json"):
        spec = _load_seed(name)
        add(f"seed-{name.split('.')[0]}", f"checked-in backend/seeds/maps/{name} (copied in), target 6.0",
            spec, 6.0)

    # The smoke suite's hand-built worlds.
    for name in sorted(wg.FLORA_OPTIONAL):
        add(f"desolate-{wg._slug(name)}", f"{name}: no flora by design, exempt from the floor",
            {"worlds": [_w("w", [name], entry=True, chunk_size=32)], "links": []})
    add("thin-flora", "Arid Dunes alone, hand-authored: 'read bare' reported",
        {"worlds": [_w("w", ["Arid Dunes"], density="dense", entry=True)], "links": []})
    add("mismatch-empty", "swarm Meadow with unspawnable names -> EMPTY row, ZERO creatures problem",
        {"worlds": [_w("w", ["Meadow"], density="swarm", entry=True,
                       types=["Woodland Line", "Desert Swarm"])], "links": []})
    add("mismatch-no-biomes", "no biomes and no types: 'none'/'nothing' wording, biome_multiplier 1.0",
        {"worlds": [_w("w", [], entry=True, types=[])], "links": []})
    add("clamp-512", "swarm 512x512 Mire: clamped to 5000, per_screen from the clamped count",
        {"worlds": [_w("w", ["Mire"], density="swarm", size=512, entry=True,
                       types=["Slime"])], "links": []})
    add("bandwidth-224", "swarm 224 Infernal Gate at chunk 32: socket warning",
        {"worlds": [_w("w", ["Infernal Gate"], density="swarm", size=224, entry=True,
                       chunk_size=32)], "links": []})
    add("variety-thin", "two creature types -> 'read repetitive' problem",
        {"worlds": [_w("w", ["Meadow"], density="dense", entry=True,
                       types=["Slime", "Wolf"])], "links": []})
    add("leaders-over-cap", "two leader roles in allowed types -> leader problem",
        {"worlds": [_w("w", ["Meadow"], entry=True,
                       types=["Slime", "Beast Champion", "Woodland Apex"])], "links": []})
    add("unknown-tier", "density 'bogus' -> 0 rate -> EMPTY verdict",
        {"worlds": [_w("w", ["Meadow"], density="bogus", entry=True)], "links": []})
    add("missing-density-and-size", "no density (defaults normal) and no width/height: area 0 fallback rate",
        {"worlds": [{"key": "w", "name": "w", "biomes": ["Meadow"], "is_entry": True,
                     "allowed_creature_types": ["Slime"]}], "links": []}, 6.0)
    add("entries-zero-and-unreachable", "no entry world, two unlinked worlds",
        {"worlds": [_w("a", ["Meadow"]), _w("b", ["Mire"])], "links": []})
    add("entries-two", "two entry worlds",
        {"worlds": [_w("a", ["Meadow"], entry=True), _w("b", ["Mire"], entry=True)],
         "links": [{"from": "a", "edge": "E", "to": "b"}, {"from": "b", "edge": "W", "to": "a"}]})
    add("empty-region", "no worlds at all: per falls back to [0]", {"worlds": [], "links": []}, 6.0)
    add("empty-region-no-keys", "spec with neither worlds nor links", {}, None)

    # Socket subset: 7 hot worlds of 8, varying chunk sizes -> "N of M worlds
    # (first six, ...)" and a KiB/s range.
    hot = [_w(f"h{i}", ["Mire"], density="swarm", size=224, entry=(i == 0),
              chunk_size=24 + 4 * i) for i in range(7)]
    hot.append(_w("cool", ["Mire"], density="normal", size=224, chunk_size=32))
    links = [{"from": hot[i]["key"], "edge": "E", "to": hot[i + 1]["key"]} for i in range(7)]
    add("socket-subset", "7 of 8 worlds over the socket threshold at different chunk sizes: subset wording, KiB range, '...'",
        {"worlds": hot, "links": links}, 14.0)
    mixed = [_w("m0", ["Mire"], density="horde", size=128, entry=True, chunk_size=32),
             _w("m1", ["Mire"], density="swarm", size=128, chunk_size=32)]
    add("socket-mixed-density", "two hot worlds at different densities: per_screen range wording",
        {"worlds": mixed, "links": [{"from": "m0", "edge": "E", "to": "m1"},
                                    {"from": "m1", "edge": "W", "to": "m0"}]}, 17.0)

    # Tiles-vs-pixels, through report(), like smoke's _units.
    broken = wg.plan_region("Units", world_count=4, target_per_screen=6.0)
    entry = broken["worlds"][0]
    mid = entry["width"] // 2
    entry["waypoints"] = [{"x": mid, "y": mid, "name": "wrong units"}]
    entry["entry_spawn"] = {"x": mid, "y": mid}
    add("units-tile-coords", "tile indices where pixels belong: 4 PIXELS problems", broken, 6.0)
    entry["roads"] = [[[mid, mid], [wg.to_px(mid), wg.to_px(mid)]]]
    add("units-pixel-roads", "a road written in pixels: 'roads are TILES' problems", broken, 6.0)

    # Caveats: a 6.0 target over a generated region (box session: caveats are
    # NOT problems, ok stays true).
    gap = wg.plan_region("Gap", world_count=4, target_per_screen=6.0)
    add("caveat-gap-6", "target 6.0 -> caveat present while ok is true", gap, 6.0)
    add("caveat-gap-int-6", "same region, target given as int 6", gap, 6)
    add("caveat-tiny-target", "target 0.05: tolerance floor max(target, 0.1)", gap, 0.05)

    ids = [c["id"] for c in cases]
    assert len(ids) == len(set(ids)), "duplicate report case id"
    return cases


# --- helpers ---------------------------------------------------------------

def check_units_cases():
    worlds = [
        ("tile-index-positions", {"key": "t", "width": 128,
                                  "entry_spawn": {"x": 64, "y": 64},
                                  "village": {"spawn_x": 64, "spawn_y": 6450},
                                  "chest": {"x": 6400, "y": 6450},
                                  "waypoints": [{"x": 64, "y": 6450, "name": "x"}]}),
        ("outside-extent", {"key": "o", "width": 64,
                            "entry_spawn": {"x": 6450, "y": 50},
                            "waypoints": [{"x": 50, "y": 50}, {"x": 99950, "y": 50}]}),
        ("negative-is-a-centre-in-python", {"key": "n", "width": 64,
                                            "entry_spawn": {"x": -50, "y": -150},
                                            "chest": {"x": -51, "y": 50}}),
        ("bool-and-string-and-null", {"key": "b", "width": 64,
                                      "entry_spawn": {"x": True, "y": False},
                                      "chest": {"x": "6450", "y": None}}),
        ("no-width-no-extent-check", {"key": "nw",
                                      "entry_spawn": {"x": 99950, "y": 64}}),
        ("width-zero-or-null", {"key": "wz", "width": None,
                                "roads": [[[0, 0], [999, 5]]],
                                "chest": {"x": 150, "y": 7}}),
        ("roads-in-pixels", {"key": "r", "width": 64,
                             "roads": [[[32, 32], [3250, 3250]], [[32, 32], [-1, 63]],
                                       [[32, 32], [64, 0]]]}),
        ("non-dict-entries", {"key": "nd", "width": 64,
                              "entry_spawn": [1, 2], "village": "x",
                              "waypoints": [5, None, {"x": 3250, "y": 7}]}),
        ("missing-key", {"width": 32, "entry_spawn": {"x": 7, "y": 1650}}),
        ("clean", {"key": "ok", "width": 128,
                   "entry_spawn": {"x": 6450, "y": 6450},
                   "village": {"spawn_x": 6450, "spawn_y": 6450},
                   "waypoints": [{"x": 6450, "y": 6450}],
                   "roads": [[[64, 64], [1, 64]]]}),
    ]
    rows = []
    for cid, world in worlds:
        rows.append({"id": cid, "world": world, "result": wg.check_units(copy.deepcopy(world))})
    return rows


TIERS = list(wg.DENSITY_ORDER) + ["bogus"]
DIMS = [(0, 0), (0, 128), (1, 1), (10, 25), (50, 15), (125, 1), (250, 3),
        (32, 32), (33, 33), (64, 64), (100, 100), (128, 128), (200, 75),
        (224, 224), (256, 256), (300, 300), (512, 512)]

SINGLE_BIOMES = [[b] for b in wg.BIOMES]
BIOME_SETS = SINGLE_BIOMES + [
    [], ["Nowhere"], ["Meadow", "Nowhere"], ["Meadow", "Meadow"],
    ["Meadow", "Deep Forest"], ["Arid Dunes", "Frozen Waste"],
    ["Catacombs", "Deepvault"], ["Catacombs", "Cavern"], ["Infernal Gate", "Mire"],
    ["Meadow", "Deep Forest", "Arid Dunes", "Frozen Waste", "Mire"],
    ["Highlands", "Storm Coast"], ["Abyssal Rift", "The Maw"],
    ["Storm Coast", "Ashfields"], ["Verdant Jungle", "Blightworks"],
]
BANDS = [None, [], [1, 2], [1, 5], [3, 5], [4, 8], [8, 12], [10, 14], [12, 12], [13, 20],
         [2, 3, 99]]


def helpers():
    out = {}
    out["per_screen"] = [_call(wg.per_screen, t, None, w, h) for t in TIERS for w, h in DIMS]
    out["per_screen"] += [_call(wg.per_screen, "normal", ["Meadow"], 128, 128),
                          _call(wg.per_screen, "normal", ["Abyssal Rift"], 128, 128),
                          _call(wg.per_screen, "dense", None, -4, 4)]
    out["resolve_density"] = [_call(wg.resolve_density, t, w, h) for t in TIERS for w, h in DIMS]

    targets = sorted({x / 10.0 for x in range(0, 301)}
                     | {-1.0, 0, 2, 3.0375, 6, 6.075, 11.025, 17.025, 1000.0})
    out["choose_density"] = [_call(wg.choose_density, t) for t in targets]
    out["choose_density"] += [_call(wg.choose_density, 6.0, ["Meadow"]),
                              _call(wg.choose_density, 6.0, ["Mire"])]

    pairs = [("Solo", "solo_hub"), ("Emerald Reach", "emerald_reach_1"),
             ("parity-somet644", "parity_somet644_2"), ("Café", "caf_hub"),
             ("東京", "東京_1"), ("🐉 Lair", "lair_hub"), ("", ""), ("a/b", "c"),
             ("x" * 200, "y")]
    pairs += [(f"R{i}", f"r{i}_{j}") for i in range(10) for j in range(3)]
    out["_seed_for"] = [_call(wg._seed_for, r, k) for r, k in pairs]

    out["_spiral"] = [_call(wg._spiral, n) for n in list(range(0, 41)) + [49, 50, 64, 100]]

    out["flora_types"] = [_call(wg.flora_types, b) for b in BIOME_SETS]
    out["enrich_flora"] = [_call(wg.enrich_flora, b) for b in BIOME_SETS]
    out["creature_types"] = [_call(wg.creature_types, b) for b in BIOME_SETS]
    out["spawnable"] = [_call(wg.spawnable, b) for b in BIOME_SETS]
    out["enrich_variety"] = [_call(wg.enrich_variety, b, band)
                             for b in BIOME_SETS for band in (None, [1, 5])]
    out["families_for"] = [_call(wg.families_for, b) for b in BIOME_SETS]
    out["bestiary_types"] = [_call(wg.bestiary_types, b, band)
                             for b in BIOME_SETS if wg.families_for(b) or not b
                             for band in BANDS]
    out["bestiary_types"] += [_call(wg.bestiary_types, ["Meadow", "Deep Forest", "Mire"],
                                    [1, 12], limit=lim) for lim in (0, 1, 3, 5, 12, 40)]

    type_lists = [[], ["Slime"], ["Beast Champion"], ["Beast Champion", "Woodland Apex"],
                  ["Champion"], ["Apex Predator"], ["Beast  Apex"], ["Beast Champion "],
                  ["Slime", "Wolf", "Beast Swarm", "Beast Skirmisher", "Beast Line"],
                  ["Void Apex", "Void Champion", "Void Heavy", "Void Line"]]
    out["leader_count"] = [_call(wg.leader_count, t) for t in type_lists]

    out["check_units"] = check_units_cases()

    out["biome_multiplier"] = [_call(wg.biome_multiplier, b) for b in BIOME_SETS]
    out["_depth_of"] = [_call(wg._depth_of, b) for b in BIOME_SETS]
    out["socket_kib_s"] = [_call(wg.socket_kib_s, ps, cs)
                           for ps in (0.0, 2.025, 4.05, 4.1, 8.1, 13.95, 14.0, 20.0, 20.025, 22.5)
                           for cs in (8, 16, 24, 32, 64)]
    out["to_px"] = [_call(wg.to_px, t) for t in (-1, 0, 1, 16, 32, 64, 112, 255)]
    out["is_tile_centre"] = [_call(wg.is_tile_centre, v)
                             for v in (50, 150, 6450, 64, 6400, 0, -50, -150, -51, True, False,
                                       "6450", None)]
    names = ["Solo", "Emerald Reach", "parity-somet644", "Café Noir Ümlaut", "東京 地下",
             "🐉 Lair", "!!!", "", "  Spaced   Out--Name  ", "İstanbul ΣΟΦΟΣ Straße x²",
             "a__b", "_a_", "ǅungla", "Ⅻ roman", "١٢٣ arabic digits", "ﬁ ligature",
             "ÀÉÎÕÜ", "x́y combining", "tab\there", " nbsp"]
    out["_slug"] = [_call(wg._slug, n) for n in names]
    out["_title"] = [_call(wg._title, n, i) for n in ("Solo", "Café") for i in (0, 1, 12)]
    out["plan_region_errors"] = plan_errors()
    return out


def constants():
    return {
        "DENSITY_TIERS": wg.DENSITY_TIERS,
        "DENSITY_TIERS_json": json.dumps(wg.DENSITY_TIERS),
        "DENSITY_ORDER": wg.DENSITY_ORDER,
        "TILES_PER_SCREEN": wg.TILES_PER_SCREEN,
        "MAX_WORLD_CREATURES": wg.MAX_WORLD_CREATURES,
        "BYTES_PER_CREATURE_PER_SEC": wg.BYTES_PER_CREATURE_PER_SEC,
        "NEIGHBOURHOOD_CHUNKS": wg.NEIGHBOURHOOD_CHUNKS,
        "SOCKET_WARN_KIB_S": wg.SOCKET_WARN_KIB_S,
        "THIN_VARIETY_BELOW": wg.THIN_VARIETY_BELOW,
        "THIN_FLORA_BELOW": wg.THIN_FLORA_BELOW,
        "EMPTY_BELOW_PER_SCREEN": wg.EMPTY_BELOW_PER_SCREEN,
        "CROWDED_ABOVE_PER_SCREEN": wg.CROWDED_ABOVE_PER_SCREEN,
        "SURFACE_BAND": wg.SURFACE_BAND,
        "MAX_LEADER_ROLES_PER_WORLD": wg.MAX_LEADER_ROLES_PER_WORLD,
        "LEADER_ROLES": sorted(wg.LEADER_ROLES),
        "TILE_PX": wg.TILE_PX,
        "SAFE_ROAD_RADIUS": wg.SAFE_ROAD_RADIUS,
        "EDGES": wg.EDGES,
        "BIOMES": wg.BIOMES,
        "BIOMES_json": json.dumps(wg.BIOMES),
        "BIOME_FAMILIES": wg.BIOME_FAMILIES,
        "SURFACE": wg.SURFACE,
        "DEEP": wg.DEEP,
        "FLORA_OPTIONAL": sorted(wg.FLORA_OPTIONAL),
        "ROLES": wg.ROLES,
    }


def main():
    os.makedirs(OUT, exist_ok=True)
    written = [
        _write("plan_cases.json", {"cases": plan_cases()}),
        _write("box_parity.json", {"case": box_parity()}),
        _write("report_only.json", {"cases": report_only()}),
        _write("helpers.json", {"helpers": helpers()}),
        _write("constants.json", {"constants": constants()}),
    ]
    for name in written:
        print(f"wrote {os.path.relpath(os.path.join(OUT, name), BACKEND)}")
    print("box parity: parsed spec, to_json re-serialisation and report all "
          "match the live box")
    # The fixtures are pinned by sha256 in SOURCE.md, so a regeneration that
    # changes any of them fails the integrity test until these rows are pasted
    # in - an explicit, reviewed diff rather than a silent new golden.
    print("\nfixture sha256 rows for SOURCE.md (Golden fixtures table):")
    for name in sorted(written):
        rel = os.path.relpath(os.path.join(OUT, name), BACKEND)
        with open(os.path.join(OUT, name), "rb") as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()
        print(f"| `{rel}` | generated | `{digest}` |")


if __name__ == "__main__":
    main()
