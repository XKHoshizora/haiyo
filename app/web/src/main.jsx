import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";
import "./styles/social.css";
import "./styles/others.css";
import "./styles/paint-probe.css";
import { applyPaintProbe } from "./debug/paintProbe.js";
import { installStaleChunkReload } from "./staleChunk.js";

installStaleChunkReload();
applyPaintProbe();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
