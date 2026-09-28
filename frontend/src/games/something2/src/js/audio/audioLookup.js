// Pure resolution of "what should play" (spec §1 "Lookup chains"). A chain is
// a list of binding keys, most specific first; the first non-empty one wins.
export function resolveChain(bindings, keys) {
  for (const key of keys) {
    const clips = bindings && bindings[key];
    if (Array.isArray(clips) && clips.length > 0) return { clips, key };
  }
  return { clips: [], key: null, missKey: keys[0] };
}

export function pickWeighted(clips, rand = Math.random) {
  if (!Array.isArray(clips) || clips.length === 0) return null;
  const total = clips.reduce((s, c) => s + (c.weight > 0 ? c.weight : 1), 0);
  let x = rand() * total;
  for (const c of clips) {
    x -= c.weight > 0 ? c.weight : 1;
    if (x < 0) return c;
  }
  return clips[clips.length - 1];
}

export const ambienceChain = (world, biome) =>
  (biome ? [`biome/${biome}/ambience`] : []).concat(`world/${world}/ambience`);
export const musicChain = (world) => [`world/${world}/music`];
