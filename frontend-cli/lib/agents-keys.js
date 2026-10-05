import { paint } from "./theme.js";
import { textWidth } from "./text-width.js";

// One table drives the footer hints, the ? overlay and the shortcut column of
// action menus, so a key never means different things in different places.
export const KEYS = {
  move: { key: "↑↓", label: "move" },
  fold: { key: "z", label: "fold" },
  up: { key: "←", label: "up" },
  back: { key: "esc", label: "back" },
  exit: { key: "esc", label: "back to chat" },
  open: { key: "enter", label: "open" },
  focus: { key: "enter", label: "select" },
  members: { key: "enter", label: "conversations" },
  join: { key: "enter", label: "join" },
  start: { key: "enter", label: "start" },
  delivery: { key: "enter", label: "delivery" },
  resolve: { key: "enter", label: "resolve" },
  create: { key: "enter", label: "create" },
  actions: { key: "space", label: "actions" },
  chat: { key: "c", label: "new chat" },
  task: { key: "t", label: "assign task" },
  add: { key: "a", label: "add member" },
  report: { key: "a", label: "add report" },
  edit: { key: "e", label: "edit role" },
  team: { key: "n", label: "new team" },
  view: { key: "tab", label: "switch view" },
  search: { key: "/", label: "search" },
  filter: { key: "f", label: "filter" },
  refresh: { key: "r", label: "refresh" },
  help: { key: "?", label: "help" },
  scroll: { key: "↑↓", label: "scroll" },
  choose: { key: "↑↓", label: "choose" },
  pick: { key: "1-9", label: "pick" },
  confirm: { key: "enter", label: "confirm" },
  cancel: { key: "esc", label: "cancel" },
  next: { key: "enter", label: "next / save" },
  field: { key: "tab", label: "field" },
  keep: { key: "enter", label: "keep filter" },
  clear: { key: "esc", label: "clear" },
  close: { key: "esc", label: "close" },
};

export const HELP_GROUPS = [
  { title: "Navigate", items: [["↑↓ j k", "move"], ["←", "up: conversation › member › teams"], ["→", "open · expand"], ["z Z", "fold branch · fold all"], ["enter", "open the selected item"], ["g G", "first · last"], ["pgup pgdn", "page"], ["tab 1 2", "Organization · Tasks"], ["esc", "back · return to chat"]] },
  { title: "Team", items: [["c", "new conversation"], ["t", "assign a task"], ["a", "add member (direct report)"], ["e", "edit role"], ["space", "all actions for the item"], ["n", "new team"]] },
  { title: "View", items: [["/", "search this view"], ["f", "filter by status"], ["r", "refresh · reconnect"], ["?", "toggle this help"]] },
];

// Hints are listed most important first; the footer drops from the end so a
// hint is never cut in half.
export function hintsFor(view, row) {
  const k = name => KEYS[name];
  if (view.help) return [k("close")];
  if (view.dialog?.kind === "choice") return [k("choose"), k("confirm"), ...(view.dialog.items.length > 1 ? [k("pick")] : []), k("cancel")];
  if (view.dialog) return [k("next"), k("field"), k("cancel")];
  if (view.detail) return [k("scroll"), ...(view.detail.taskId ? [k("actions")] : []), k("refresh"), k("back")];
  if (view.searching) return [{ key: "type", label: "to search" }, k("keep"), k("clear")];
  if (view.focus === "sidebar") return [k("move"), row?.kind === "new-team" ? k("create") : k("focus"), k("team"), k("help"), k("exit")];
  const tail = [k("search"), k("filter"), k("help"), k("back")];
  const page = view.page.kind;
  if (page === "team" && view.page.tab === "org") {
    if (row?.kind === "member") return [k("members"), k("chat"), k("task"), k("report"), k("actions"), ...(row.expandable ? [k("fold")] : []), k("view"), ...tail];
    if (row?.kind === "session") return [k("join"), k("actions"), k("chat"), k("up"), k("view"), ...tail];
    if (row?.kind === "more") return [k("open"), k("chat"), k("view"), ...tail];
    return [row?.kind === "add-member" ? k("create") : k("start"), k("add"), k("view"), ...tail];
  }
  if (page === "team") return [row?.kind === "task" ? k("delivery") : k("create"), ...(row?.kind === "task" ? [k("actions")] : []), k("task"), k("view"), ...tail];
  if (page === "member") return [row?.kind === "session" ? k("join") : k("start"), ...(row?.kind === "session" ? [k("actions")] : []), k("task"), ...tail];
  if (page === "manager") return [row?.kind === "session" ? k("join") : k("start"), k("search"), k("help"), k("back")];
  if (page === "independent") return [row?.kind === "session" ? k("join") : k("chat"), ...(row?.kind === "session" ? [k("up")] : []), k("search"), k("filter"), k("refresh"), k("help"), k("back")];
  return [row?.kind === "team" ? k("open") : row?.kind === "new-team" ? k("create") : k("resolve"), k("team"), k("refresh"), k("help"), k("back")];
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
