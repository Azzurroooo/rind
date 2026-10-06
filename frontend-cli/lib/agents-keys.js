import { paint } from "./theme.js";
import { textWidth } from "./text-width.js";

// Every key on the Agents page is declared here once. available() says which
// actions the selected row offers, so the footer, the ? overlay and the key
// dispatcher can never disagree about what a key does.
//   keys: what triggers it ("enter", "space", "tab", or a typed character)
//   key:  how it is shown;  help: its line in the ? overlay
export const ACTIONS = {
  open: { keys: ["enter"], key: "enter", label: "open", help: "open the selected item" },
  actions: { keys: ["space"], key: "space", label: "more actions", help: "all actions for the selected item or team" },
  chat: { keys: ["c"], key: "c", label: "new conversation", help: "new conversation with a member or folder" },
  edit: { keys: ["e"], key: "e", label: "edit role", help: "edit a member's role and responsibility" },
  task: { keys: ["t"], key: "t", label: "assign task", help: "give a member, or the leader, a task" },
  add: { keys: ["a"], key: "a", label: "add member", help: "add a member, below the selected one" },
  tabs: { keys: ["tab", "1", "2"], key: "tab", label: "Organization · Tasks", help: "Organization (1) · Tasks (2)" },
  newTeam: { keys: ["n"], key: "n", label: "new team", help: "create a team" },
  search: { keys: ["/"], key: "/", label: "search", help: "search this list; esc clears" },
  filter: { keys: ["f"], key: "f", label: "filter", help: "filter by status" },
  fold: { keys: ["z"], key: "z", label: "fold", help: "fold or unfold the selected branch" },
  foldAll: { keys: ["Z"], key: "Z", label: "fold all", help: "fold or unfold everything" },
  group: { keys: ["[", "]"], key: "[ ]", label: "previous · next group", help: "previous or next folder, branch, section" },
  refresh: { keys: ["r"], key: "r", label: "refresh", help: "reload, or reconnect when offline" },
  stop: { keys: ["S"], key: "S", label: "stop all…", help: "stop every agent and the services" },
  help: { keys: ["?"], key: "?", label: "help", help: "show or hide this help" },
};

// Navigation is handled before actions and is the same on every page.
const NAVIGATION = [
  ["↑↓ j k", "move"], ["g G", "first · last"], ["pgup pgdn", "page"], ["←", "up: conversation › member › sidebar"],
  ["→", "open · unfold"], ["esc", "back; from the sidebar, to chat"], ["ctrl+c ×2", "leave Rind · agents keep running"],
];

const act = (name, label) => ({ id: name, label: label || ACTIONS[name].label });

// What Enter does on the selected row, in plain words.
function enterLabel(view, row) {
  if (!row) return "";
  if (view.focus === "sidebar") return row.kind === "new-team" ? "create team" : "open";
  if (row.archived) return "open report";
  switch (row.kind) {
    case "member": return "open member";
    case "session": return "join";
    case "more": return "show all";
    case "workspace": return "open folder";
    case "new-session": return "start";
    case "add-member": return "add member";
    case "assign": return "assign task";
    case "team": return "open team";
    case "new-team": return "create team";
    case "run": return "resolve";
    case "approval": return "decide";
    case "service": return "actions";
    case "stop-all": return "stop…";
    case "live": return row.taskId ? "open report" : row.sessionId ? "join" : "";
    case "task": return row.answer ? "answer" : row.status === "Done" ? "open report" : "open task";
    default: return "";
  }
}

// What the selected row offers, most useful first; this is the footer order.
export function available(view, row) {
  const page = view.page.kind;
  const org = page === "team" && view.page.tab === "org";
  const list = [];
  const enter = enterLabel(view, row);
  if (enter) list.push(act("open", enter));
  if (view.focus === "sidebar") return [...list, ...(row?.kind === "team" ? [act("actions")] : []), act("newTeam"), act("refresh"), act("help")];
  if (["member", "session", "task", "service"].includes(row?.kind) && !(row.kind === "task" && (row.answer || row.archived))) list.push(act("actions"));
  const folder = ["independent", "folder"].includes(page) && (row?.workspace || view.page.workspace);
  if ((org && ["member", "session", "more"].includes(row?.kind)) || page === "member" || folder) list.push(act("chat"));
  if (row?.kind === "member" || page === "member") list.push(act("edit"));
  if (page === "team" || page === "member") list.push(act("task"));
  if (org) list.push(act("add", row?.kind === "member" ? "add member below" : undefined));
  if (page === "team") list.push(act("tabs"));
  if (org || page === "independent") list.push(act("fold"), act("foldAll"));
  if (["independent", "folder", "inbox", "background", "archive"].includes(page) || (page === "team" && view.page.tab === "tasks")) list.push(act("group"));
  if (page === "background") list.push(act("stop"));
  if (page !== "new-team") list.push(act("search"));
  if (["team", "member", "independent", "folder"].includes(page)) list.push(act("filter"));
  if (page === "team" || page === "member") list.push(act("newTeam"));
  list.push(act("refresh"), act("help"));
  return list;
}

