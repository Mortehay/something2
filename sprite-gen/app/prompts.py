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
