import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

export const TOAST_LIMIT = 3;
export const TOAST_DURATION_MS = 4000;

const ToastContext = createContext({ show: () => {}, dismiss: () => {} });

let toastSeq = 0;

// Bottom-center toast stack: newest last, at most three, each auto-dismissed after 4s.
export function ToastProvider({ children, duration = TOAST_DURATION_MS }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((items) => items.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback((message, options = {}) => {
    if (!message) return null;
    toastSeq += 1;
    const id = `toast-${toastSeq}`;
    const toast = { id, message: String(message), tone: options.tone || "info" };
    setToasts((items) => [...items, toast].slice(-TOAST_LIMIT));
    timers.current.set(id, setTimeout(() => dismiss(id), options.duration ?? duration));
    return id;
  }, [dismiss, duration]);

  useEffect(() => () => {
    timers.current.forEach((timer) => clearTimeout(timer));
    timers.current.clear();
  }, []);

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`} data-toast-id={toast.id}>
            <span className="toast-message">{toast.message}</span>
            <button type="button" className="icon-button" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
