import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./src/js/net/auth.js";
import { emptyCatalogs } from "./itemTypeForm.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";

// SOMET-329. The four weapon-option catalogs, read as ONE query because the
// Items form needs all of them to render — four separate queries would let the
// form paint with some dropdowns populated and others still empty, which reads
// as "this weapon has no valid shapes" rather than "still loading".
export const WEAPON_CATALOGS_QUERY_KEY = ["weaponCatalogs"];

export function useWeaponCatalogs() {
  const { data, isLoading } = useQuery({
    queryKey: WEAPON_CATALOGS_QUERY_KEY,
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/weapon-catalogs`);
      if (!res.ok) throw new Error("Failed to fetch weapon catalogs");
      return res.json();
    },
  });
  // Never undefined: every consumer maps over these arrays to build a <select>,
  // and the seeded fallbacks in itemTypeForm.js only cover validation, not
  // rendering. `emptyCatalogs()` keeps the shape stable while the query is in
  // flight or has failed — the dropdowns render empty, and the form still
  // validates against the seeded lists.
  return { catalogs: data || emptyCatalogs(), isLoadingCatalogs: isLoading };
}
