from typing import Callable, Optional
from .backends import get_backend
from .config import DIRECTIONS
from .poses import pose_for
from .prompts import build_prompt
from .postproc import to_transparent, crop_to_content, pack_atlas

def generate_creature(creature: str, base_prompt: str, backend_name: str,
                      seed: int, n_frames: int, size=(128, 160), steps: int = 20,
                      progress: Optional[Callable[[int, int], None]] = None) -> dict:
    backend = get_backend(backend_name)
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
            img = crop_to_content(to_transparent(img))
            raw[f"{direction}/{frame}"] = img
            done += 1
            if progress:
                progress(done, total)
    atlas, manifest = pack_atlas(raw)
    return {"frames": raw, "atlas": atlas, "manifest": manifest}
