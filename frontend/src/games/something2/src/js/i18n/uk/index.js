// One merged dictionary. Each area file exports a plain { "English": "Українською" }
// object (a plural entry is an array [one, few, many]); keeping them separate lets
// different people translate different areas without touching the same file.
import game from "./game.js";
import render from "./render.js";
import panels from "./panels.js";
import panels2 from "./panels2.js";
import quests from "./quests.js";
import react from "./react.js";
import data from "./data.js";
import content from "./content.js";
import extra1 from "./extra1.js";
import extra2 from "./extra2.js";
import extra3 from "./extra3.js";
import extra4 from "./extra4.js";

export const UK = Object.assign({}, data, content, extra1, extra2, extra3, extra4, quests, panels, panels2, render, game, react);
export const UK_AREAS = { extra1, extra2, extra3, extra4, game, render, panels, panels2, quests, react, data, content };
