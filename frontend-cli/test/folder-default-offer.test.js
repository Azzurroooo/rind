// /model and /effort menus support Enter (this conversation only), f (folder
// default in workspaces.json), and g (global default in settings.json).
import test from "node:test";
import assert from "node:assert/strict";

import { createCliRuntimeController } from "../lib/cli-runtime-controller.js";
import { createCliState } from "../lib/cli-state.js";
import { runtimeMethods as methods } from "../lib/runtime-protocol.js";

const MODELS = [
  { provider_id: "deepseek", id: "deepseek-flash", reasoning_efforts: ["low", "high", "max"] },
  { provider_id: "deepseek", id: "deepseek-v4-pro", reasoning_efforts: ["low", "high", "max"] },
];

function harness({ modelScope = "session", effortScope = "session" } = {}) {
  const state = createCliState();
  state.session.info = { session_id: "s1", workspace_root: "/work/app", provider: "deepseek", model: "deepseek-flash", reasoning_effort: "low" };
  const requests = [];
  const questions = [];
  const logs = [];
  const client = {
    child: {},
    start() {},
    async request(method, params) {
      requests.push([method, params]);
      if (method === methods.initialize) return { protocol_version: "2", capabilities: [], methods: [], session_id: "s1" };
      if (method === methods.modelList) return { models: MODELS };
      if (method === methods.modelSet) return { provider_id: params.provider_id, model_id: params.model_id, applies: "now" };
      return {};
    },
  };
  const controller = createCliRuntimeController({
    client, methods, sessionScopedMethods: new Set([methods.modelSet, methods.modelEffortSet]), turnScopedMethods: new Set(),
    requireInitialization: value => value, state, getCommands: () => ({ normalizeCommands: () => [], localCommands: () => [] }), getTaskMonitor: () => null, getCompactContextState: () => ({ clear() {} }),
    askModelMenu: async () => ({ providerId: "deepseek", modelId: "deepseek-v4-pro", scope: modelScope }),
    askEffortMenu: async () => (effortScope === "session" ? "high" : { effort: "high", scope: effortScope }),
    askChoice: async (question) => { questions.push(question); return ""; },
    askSessionMenu: async () => null, askForkPointMenu: async () => null, restoreLiveTurn() {}, clearPendingInputs() {},
    closeAssistant() {}, refreshInputState() {}, updateGoalState() {}, log: value => logs.push(typeof value === "function" ? value() : value),
    writeError() {}, redraw() {},
  });
  const sets = () => requests.filter(([method]) => method === methods.folderDefaultsSet).map(([, params]) => params);
  return { state, controller, questions, logs, sets };
}

test("/model with Enter changes only this conversation and never opens a dialog", async () => {
  const h = harness({ modelScope: "session" });
  await h.controller.runModelSelector();
  assert.equal(h.state.session.info.model, "deepseek-v4-pro");
  assert.equal(h.questions.length, 0);
  assert.deepEqual(h.sets(), []);
  assert.match(h.logs.join("\n"), /Model changed to deepseek-v4-pro \(session only\)/);
});

test("/model with f saves the folder default without opening a dialog", async () => {
  const h = harness({ modelScope: "folder" });
  await h.controller.runModelSelector();
  assert.equal(h.questions.length, 0);
  assert.deepEqual(h.sets(), [{ workspace_root: "/work/app", provider_id: "deepseek", model_id: "deepseek-v4-pro" }]);
  const joined = h.logs.join("\n");
  assert.match(joined, /Model changed to deepseek-v4-pro/);
  assert.doesNotMatch(joined, /\(session only\)/);
  assert.match(joined, /Folder default updated/);
  assert.match(joined, /open ones keep theirs/);
});

test("/model with g saves the global default in settings.json", async () => {
  const h = harness({ modelScope: "global" });
  await h.controller.runModelSelector();
  assert.equal(h.questions.length, 0);
  assert.deepEqual(h.sets(), [{ workspace_root: "/work/app", scope: "global", provider_id: "deepseek", model_id: "deepseek-v4-pro" }]);
  const joined = h.logs.join("\n");
  assert.match(joined, /Model changed to deepseek-v4-pro/);
  assert.doesNotMatch(joined, /\(session only\)/);
  assert.match(joined, /Global default updated/);
  assert.match(joined, /settings\.json: deepseek \/ deepseek-v4-pro/);
});

test("/effort with Enter, f, or g emits unified single-line notices and saves folder or global effort default", async () => {
  const sessionOnly = harness({ effortScope: "session" });
  await sessionOnly.controller.runEffortCommand();
  assert.deepEqual(sessionOnly.sets(), []);
  assert.match(sessionOnly.logs.join("\n"), /Reasoning effort set to high \(session only\)/);

  const folder = harness({ effortScope: "folder" });
  await folder.controller.runEffortCommand();
  assert.deepEqual(folder.sets(), [{ workspace_root: "/work/app", reasoning_effort: "high" }]);
  assert.match(folder.logs.join("\n"), /Reasoning effort set to high/);
  assert.doesNotMatch(folder.logs.join("\n"), /\(session only\)/);

  const global = harness({ effortScope: "global" });
  await global.controller.runEffortCommand();
  assert.deepEqual(global.sets(), [{ workspace_root: "/work/app", scope: "global", reasoning_effort: "high" }]);
  assert.match(global.logs.join("\n"), /Reasoning effort set to high/);
  assert.doesNotMatch(global.logs.join("\n"), /\(session only\)/);
});

