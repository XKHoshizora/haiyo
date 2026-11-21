import { useEffect, useRef } from "react";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

/**
 * The focus of a dialog (`ref`: its box), the same for every one: when it opens the focus goes to its `[data-autofocus]`
 * or else its first control; Tab and Shift+Tab go round inside it; Esc calls `onClose` (and goes no further); when it
 * closes the focus goes back to where it was — or to `returnTo()`, the element that opened it, when that is given and
 * still on the page.
 */
export function useDialogFocus(ref, { onClose, returnTo = null }) {
  const latest = useRef({ onClose, returnTo });
  latest.current = { onClose, returnTo };
  useEffect(() => {
    const node = ref.current;
    const previous = document.activeElement;
    const focusables = () => [...node.querySelectorAll(FOCUSABLE)];
    (node.querySelector("[data-autofocus]") || focusables()[0])?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        latest.current.onClose();
      }
      if (e.key === "Tab") {
        const list = focusables();
        if (!list.length) return;
        const head = list[0];
        const tail = list[list.length - 1];
        if (e.shiftKey && document.activeElement === head) {
          e.preventDefault();
          tail.focus();
        } else if (!e.shiftKey && document.activeElement === tail) {
          e.preventDefault();
          head.focus();
        }
      }
    };
    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      // The element that opened it; else where the focus was — whichever is still on the page.
      const back = [latest.current.returnTo?.(), previous].find((el) => el instanceof HTMLElement && el.isConnected);
      back?.focus();
    };
  }, [ref]);
}
