// frontend/src/games/something2/src/js/net/achievementsClient.js
//
// Client HTTP helpers for the Achievements journal and earned titles.
// Bearer-authenticated; the server only honours a character id that belongs
// to the signed-in account.

import { authHeaders } from "./auth.js";
import { t } from "../i18n/i18n.js";

// The server answers { ok: false, error } with a readable reason; surface it.
async function failure(res, what) {
  let reason = "";
  try { reason = (await res.json()).error || ""; } catch { /* non-JSON body */ }
  return new Error(reason || t("Failed to {what}: {status}", { what: t(what), status: res.status }));
}

export async function fetchAchievements(characterId) {
  if (!characterId) return { achievements: [], titles: [], activeTitle: null, counters: {} };
  const res = await fetch(`/api/achievements/character/${characterId}`, { headers: authHeaders() });
  if (!res.ok) throw await failure(res, 'fetch achievements');
  return await res.json();
}

// title null clears the active title. Resolves to the new activeTitle.
export async function setActiveTitle(characterId, title) {
  const res = await fetch('/api/achievements/title', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ characterId, title: title ?? null }),
  });
  if (!res.ok) throw await failure(res, 'set title');
  const data = await res.json();
  if (data && data.ok === false) throw new Error(data.error || t('Failed to set title'));
  return data.activeTitle ?? null;
}