test("before the first message, f or g still saves the default while keeping the choice for the window", async () => {
  const h = harness({ effortScope: "folder" });
  h.state.session.info = { ...h.state.session.info, session_id: "" };
  await h.controller.runEffortCommand();
  assert.equal(h.state.session.info.reasoning_effort, "high");
  assert.deepEqual(h.sets(), [{ workspace_root: "/work/app", reasoning_effort: "high" }]);
});

test("before the first message, /model and /effort reflect the window's chosen model over blank_info defaults", async () => {
  const state = createCliState();
  state.session.info = { session_id: "", workspace_root: "/work/app", provider: "deepseek", model: "deepseek-v4-pro", reasoning_effort: "low" };
  let seenCurrentModel = null;
  let seenEfforts = null;
  const client = {
    child: {},
    start() {},
    async request(method) {
      if (method === methods.modelList) {
        return {
          models: [
            { provider_id: "deepseek", id: "deepseek-flash", reasoning_efforts: [] },
            { provider_id: "deepseek", id: "deepseek-v4-pro", reasoning_efforts: ["low", "high", "max"] },
          ],
          // Server blank_info still reports the disk default before a session exists:
          current: { provider_id: "deepseek", model_id: "deepseek-flash" },
          current_model: "deepseek-flash",
        };
      }
      return {};
    },
  };
  const controller = createCliRuntimeController({
    client, methods, sessionScopedMethods: new Set(), turnScopedMethods: new Set(),
    requireInitialization: value => value, state, getCommands: () => ({ normalizeCommands: () => [], localCommands: () => [] }), getTaskMonitor: () => null, getCompactContextState: () => ({ clear() {} }),
    askModelMenu: async (_models, currentModel) => { seenCurrentModel = currentModel; return null; },
    askEffortMenu: async (_currentEffort, levels) => { seenEfforts = levels; return null; },
    askChoice: async () => "", askSessionMenu: async () => null, askForkPointMenu: async () => null,
    restoreLiveTurn() {}, clearPendingInputs() {}, closeAssistant() {}, refreshInputState() {}, updateGoalState() {}, log() {}, writeError() {}, redraw() {},
  });
  await controller.runModelSelector();
  assert.deepEqual(seenCurrentModel, { provider_id: "deepseek", model_id: "deepseek-v4-pro" });
  await controller.runEffortCommand();
  assert.deepEqual(seenEfforts, ["low", "high", "max"]);
});

