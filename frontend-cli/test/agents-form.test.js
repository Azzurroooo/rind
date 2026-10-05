import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createForm } from "../lib/agents-form.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 40));
const key = (name, extra = {}) => ({ name, ...extra });
const typed = text => ({ kind: "paste", text });

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "rind-form-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const name of ["api-server", "app-web", "repo/.git"]) await mkdir(path.join(base, "projects", name), { recursive: true });
  const submitted = [];
  const perform = async (action, dialog) => { try { await action(); } catch (error) { dialog.error = error.message; } };
  const form = createForm({ title: "Add", base, submit: async values => { submitted.push(values); }, fields: [
    { key: "workspace", label: "Folder", kind: "path", require: "folder" },
    { key: "name", label: "Name", optional: true, derive: values => path.basename(values.workspace.replace(/[\\/]$/, "")) },
    { key: "repo", label: "Repository", kind: "path", require: "git", optional: true },
  ] });
  return { base, form, perform, submitted };
}

test("Tab completes the shared prefix, then lists choices, and Enter takes the highlighted folder", async t => {
  const { form, perform } = await setup(t);
  const folder = form.fields[0];
  form.paste("projects/a"); await settle();
  assert.deepEqual(folder.suggestions.map(s => s.name), ["api-server", "app-web"], "suggestions appear while typing");
  assert.equal(folder.check.tone, "hint", "a partial path is guidance, not an error");
  form.handleKey(key("tab"), perform); await settle();
  assert.equal(folder.editor.input(), "projects/ap");
  form.handleKey(key("tab"), perform);
  assert.equal(folder.pick, 0, "a second Tab highlights the first choice");
  form.handleKey(key("down"), perform);
  form.handleKey(key("enter"), perform); await settle();
  assert.match(folder.editor.input(), /^projects\/app-web[\\/]$/);
  assert.equal(folder.check.tone, "ok");
  assert.equal(form.index, 0, "accepting a suggestion does not leave the field");
});

test("a field that does not resolve to a folder cannot be left, and Esc first hides suggestions", async t => {
  const { form, perform } = await setup(t);
  form.paste("projects/ap"); await settle();
  assert.equal(form.handleKey(key("escape"), perform), true, "esc hides the list instead of closing");
  assert.equal(form.fields[0].suggestions.length, 0);
  form.handleKey(key("enter"), perform); await settle();
  assert.equal(form.index, 0);
  assert.match(form.error, /Finish the folder path/);
  form.fields[0].editor.setInput("nowhere");
  form.handleKey(key("enter"), perform); await settle();
  assert.match(form.error, /No folder at/);
  assert.equal(form.handleKey(key("escape"), perform), false, "esc without suggestions closes the form");
});

test("submitting resolves relative paths, derives defaults and checks Git repositories", async t => {
  const { base, form, perform, submitted } = await setup(t);
  form.paste("projects/api-server"); form.handleKey(key("enter"), perform); await settle();
  assert.equal(form.index, 1);
  assert.equal(form.fields[1].editor.input(), "api-server", "the name defaults to the folder");
  form.handleKey(key("enter"), perform); await settle();
  form.paste("projects/app-web"); form.handleKey(key("enter"), perform); await settle();
  assert.match(form.error, /Not a Git repository/);
  form.fields[2].editor.setInput("projects/repo");
  form.handleKey(key("enter"), perform); await settle();
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0], { workspace: path.join(base, "projects", "api-server"), name: "api-server", repo: path.join(base, "projects", "repo") });
});
