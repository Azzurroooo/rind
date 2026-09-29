import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/manrope";
import "@fontsource/dm-mono/400.css";
import "@fontsource/dm-mono/500.css";
import App from "./App.jsx";
import { readStoredTheme, applyTheme } from "./lib/theme.js";
import "./styles/index.css";

// Pin an explicit stored theme before the first paint; with no stored choice
// the tokens follow prefers-color-scheme on their own (no flash either way).
const pinned = readStoredTheme();
if (pinned) applyTheme(pinned);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
