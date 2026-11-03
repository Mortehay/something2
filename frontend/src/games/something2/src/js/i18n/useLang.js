import { useSyncExternalStore } from "react";
import { getLang, onLangChange } from "./i18n.js";

// Re-renders the calling component when the language changes. Returns the code.
export function useLang() {
  return useSyncExternalStore(onLangChange, getLang, getLang);
}
