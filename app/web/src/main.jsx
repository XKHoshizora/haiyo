import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";
import "./styles/social.css";
import "./styles/others.css";
import { installStaleChunkReload } from "./staleChunk.js";
import { startShell } from "./shell/bridge.js";

installStaleChunkReload();
startShell(); // (The iOS app's shell, when this page is in it: `hello` and its events. Nothing in a browser.)

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
