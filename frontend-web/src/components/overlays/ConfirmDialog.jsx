import { useRef } from "react";
import { Dialog } from "./Dialog.jsx";

// Destructive confirmation: cancel is focused first so Enter never destroys by accident.
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  error = "",
  onConfirm,
  onCancel,
}) {
  const cancelRef = useRef(null);
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      className="confirm-dialog"
      initialFocus={cancelRef}
      footer={
        <>
          <button ref={cancelRef} type="button" className="button ghost confirm-no" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`button ${danger ? "danger" : "primary"} confirm-yes`}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {message && <p className="muted">{message}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </Dialog>
  );
}
