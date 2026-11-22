// What kind of screen this is, read from the browser's media queries (and kept current): a phone is narrower than
// PHONE_QUERY (styles.css has the same number); a touch screen is one whose main pointer is coarse (a finger).
import { useMemo, useSyncExternalStore } from "react";

export const PHONE_QUERY = "(max-width: 640px)";
export const COARSE_QUERY = "(pointer: coarse)";

const matches = (query) => typeof window !== "undefined" && typeof window.matchMedia === "function" && Boolean(window.matchMedia(query)?.matches);

/** Whether `query` matches now; the component draws again when that changes. Where there are no media queries (a test's window): false. */
export function useMediaQuery(query) {
  const subscribe = useMemo(
    () => (notify) => {
      const list = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
      list?.addEventListener?.("change", notify);
      return () => list?.removeEventListener?.("change", notify);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => matches(query), () => false);
}

/** A phone-width window: the tab bar at the bottom instead of the rail on the left. */
export const usePhone = () => useMediaQuery(PHONE_QUERY);
/** A finger, not a mouse: the hints that name a keyboard or a wheel give way. */
export const useCoarsePointer = () => useMediaQuery(COARSE_QUERY);
