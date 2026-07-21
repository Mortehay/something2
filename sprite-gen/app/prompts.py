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
