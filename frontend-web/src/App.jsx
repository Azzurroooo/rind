import { ToastProvider } from "./components/overlays/Toast.jsx";
import { Shell } from "./app/Shell.jsx";

// The Rind Web client. Runtime wiring lives in app/useAppController.js and the
// layout in app/Shell.jsx.
export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