test("real TTY CLI: /login custom provider writes providers.json + auth.json, /model and /effort menus operate with single-line notices and zero user bubble echoes, and /status describes the provider", { timeout: 60000 }, async (t) => {
  const { mkdtemp, mkdir, readFile } = await import("node:fs/promises");
  const { spawn } = await import("node:child_process");
  const http = await import("node:http");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createVirtualOutput } = await import("./helpers/virtual-terminal.js");
  const { removeRindHome } = await import("./helpers/rind-home.js");

  const home = await mkdtemp(path.join(os.tmpdir(), "rind-tty-defaults-"));
  const workspace = path.join(home, "project");
  await mkdir(workspace, { recursive: true });
  const provider = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "gw-alpha" }, { id: "gw-beta" }] }));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;

  const script = `
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    process.stdin.setRawMode = value => { process.stdin.isRaw = value; };
    process.stdout.columns = 110; process.stdout.rows = 30;
    const { runFrontendCliApp } = await import(${JSON.stringify(new URL("../lib/frontend-cli-implementation.js", import.meta.url).href)});
    await runFrontendCliApp(${JSON.stringify(["--cwd", workspace, "--standalone"])});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: workspace,
    env: { ...process.env, RIND_HOME: home, RIND_PYTHON: process.env.RIND_PYTHON || "python", NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = createVirtualOutput({ columns: 110, rows: 30 });
  child.stdout.on("data", value => output.output.write(value));
  let errors = "";
  child.stderr.on("data", value => { errors += value; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    await new Promise(resolve => provider.close(resolve));
    await removeRindHome(home);
  });

  const screen = async () => (await output.flushAndGetViewport()).join("\n");
  async function visible(text) {
    for (let i = 0; i < 600; i++) {
      const s = await screen();
      if (s.includes(text)) return s;
      if (child.exitCode !== null) break;
      await new Promise(r => setTimeout(r, 25));
    }
    assert.fail("Expected " + text + "\n" + await screen() + "\n" + errors);
  }

  await visible("session new");

  // 0. /status before any login: the built-in provider is named and the missing sign-in is a warning with its fix
  child.stdin.write("/status\r");
  const firstStatus = await visible("not signed in");
  assert.match(firstStatus, /── Status · /);
  assert.match(firstStatus, /Provider\n\s+provider\s+\S.*built-in/);
  assert.match(firstStatus, /auth\s+not signed in\s+\/login/);
  assert.doesNotMatch(firstStatus, /▷ You/);

  // 1. Add a custom provider via /login
  child.stdin.write("/login\r");
  await visible("Sign in with an API key");
  child.stdin.write("\x1b[B\r"); // select "Sign in with an API key"
  await visible("Login · Provider");
  child.stdin.write("\x1b[A"); // wrap up to "+ Add a custom provider"
  await visible("+ Add a custom provider");
  child.stdin.write("\r");
  await visible("Connection name");
  child.stdin.write("Team Gateway\r");
  await visible("API protocol for Team Gateway");
  child.stdin.write("\r"); // select "openai-chat · OpenAI Chat Completions"
  await visible("Base URL");
  child.stdin.write(`${baseUrl}\r`);
  await visible("Model id");
  child.stdin.write("gw-alpha\r");
  await visible("Login · Team Gateway");
  child.stdin.write("gw-secret-key\r");
  await visible("Logged in to team-gateway");

  const providersJson = JSON.parse(await readFile(path.join(home, "providers.json"), "utf8"));
  assert.deepEqual(providersJson.providers["team-gateway"], {
    name: "Team Gateway",
    api: "openai-chat",
    baseUrl,
    models: { "gw-alpha": {} },
  });
  const authJson = JSON.parse(await readFile(path.join(home, "auth.json"), "utf8"));
  assert.equal(authJson["team-gateway"].key, "gw-secret-key");

  // 2. Open /model menu and cancel with Esc: leaves zero trace in transcript
  child.stdin.write("/model\r");
  await visible("Model deck");
  child.stdin.write("\x1b");
  for (let i = 0; i < 200; i++) {
    if (!(await screen()).includes("Model deck")) break;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.doesNotMatch(await screen(), /Model deck/);
  assert.doesNotMatch(await screen(), /Model changed to/);
  assert.doesNotMatch(await screen(), /▷ You/);

  // 3. Open /model menu, select gw-beta with Enter (session only)
  child.stdin.write("/model\r");
  await visible("f folder default · g global default");
  child.stdin.write("\x1b[B\r");
  await visible("Model changed to gw-beta (session only)");

  // 4. Open /model menu (highlights current window model gw-beta), move up to gw-alpha, and press 'f' to set folder default
  child.stdin.write("/model\r");
  await visible("f folder default · g global default");
  child.stdin.write("\x1b[A");
  child.stdin.write("f");
  await visible("Model changed to gw-alpha");
  await visible("Folder default updated");

  const workspacesJson = JSON.parse(await readFile(path.join(home, "workspaces.json"), "utf8"));
  const folderEntry = Object.values(workspacesJson)[0];
  assert.equal(folderEntry.provider, "team-gateway");
  assert.equal(folderEntry.model, "gw-alpha");

  // 5. Open /model menu, move down to gw-beta, and press 'g' to set global default
  child.stdin.write("/model\r");
  await visible("f folder default · g global default");
  child.stdin.write("\x1b[B");
  child.stdin.write("g");
  await visible("Model changed to gw-beta");
  await visible("Global default updated");

  const settingsJson = JSON.parse(await readFile(path.join(home, "settings.json"), "utf8"));
  assert.equal(settingsJson.provider, "team-gateway");
  assert.equal(settingsJson.model, "gw-beta");

  // 6. Open /effort menu: renders Reasoning effort (not Model deck / Image input) and sets session effort on Enter
  child.stdin.write("/effort\r");
  const effortMenuScreen = await visible("Reasoning effort");
  assert.doesNotMatch(effortMenuScreen, /Image input:/);
  child.stdin.write("\x1b[B\r");
  await visible("Reasoning effort set to");

  // 7. Direct /effort command: sets effort with concise notice and still zero user bubbles
  child.stdin.write("/effort high\r");
  await visible("Reasoning effort set to high (session only)");
  assert.doesNotMatch(await screen(), /▷ You/);

  // 8. /status names the custom provider, how it signs in, its endpoint and protocol
  child.stdin.write("/status\r");
  const status = await visible("custom · providers.json");
  assert.match(status, /── Status · team-gateway \/ gw-beta · high/);
  assert.match(status, /model\s+gw-beta/);
  assert.match(status, /effort\s+high\s+this conversation/);
  assert.match(status, /provider\s+Team Gateway\s+custom · providers\.json/);
  assert.match(status, /auth\s+API key\s+saved login/);
  assert.ok(status.includes(`${baseUrl.replace(/^http:\/\//, "")}`), "the endpoint is shown without its scheme");
  assert.match(status, /openai-chat/);
  assert.match(status, /Context\n\s+no completed sampling yet/);
  assert.doesNotMatch(status, /not signed in/);
  assert.doesNotMatch(status, /▷ You/);
});
