import path from "node:path";
import { access } from "node:fs/promises";
import { createLineEditor } from "./line-editor.js";
import { folderSuggestions, commonCompletion, inspectFolder, resolveInputPath, checkFolderName } from "./path-input.js";

// A form dialog. Field kinds:
//   text  (default)  free text; `optional` fields may stay empty
//   path  { require: "folder" | "git" }  completes folders with Tab and checks them live
//   name  { root }   a new folder name inside `root`, previewed and checked live
// Any field may add validate(text) returning an error message, or "" when valid.
// `derive(values)` fills an empty field when it gains focus.
// Enough to browse a large folder; beyond this, typing narrows faster than scrolling.
const SUGGESTION_LIMIT = 200;

export function createForm({ title, fields, submit, description = [], danger = false, base = process.cwd(), onChange = () => {} }) {
  const form = {
    kind: "form", title, description, danger, submit, error: "", index: 0, base,
    fields: fields.map(field => ({ kind: "text", ...field, editor: createLineEditor(field.value || ""), suggestions: [], pick: -1, check: null, token: 0 })),
  };
  const field = () => form.fields[form.index];
  const values = () => Object.fromEntries(form.fields.map(item => [item.key, item.editor.input().trim()]));

  async function refresh(item, { suggest = true } = {}) {
    const token = ++item.token;
    const text = item.editor.input().trim();
    let check = null, suggestions = [];
    if (item.kind === "path") {
      const [found, folder] = await Promise.all([suggest && text ? folderSuggestions(text, base, SUGGESTION_LIMIT + 1) : [], inspectFolder(text, base)]);
      item.more = found.length > SUGGESTION_LIMIT;
      found.length = Math.min(found.length, SUGGESTION_LIMIT);
      suggestions = found.filter(s => s.value.replace(/[\\/]$/, "") !== text.replace(/[\\/]$/, ""));
      // While the path is still being typed, matching folders are guidance, not an error.
      check = folder.kind === "empty" ? { tone: "hint", text: "Absolute, ~ or relative to " + base }
        : folder.kind === "missing" && suggestions.length ? { tone: "hint", text: suggestions.length + (suggestions.length === 1 ? " matching folder" : " matching folders") + " · Tab completes" }
        : folder.kind === "missing" ? { tone: "error", text: "No folder at " + folder.path }
        : folder.kind === "file" ? { tone: "error", text: "This is a file, not a folder" }
        : item.require === "git" && !folder.git ? { tone: "error", text: "Not a Git repository: " + folder.path }
        : { tone: "ok", text: folder.path + (folder.git ? " · Git repository" : "") };
    } else if (item.kind === "name" && text) {
      const problem = checkFolderName(text);
      const target = path.join(item.root, text);
      const exists = !problem && await access(target).then(() => true, () => false);
      check = problem ? { tone: "error", text: problem } : exists ? { tone: "error", text: "Already exists: " + target } : { tone: "ok", text: "Creates " + target };
    }
    if (token !== item.token) return false;
    item.check = check; item.suggestions = suggestions;
    if (item.pick >= suggestions.length) item.pick = -1;
    onChange();
    return true;
  }
  function focus(index) {
    form.index = (index + form.fields.length) % form.fields.length;
    form.error = "";
    const item = field();
    if (item.derive && !item.editor.input()) item.editor.setInput(item.derive(values()) || "");
    for (const other of form.fields) if (other !== item) { other.suggestions = []; other.pick = -1; }
    void refresh(item, { suggest: false });
  }
  function accept(item, value) {
    item.editor.setInput(value);
    item.pick = -1;
    void refresh(item, { suggest: true });
  }
  function complete(item) {
    const text = item.editor.input();
    if (item.pick >= 0) return accept(item, item.suggestions[item.pick].value);
    const next = commonCompletion(text, item.suggestions);
    if (next !== text) return accept(item, next);
    if (item.suggestions.length > 1) { item.pick = 0; onChange(); return; }
    void refresh(item, { suggest: true });
  }
  // Returns an error message, or "" when the field may be left. A path that
  // only partly matches cannot be left either.
  function problem(item) {
    if (!item.editor.input().trim()) return item.optional ? "" : item.label + " is required.";
    const invalid = item.validate?.(item.editor.input().trim());
    if (invalid) return invalid;
    if (item.kind === "path" && item.check?.tone === "hint") return "Finish the folder path: Tab completes, ↑↓ choose.";
    return item.check?.tone === "error" ? item.check.text : "";
  }

  form.handleKey = (key, perform) => {
    const item = field();
    const suggesting = item.suggestions.length > 0;
    if (key.name === "escape") { if (suggesting) { item.suggestions = []; item.pick = -1; return true; } form.closed = true; return false; }
    if (key.name === "tab" && key.shift) { focus(form.index - 1); return true; }
    if (key.name === "tab") { if (item.kind === "path") complete(item); else focus(form.index + 1); return true; }
    if ((key.name === "up" || key.name === "down") && suggesting) {
      const step = key.name === "up" ? -1 : 1;
      item.pick = item.pick < 0 ? (step > 0 ? 0 : item.suggestions.length - 1) : (item.pick + step + item.suggestions.length) % item.suggestions.length;
      return true;
    }
    if ((key.name === "up" || key.name === "down") && !item.editor.input().includes("\n")) {
      focus(Math.max(0, Math.min(form.fields.length - 1, form.index + (key.name === "up" ? -1 : 1))));
      return true;
    }
    if ((key.name === "enter" || key.name === "return") && !key.shift && item.pick >= 0) { accept(item, item.suggestions[item.pick].value); return true; }
    if (item.editor.handleInput(key) !== "submit") { void refresh(item); return true; }
    // Checks are asynchronous; a fast Enter waits for the current text's result.
    // Only the check for the text as it is now may decide; a newer edit or a
    // closed form makes this Enter void.
    if (item.kind !== "text") { void refresh(item).then(applied => { if (applied) { advance(item, perform); onChange(); } }); return true; }
    advance(item, perform);
    return true;
  };
  function advance(item, perform) {
    if (form.closed || item !== field()) return;
    const error = problem(item);
    if (error) { form.error = error; return; }
    if (form.index < form.fields.length - 1) { focus(form.index + 1); return; }
    const blocking = form.fields.findIndex(other => problem(other));
    if (blocking >= 0) { const message = problem(form.fields[blocking]); focus(blocking); form.error = message; return; }
    const result = values();
    for (const other of form.fields) if (other.kind === "path" && result[other.key]) result[other.key] = resolveInputPath(result[other.key], base);
    void perform(() => submit(result), form, "Saving…");
  }
  form.paste = text => { const item = field(); item.editor.handleInput({ kind: "paste", text }); void refresh(item); };
  focus(0);
  return form;
}
