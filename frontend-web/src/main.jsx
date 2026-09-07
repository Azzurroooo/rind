import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { applyTheme, initialTheme } from "./lib/theme.js";
import "./styles.css";

// Apply the persisted (or OS-preferred) theme before the first paint so the
// dark shell never flashes for light-theme users.
applyTheme(initialTheme());

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
