import React from "react";
import { createPortal } from "react-dom";
import { useStore } from "../data/store.jsx";

/**
 * The toast's live region: on the page from the start and empty until a message is put in it — a region inserted together with
 * its text is often not announced (VoiceOver) — and drawn in document.body beside the app, marked `data-live`, so that a dialog,
 * which makes the rest inert (ui/layers.js), leaves it live. Each message is its own node (keyed): the same words twice are read
 * twice. It takes no tap (styles.css `.toast-region`).
 */
export function ToastRegion() {
  const { state } = useStore();
  return createPortal(
    <div className="toast-region" role="status" data-live="">
      {state.toast && (
        <p key={state.toast.id} className="toast">
          {state.toast.text}
        </p>
      )}
    </div>,
    document.body,
  );
}
