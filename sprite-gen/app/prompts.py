_DIR_WORDS = {
    "N": "facing north (away)", "NE": "facing north-east",
    "E": "facing east (right)", "SE": "facing south-east",
    "S": "facing south (toward camera)", "SW": "facing south-west",
    "W": "facing west (left)", "NW": "facing north-west",
}

def build_prompt(base: str, direction: str, frame: int) -> str:
    dirword = _DIR_WORDS.get(direction, "facing south")
    return (
        f"{base}, {dirword}, isometric video game sprite, 3/4 top-down view, "
        f"walk cycle frame {frame}, full body, centered, plain background, "
        f"crisp pixel-art style, high detail"
    )

def build_tile_prompt(base: str) -> str:
    # Tile styling only — deliberately NO facing/walk words. A tile is one
    # seamless top-down texture, not a directional character sprite.
    return (
        f"{base}, seamless top-down isometric ground tile, tileable texture, "
        f"flat even lighting, no shadows, centered, crisp pixel-art style, high detail"
    )

def build_object_prompt(base: str) -> str:
    # World objects (trees, rocks, props): one image, no facing and no tiling.
    # Unlike a tile this must NOT be seamless — it is a single silhouette that
    # gets cut out of its background, so ask for an isolated subject.
    # "solid white background" is not styling — cutout_background() keys the
    # backdrop out by colour, and it only works reliably when the backdrop is
    # one flat tone with nothing touching the frame edge.
    return (
        f"{base}, single isometric video game object, 3/4 top-down view, "
        f"whole object centered with a margin, isolated on a solid white background, "
        f"no ground, no shadow, crisp pixel-art style, high detail"
    )
