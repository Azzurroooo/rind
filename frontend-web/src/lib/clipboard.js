// Clipboard helper (message copy action): navigator.clipboard when the page
// is secure-context, else the legacy textarea+execCommand path, else false.
// Never throws — the caller owns the copied/failed state.
export async function copyText(value) {
  const text = String(value ?? "");
  if (!text) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path (denied permission, insecure context)
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand?.("copy");
    area.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
}
