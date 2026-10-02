import { ToastProvider } from "./components/overlays/Toast.jsx";
import { Shell } from "./app/Shell.jsx";
import { SurfacePlatform } from "./platform.jsx";

// The Rind Web client. Runtime wiring lives in app/useAppController.js and the
// layout in app/Shell.jsx.
export default function App({ platform } = {}) {
  const surface = (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
  return platform ? <SurfacePlatform.Provider value={platform}>{surface}</SurfacePlatform.Provider> : surface;
}
