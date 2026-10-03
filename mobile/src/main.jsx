import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/manrope";
import "@fontsource/dm-mono/400.css";
import "@fontsource/dm-mono/500.css";
import "@surface/styles/index.css";
import { applyThemePreference, readThemePreference } from "@surface/lib/theme.js";
import MobileApp from "./MobileApp.jsx";
import "./mobile.css";

applyThemePreference(readThemePreference());
createRoot(document.getElementById("root")).render(<React.StrictMode><MobileApp /></React.StrictMode>);
