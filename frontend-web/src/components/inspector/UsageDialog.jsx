import { Dialog } from "../overlays/Dialog.jsx";
import { UsageTab } from "./UsageTab.jsx";

export function UsageDialog({ open, onClose, request, usageEnabled, authEnabled }) {
  return <Dialog open={open} onClose={onClose} title="Usage" description="Across all projects and sessions on this Rind computer." className="usage-dialog" size="lg">
    {open && <UsageTab request={request} usageEnabled={usageEnabled} authEnabled={authEnabled} />}
  </Dialog>;
}
