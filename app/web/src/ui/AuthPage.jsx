// The layer every screen of the account gate sits on (the cards, the loading line, the crash fallback): fixed over what is visible, scrolling inside
// it, whatever single child it has centred (styles.css `.auth-page`). Its box follows the visual viewport (the keyboard, the browser's panning, a pinch
// zoom): the style is written onto the element at each event, with no React state, so the layer is never a frame behind the viewport.
import React, { useRef } from "react";
import { useVisibleLayer } from "./visualViewport.js";

export function AuthPage({ children }) {
  const ref = useRef(null);
  useVisibleLayer(ref);
  return (
    <main className="auth-page" ref={ref}>
      {children}
    </main>
  );
}
