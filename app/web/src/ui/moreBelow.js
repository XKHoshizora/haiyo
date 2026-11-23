import { useLayoutEffect, useState } from "react";

/**
 * Whether more rows wait below the visible part of the list `listRef` points at (while `active`; `key` changes when the list is drawn again): the cue — a
 * soft shade over the list's foot, `[data-more]` in styles.css — shows exactly then, at every length of list, for the model picker and the plain choice alike.
 */
export function useMoreBelow(listRef, active, key) {
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!active || !list) {
      setMore(false);
      return undefined;
    }
    const measure = () => setMore(list.scrollTop + list.clientHeight < list.scrollHeight - 1);
    measure();
    list.addEventListener("scroll", measure, { passive: true });
    const resized = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    resized?.observe(list);
    const changed = typeof MutationObserver === "function" ? new MutationObserver(measure) : null;
    changed?.observe(list, { childList: true, subtree: true });
    return () => {
      list.removeEventListener("scroll", measure);
      resized?.disconnect();
      changed?.disconnect();
    };
  }, [active, key]);
  return more;
}