const matches = (key, spec) => spec === "enter" ? key.name === "enter" || key.name === "return"
  : spec === "space" ? key.text === " "
  : spec === "tab" ? key.name === "tab" && !key.shift
  : key.text === spec;

// The available action a key triggers, if any.
export function actionFor(view, row, key) {
  return available(view, row).find(action => ACTIONS[action.id].keys.some(spec => matches(key, spec)));
}

// The ? overlay, built from the same table.
export function helpGroups() {
  const pick = names => names.map(name => [ACTIONS[name].key === "tab" ? "tab 1 2" : ACTIONS[name].key, ACTIONS[name].help]);
  return [
    { title: "Navigate", items: NAVIGATION },
    { title: "Selected item", items: pick(["open", "actions", "chat", "edit"]) },
    { title: "Teams", items: pick(["task", "add", "tabs", "newTeam"]) },
    { title: "Lists", items: pick(["search", "filter", "fold", "foldAll", "group", "refresh", "help"]) },
    { title: "Background", items: [...pick(["stop"]), ["", "leaving Rind never stops agents"]] },
  ];
}

// Footer hints. Dialogs, reports, search and the leave prompt have their own;
// lists show what available() offers for the selected row.
export function hintsFor(view, row) {
  const hint = (key, label) => ({ key, label });
  if (view.help) return [hint("esc", "close")];
  if (view.dialog?.kind === "choice") return [hint("↑↓", "choose"), hint("enter", "confirm"), ...(view.dialog.items.length > 1 ? [hint("1-9", "pick")] : []), hint("esc", "cancel")];
  if (view.dialog) {
    const field = view.dialog.fields[view.dialog.index];
    if (field?.suggestions?.length) return [hint("tab", "complete"), hint("↑↓", "choose"), hint("enter", field.pick >= 0 ? "use folder" : "next"), hint("esc", "hide list")];
    if (field?.kind === "path") return [hint("tab", "complete"), hint("enter", "next / save"), hint("⇧tab", "previous"), hint("esc", "cancel")];
    return [hint("enter", "next / save"), hint("tab", "next field"), hint("esc", "cancel")];
  }
  if (view.detail) return view.detail.hints || [hint("↑↓", "scroll"), hint("esc", "back")];
  if (view.searching) return [hint("type", "to search"), hint("enter", "keep filter"), hint("esc", "clear")];
  if (view.leaveArmed) return [hint("ctrl+c", "again to leave Rind · agents keep running"), hint("esc", "stay")];
  const list = available(view, row).filter(action => !["help", "foldAll"].includes(action.id)).map(action => hint(ACTIONS[action.id].key, action.label));
  const back = view.focus === "sidebar" ? hint("esc", view.standalone ? "close" : "back to chat") : hint("esc", "back");
  return [...list, ...(view.focus === "sidebar" ? [hint("ctrl+c ×2", "leave Rind")] : []), hint("?", "help"), back];
}

const SEPARATOR = "  ";
const PINNED = new Set(["?", "esc"]);
// Help and the way back are always kept; other hints fill the remaining width
// in priority order.
export function formatHints(hints, width) {
  const size = hint => textWidth(hint.key + " " + hint.label);
  const pinned = hints.filter(hint => PINNED.has(hint.key));
  let used = pinned.reduce((sum, hint) => sum + size(hint) + SEPARATOR.length, 0);
  const shown = [];
  for (const hint of hints.filter(hint => !PINNED.has(hint.key))) {
    if (used + size(hint) + SEPARATOR.length > width + SEPARATOR.length) break;
    shown.push(hint);
    used += size(hint) + SEPARATOR.length;
  }
  return [...shown, ...pinned].filter(hint => size(hint) <= width).map(hint => paint.bold(hint.key) + " " + paint.dim(hint.label)).join(SEPARATOR);
}
