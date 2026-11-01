// SOMET-678. The joined frame's quest giver list. A giver is a world point
// entity (kind 'quest_giver'): its art AND its in-game label are the bound
// entity's name -- the village's own binding, else the kind default -- so
// renaming the entity in admin renames the giver, with no table of names here.
// Position stays derived from the village box (fetchVillages); quests stay
// keyed by villageKey, so none of this touches the quest flow.
const { resolvePointArt } = require('./pointArt');

// Label for a giver with neither a binding nor a kind default (a database
// migrated but never catalog-seeded). The giver is still drawn and usable.
const FALLBACK_NAME = 'Quest Giver';

function buildQuestGivers(villages, pointArtDefaults) {
  return (villages || [])
    .filter((v) => v.questGiverX != null && v.questGiverY != null)
    .map((v) => {
      const art = resolvePointArt('quest_giver', v.questGiverArt, pointArtDefaults);
      return {
        villageId: v.id, villageKey: v.specKey || null, x: v.questGiverX, y: v.questGiverY,
        name: art || FALLBACK_NAME,
        art,
      };
    });
}

module.exports = { buildQuestGivers };
