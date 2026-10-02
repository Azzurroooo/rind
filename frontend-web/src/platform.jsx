import { createContext, useContext } from "react";
import * as credentials from "./ticket.js";

// Native clients inject capabilities. The shared surface never imports a native SDK.
const webPlatform = Object.freeze({ credentials });
export const SurfacePlatform = createContext(webPlatform);
export function useSurfacePlatform() { return useContext(SurfacePlatform); }
