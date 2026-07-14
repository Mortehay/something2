---
name: sprite-pipeline
description: Use when defining or consuming creature sprites — the directional/animated frame spec, naming, storage layout, and frame-consistency approach.
---

# Sprite pipeline (something2)

Creatures (heroes, monsters) are **isometric, directional, and animated**.

- **Per creature:** 8 iso facings (N, NE, E, SE, S, SW, W, NW) × N walk frames. Static-idle is facing S, frame 0.
- **Format:** PNG, transparent background, cropped to the iso footprint, feet-anchored (see [[iso-rendering]] for the anchor). Sprites are taller than the `128×64` tile.
- **Storage (MinIO):** `sprites/<creature>/<dir>/<frame>.png` plus a packed atlas `sprites/<creature>/atlas.png` + `atlas.json` (frame rects). The client loads the atlas, not individual files.
- **Consistency (the hard part):** all frames of one creature share a **fixed RNG seed**; per-frame pose is driven by a ControlNet pose skeleton so the frames read as the same character walking, not 8 unrelated images. See [[local-ai-dev]].
- **Placeholder art:** until the generator (sub-project D) exists, the renderer uses programmer-art directional blocks (a colored diamond with a facing wedge). Keep the placeholder path working as a fallback when an atlas is missing.

Related: [[iso-rendering]], [[local-ai-dev]], [[js-game-dev]].
