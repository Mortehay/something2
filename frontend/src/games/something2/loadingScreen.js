// SOMET-742. The rules around the loading screen, apart from the component.

// A map change whose images are all cached would otherwise flash the screen.
export const MIN_SCREEN_MS = 400;
// Between page start and the first join, the catalogues are loading. If one of
// them fails, nothing will ever join, so the screen must not wait for that.
export const BOOT_LIMIT_MS = 20000;

// One file per name in public/loading-scenes/. The server picks by the world's
// biome (backend/src/services/loadingScene.js).
export const LOADING_SCENES = ['forest', 'meadow', 'jungle', 'swamp', 'desert', 'snow', 'volcanic', 'coast', 'cavern', 'ruins'];
const DEFAULT_SCENE = 'forest';
// Also read by the inline script in index.html, which runs before any module.
export const LAST_SCENE_KEY = 'something2.loadingScene';

export function sceneUrl(scene) {
  return `/loading-scenes/${LOADING_SCENES.includes(scene) ? scene : DEFAULT_SCENE}.svg`;
}

export function rememberScene(scene) {
  try { if (LOADING_SCENES.includes(scene)) localStorage.setItem(LAST_SCENE_KEY, scene); } catch { /* cosmetic */ }
}

export function recallScene() {
  try { return localStorage.getItem(LAST_SCENE_KEY); } catch { return null; }
}

// Which scene to show before enterWorld names the destination. `lastWorldId` is
// null for a character that has never played, and undefined while the character
// is not known yet.
export function bootScene({ worlds, lastWorldId, recalled }) {
  const destination = lastWorldId === null
    ? worlds?.find((w) => w.is_entry)
    : worlds?.find((w) => w.id === lastWorldId);
  return destination?.loading_scene || recalled;
}

export function remainingHoldMs(startedAt, now) {
  return Math.max(0, MIN_SCREEN_MS - (now - startedAt));
}

// The recovery panel means "the join failed". While an entry is under way that
// is not true, and the panel used to sit on top of the loading screen saying so.
export function recoveryPanelVisible({ isPlaying, isAdmin, hasCharacter, isEntering }) {
  return Boolean(!isPlaying && !isAdmin && hasCharacter && !isEntering);
}

export function bootLoadingVisible({ isGameRoute, isPlaying, joinPhase, hasCharacter, isAdmin, joinAttempted, expired }) {
  return Boolean(isGameRoute && !isPlaying && !joinPhase && hasCharacter && !isAdmin && !joinAttempted && !expired);
}
