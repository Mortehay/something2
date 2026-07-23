from typing import Callable, Optional
from .backends import get_backend
from .config import DIRECTIONS
from .poses import pose_for
from .prompts import build_prompt, build_tile_prompt, build_object_prompt
from .postproc import key_near_white, remove_background, crop_to_content, pack_atlas

def generate_creature(creature: str, base_prompt: str, backend_name: str,
                      seed: int, n_frames: int, size=(128, 160), steps: int = 20,
                      progress: Optional[Callable[[int, int], None]] = None) -> dict:
    backend = get_backend(backend_name)
    # The stub backend paints a flat synthetic placeholder — neural matting
    # buys nothing there and costs seconds per frame.
    matting = "cutout" if backend_name == "stub" else "auto"
    total = len(DIRECTIONS) * n_frames
    done = 0
    raw = {}
    for di, direction in enumerate(DIRECTIONS):
        for frame in range(n_frames):
            pose = pose_for(direction, frame, size)
            prompt = build_prompt(base_prompt, direction, frame)
            # Per-frame seed derived from the creature seed so frames are stable
            # but distinct; direction/frame fold in deterministically.
            frame_seed = seed * 1000 + di * 10 + frame
            img = backend.generate(prompt=prompt, pose=pose, seed=frame_seed,
                                   steps=steps, size=size)
            # Entities are drawn over the world, so the backdrop must go.
            img = crop_to_content(remove_background(img, matting))
            raw[f"{direction}/{frame}"] = img
            done += 1
            if progress:
                progress(done, total)
    atlas, manifest = pack_atlas(raw)
    return {"frames": raw, "atlas": atlas, "manifest": manifest}

def _generate_flat(prompt_builder, base_prompt: str, backend_name: str,
                   seed: int, n_frames: int, size, steps: int,
                   progress: Optional[Callable[[int, int], None]] = None,
                   transparent: bool = False) -> dict:
    # One image, optionally an N-frame same-place loop. No directions, so frame
    # keys are bare indices ("0", "1", ...) — shared by tiles and world objects.
    backend = get_backend(backend_name)
    matting = "cutout" if backend_name == "stub" else "auto"
    total = max(1, n_frames)
    raw = {}
    for frame in range(total):
        prompt = prompt_builder(base_prompt)
        # Per-frame seed keeps frames stable but distinct (a placeholder for
        # real animation; loop coherence is a real-SD/GPU-era concern).
        frame_seed = seed * 1000 + frame
        img = backend.generate(prompt=prompt, pose=None, seed=frame_seed,
                               steps=steps, size=size)
        # Objects sit on top of the ground, so their backdrop is cut away.
        # Tiles ARE the ground: they keep the pre-existing near-white keying
        # only, with no border flood-fill that would eat into a snow texture.
        img = remove_background(img, matting) if transparent else key_near_white(img)
        img = crop_to_content(img)
        raw[str(frame)] = img
        if progress:
            progress(frame + 1, total)
    atlas, manifest = pack_atlas(raw)
    return {"static": raw["0"], "frames": raw, "atlas": atlas, "manifest": manifest}

def generate_tile(tile: str, base_prompt: str, backend_name: str,
                  seed: int, n_frames: int = 1, size=(128, 128), steps: int = 20,
                  progress: Optional[Callable[[int, int], None]] = None) -> dict:
    return _generate_flat(build_tile_prompt, base_prompt, backend_name,
                          seed, n_frames, size, steps, progress)

def generate_object(obj: str, base_prompt: str, backend_name: str,
                    seed: int, n_frames: int = 1, size=(128, 160), steps: int = 20,
                    progress: Optional[Callable[[int, int], None]] = None) -> dict:
    # A world object (tree, rock, prop): same flat pipeline as a tile, but with
    # object framing instead of seamless-tile framing. Entities that don't need
    # a directional walk set use this instead of generate_creature — it is one
    # image per frame rather than one per direction per frame.
    return _generate_flat(build_object_prompt, base_prompt, backend_name,
                          seed, n_frames, size, steps, progress, transparent=True)
