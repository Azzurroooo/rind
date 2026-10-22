import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCommandController } from "../lib/command-controller.js";
import { LOCAL_SLASH_COMMANDS } from "../lib/local-slash-commands.js";
import {
  buildPairingUrl,
  createCliRemoteController,
  createRemoteMenuState,
  decodeQrMatrix,
  decodeTerminalQr,
  encodeQrMatrix,
  formatRemoteOutput,
  parseTerminalQrMatrix,
  RemoteWebSocket,
  renderSvgQrDataUrl,
  renderTerminalQr,
} from "../lib/remote.js";
import { promptText, remoteMenuText } from "../lib/rendering.js";
import { createCliInputActions } from "../lib/cli-input-actions.js";
import { createCliState } from "../lib/cli-state.js";
import { removeRindHome } from "./helpers/rind-home.js";
import { connectSharedRuntime } from "../../rind-runtime-client/shared-runtime.js";
import { registerSharedWorkspace, samePath } from "../../rind-runtime-client/remote/workspaces.js";
import { connectManagement } from "../../agent-management/dist/client.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliBin = fileURLToPath(new URL("../bin/rind.js", import.meta.url));

test("QR matrix encoder and terminal half-block renderer round-trip pairing URLs accurately", () => {
  const urls = [
    "http://127.0.0.1:8766/#connect=test-code-123",
    "http://192.168.1.44:54321/#connect=abCD1234_-efGH567890ijklMNOPqrst",
    "https://rind-host.example.com/#connect=9876543210abcdefABCDEF1234567890",
  ];

  for (const url of urls) {
    const matrix = encodeQrMatrix(url);
    assert.equal(matrix.length, matrix[0].length, "QR matrix must be square");
    assert.equal((matrix.length - 17) % 4, 0, "QR matrix size must match ISO 18004 17 + 4*version");

    // Finder patterns at top-left, top-right, bottom-left corners
    const size = matrix.length;
    for (const [top, left] of [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ]) {
      assert.equal(matrix[top][left], true);
      assert.equal(matrix[top + 3][left + 3], true);
      assert.equal(matrix[top + 1][left + 1], false);
    }

    assert.equal(decodeQrMatrix(matrix), url);

    const terminalQr = renderTerminalQr(url, { margin: 2 });
    assert.match(terminalQr, /[█▀▄]/, "terminal QR must use Unicode half-block characters");
    const parsedMatrix = parseTerminalQrMatrix(terminalQr);
    assert.deepEqual(parsedMatrix, matrix, "parsed terminal QR matrix must equal encoded QR matrix");
    assert.equal(decodeTerminalQr(terminalQr), url, "terminal QR must decode back to exact pairing URL");

    const savedBuffer = globalThis.Buffer;
    try {
      globalThis.Buffer = undefined;
      const svgDataUrl = renderSvgQrDataUrl(url, { margin: 2 });
      assert.match(svgDataUrl, /^data:image\/svg\+xml;charset=utf-8,/);
      assert.match(decodeURIComponent(svgDataUrl), /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="192" height="192"/);
    } finally {
      globalThis.Buffer = savedBuffer;
    }
  }
});

test("/remote interactive dropdown menu: toggle switch, transient QR submenu, Esc dismissal without transcript log, and ⚯ indicator", async (t) => {
  const remoteCmd = LOCAL_SLASH_COMMANDS.find((cmd) => cmd.name === "remote");
  assert.ok(remoteCmd, "/remote must be listed in LOCAL_SLASH_COMMANDS");
  assert.equal(remoteCmd.usage, "/remote", "/remote usage must not list subcommands");

  const webDir = await mkdtemp(path.join(os.tmpdir(), "rind-cli-remote-unit-"));
  await writeFile(path.join(webDir, "index.html"), "<!doctype html><title>Rind Remote</title>");
  const logs = [];
  const cliState = createCliState();
  cliState.runtime.status = "ready";
  cliState.session.info = {
    session_id: "",
    cwd: webDir,
    workspace_root: webDir,
    model: "gpt-test",
    reasoning_effort: "medium",
  };
  const sessionState = cliState.session;

  let currentMenuFrame = "";
  const renderCurrentFrame = () => {
    const session = cliState.input.session;
    currentMenuFrame = session?.mode === "remote" ? remoteMenuText(session.remoteState, 90) : "";
  };

  let remoteController;
  let commandController;
  const inputActions = createCliInputActions({
    state: cliState,
    request: async () => ({}),
    output: {
      terminalUi: {},
      redraw: () => renderCurrentFrame(),
      writeUserInput: (text) => logs.push(`USER:${text}`),
      writeError: (text) => logs.push(`ERR:${text}`),
    },
    getTurnController: () => null,
    getCommandController: () => commandController,
    getTaskMonitor: () => null,
    getLineInput: () => null,
    pausePrompt() {},
    resumePrompt() {},
    handleSigint() {},
  });

  remoteController = createCliRemoteController({
    runtimeClient: {
      request: async (method, params) => ({ method, params, session_id: "s-unit", workspace_root: webDir }),
    },
    sessionState,
    log: (msg) => logs.push(typeof msg === "function" ? msg() : String(msg)),
    redraw: () => renderCurrentFrame(),
    askRemoteMenu: async (menuState) => {
      const res = await inputActions.askRemoteMenu(menuState);
      renderCurrentFrame();
      return res;
    },
    cwd: webDir,
    rindHome: webDir,
    getInitInfo: () => ({ capabilities: [], methods: ["session/prompt"] }),
    webRoot: webDir,
  });
  t.after(async () => {
    await remoteController.stop();
    await removeRindHome(webDir);
  });

  commandController = createCommandController({
    request: async () => ({}),
    turn: {},
    input: {
      isTerminal: true,
      runRemote: () => remoteController.handleCommand(),
    },
    state: { slashCommands: LOCAL_SLASH_COMMANDS },
    output: {
      log: (msg) => logs.push(typeof msg === "function" ? msg() : String(msg)),
      notify: (msg) => logs.push(String(msg)),
    },
  });

  const flushAsyncKey = () => new Promise((resolve) => setTimeout(resolve, 25));

  // 1. Subcommands are rejected cleanly with Usage: /remote
  await commandController.handle("/remote status");
  assert.equal(logs.at(-1), "Usage: /remote");
  logs.length = 0;
  assert.equal(remoteController.state().running, false);
  assert.equal(Boolean(sessionState.info.remote_running), false);
  assert.equal(promptText(sessionState.info).includes("⚯"), false, "⚯ must not appear when remote is off");

  // 2. Opening /remote renders the transient dropdown menu with "Remote access  Off" and "Network scope"; Esc closes cleanly
  const openOffPromise = commandController.handle("/remote");
  await flushAsyncKey();
  assert.equal(cliState.input.session?.mode, "remote");
  assert.match(currentMenuFrame, /Remote access/);
  assert.match(currentMenuFrame, /Off/);
  assert.match(currentMenuFrame, /Network scope/);
  inputActions.handleTerminalInput("\x1b"); // Esc
  await openOffPromise;
  assert.equal(cliState.input.session, null);
  assert.equal(currentMenuFrame, "", "menu frame must clear on Esc");
  assert.equal(remoteController.state().running, false);
  assert.deepEqual(logs, [], "interactive /remote must not log anything to transcript");

  // 3. Pre-select "This computer" scope in the dropdown menu, then toggle Remote access On -> opens transient QR view!
  const toggleOnPromise = commandController.handle("/remote");
  await flushAsyncKey();
  inputActions.handleTerminalInput("\x1b[B"); // Down to "Network scope"
  inputActions.handleTerminalInput("\r"); // Open scope submenu
  await flushAsyncKey();
  assert.equal(cliState.input.session.remoteState.level(), "scope");
  assert.match(currentMenuFrame, /Remote access · Network scope/);
  inputActions.handleTerminalInput("\x1b[B"); // Select "This computer"
  inputActions.handleTerminalInput("\r"); // Apply scope
  await flushAsyncKey();
  assert.equal(cliState.input.session.remoteState.level(), "root");
  inputActions.handleTerminalInput("\x1b[A"); // Up to "Remote access" switch
  inputActions.handleTerminalInput(" "); // Space toggles Remote access ON and opens transient QR view
  await flushAsyncKey();

  assert.equal(remoteController.state().running, true);
  assert.equal(remoteController.state().scope, "loopback");
  assert.equal(sessionState.info.remote_running, true);
  assert.match(promptText(sessionState.info).split("\n")[1], /gpt-test · medium · .* · ⚯$/);

  // Verify the QR code is rendered inside the transient dropdown menu (NOT in transcript logs!)
  assert.equal(cliState.input.session.remoteState.level(), "qr");
  const expectedUrl = buildPairingUrl(remoteController.state());
  assert.equal(decodeTerminalQr(currentMenuFrame), expectedUrl, "transient QR submenu must contain valid QR code");
  assert.equal(currentMenuFrame.includes(remoteController.state().accessCode), true);
  assert.deepEqual(logs, [], "turning on remote in TTY must NOT print QR code to transcript history");

  // Live update while QR view is open: simulate a remote device connecting and verify the QR header updates live
  remoteController.handleRuntimeEvent({
    kind: "remote",
    state: { ...remoteController.state(), clients: 2 },
  });
  assert.match(currentMenuFrame, /2 connected devices/, "active QR submenu must update connected device count live");

  // 4. Pressing 'r' inside the transient QR view rotates the access code in-place
  const oldCode = remoteController.state().accessCode;
  inputActions.handleTerminalInput("r");
  await flushAsyncKey();
  assert.notEqual(remoteController.state().accessCode, oldCode);
  assert.equal(decodeTerminalQr(currentMenuFrame), buildPairingUrl(remoteController.state()));
  assert.match(currentMenuFrame, /Access code rotated/);

  // 5. Pressing Esc inside the QR view closes the QR display and /remote menu completely while keeping remote running
  inputActions.handleTerminalInput("\x1b"); // Esc
  await toggleOnPromise;
  assert.equal(cliState.input.session, null);
  assert.equal(currentMenuFrame, "", "QR code display must disappear when Esc is pressed");
  assert.equal(remoteController.state().running, true, "remote stays running after closing QR view with Esc");
  assert.equal(sessionState.info.remote_running, true);
  assert.deepEqual(logs, [], "closing QR view must leave zero clutter in transcript logs");

  // 6. Re-opening /remote when On shows "Remote access  On", "QR code & sign-in link", "Network scope", "Rotate access code"
  const manageOnPromise = commandController.handle("/remote");
  await flushAsyncKey();
  assert.equal(cliState.input.session.remoteState.level(), "root");
  assert.match(currentMenuFrame, /On · 0 connected devices/);
  assert.match(currentMenuFrame, /QR code & sign-in link/);

  // Navigate to "QR code & sign-in link", open it, press Left arrow to return to root menu
  inputActions.handleTerminalInput("\x1b[B"); // Down to "QR code & sign-in link"
  inputActions.handleTerminalInput("\r");
  await flushAsyncKey();
  assert.equal(cliState.input.session.remoteState.level(), "qr");
  assert.equal(decodeTerminalQr(currentMenuFrame), buildPairingUrl(remoteController.state()));
  inputActions.handleTerminalInput("\x1b[D"); // Left arrow returns to root
  await flushAsyncKey();
  assert.equal(cliState.input.session.remoteState.level(), "root");

  // Navigate up to "Remote access" switch and press Enter to toggle Off, then Esc to close
  inputActions.handleTerminalInput("\x1b[A"); // Up to "Remote access"
  inputActions.handleTerminalInput("\r"); // Toggle Off
  await flushAsyncKey();
  assert.equal(remoteController.state().running, false);
  assert.equal(sessionState.info.remote_running, false);
  assert.equal(promptText(sessionState.info).includes("⚯"), false, "⚯ must disappear when remote is turned off");
  inputActions.handleTerminalInput("\x1b"); // Esc to close menu
  await manageOnPromise;
  assert.deepEqual(logs, [], "entire interactive /remote lifecycle must leave zero transcript logs");
});

test("interactive /remote menu: scope switching, address submenu with Esc back, missing webRoot fallback, and port collision auto-fallback", async (t) => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "rind-cli-remote-menu-"));
  const missingWebDir = path.join(tempHome, "missing-web");
  const sessionState = {
    info: { session_id: "s-menu", cwd: tempHome, workspace_root: tempHome, model: "gpt-test", reasoning_effort: "medium" },
    reservedId: "s-menu",
    pendingName: "",
    pendingSkillSources: null,
  };

  let menuScript = async () => {};
  const controllerA = createCliRemoteController({
    runtimeClient: { request: async () => ({}) },
    sessionState,
    askRemoteMenu: async (menuState) => {
      await menuScript(menuState);
    },
    cwd: tempHome,
    rindHome: tempHome,
    getInitInfo: () => ({ capabilities: [], methods: ["session/prompt"] }),
    webRoot: missingWebDir,
  });

  const controllerB = createCliRemoteController({
    runtimeClient: { request: async () => ({}) },
    sessionState: { info: { cwd: tempHome, workspace_root: tempHome } },
    askRemoteMenu: async (menuState) => {
      // Switch scope to loopback and toggle on
      await menuState.handleKey({ name: "down" });
      await menuState.handleKey({ name: "enter" });
      await menuState.handleKey({ name: "down" });
      await menuState.handleKey({ name: "enter" });
      await menuState.handleKey({ name: "up" });
      await menuState.handleKey({ name: "enter" });
      await menuState.handleKey({ name: "escape" });
    },
    cwd: tempHome,
    rindHome: tempHome,
    getInitInfo: () => ({ capabilities: [], methods: ["session/prompt"] }),
    webRoot: missingWebDir,
  });

  t.after(async () => {
    await controllerA.stop();
    await controllerB.stop();
    await removeRindHome(tempHome);
  });

  // 1. Start controllerA via menu even when webRoot directory does not exist (allowMissingWebRoot: true)
  menuScript = async (menuState) => {
    // Select loopback scope then toggle on
    await menuState.handleKey({ name: "down" });
    await menuState.handleKey({ name: "enter" });
    await menuState.handleKey({ name: "down" });
    await menuState.handleKey({ name: "enter" });
    await menuState.handleKey({ name: "up" });
    await menuState.handleKey({ text: " " });
    assert.equal(menuState.level(), "qr");
    assert.equal(decodeTerminalQr(remoteMenuText(menuState)), buildPairingUrl(controllerA.state()));
    await menuState.handleKey({ name: "escape" });
  };
  const stateA = await controllerA.handleCommand();
  assert.equal(stateA.running, true);
  assert.equal(sessionState.info.remote_running, true);
  const rootRes = await fetch(`${stateA.addresses[0]}/`);
  assert.equal(rootRes.status, 200);
  assert.match(await rootRes.text(), /Rind Remote Access is active/);

  // 2. If port 8766 was bound by controllerA, starting controllerB falls back automatically to an open port
  const stateB = await controllerB.handleCommand();
  assert.equal(stateB.running, true);
  assert.notEqual(stateB.port, stateA.port);

  // 3. Switch scope to LAN via submenu, test Address submenu if multiple addresses exist, rotate code, then turn off
  const prevCode = controllerA.state().accessCode;
  menuScript = async (menuState) => {
    // Down to Network scope (index 2 when running: toggle=0, qr=1, scope=2)
    await menuState.handleKey({ name: "down" });
    await menuState.handleKey({ name: "down" });
    await menuState.handleKey({ name: "enter" });
    assert.equal(menuState.level(), "scope");
    // Up to Local network (index 0) and apply
    await menuState.handleKey({ name: "up" });
    await menuState.handleKey({ name: "enter" });
    assert.equal(controllerA.state().scope, "lan");

    if (controllerA.state().addresses.length > 1) {
      // Down to Address (index 3), open it, then press Esc to return to root
      await menuState.handleKey({ name: "down" });
      await menuState.handleKey({ name: "enter" });
      assert.equal(menuState.level(), "address");
      assert.match(remoteMenuText(menuState), /Remote access · Address/);
      await menuState.handleKey({ name: "escape" });
      assert.equal(menuState.level(), "root");
    }

    // Open QR view and press 'r' to rotate
    const items = menuState.items();
    while (menuState.items()[menuState.selectedIndex()]?.id !== "qr") {
      await menuState.handleKey({ name: "down" });
    }
    assert.ok(items.length >= 4);
    await menuState.handleKey({ name: "enter" });
    assert.equal(menuState.level(), "qr");
    await menuState.handleKey({ name: "r", text: "r" });
    assert.notEqual(controllerA.state().accessCode, prevCode);
    await menuState.handleKey({ name: "left" });
    assert.equal(menuState.level(), "root");

    // Navigate to toggle (index 0) and turn off
    while (menuState.selectedIndex() !== 0) {
      await menuState.handleKey({ name: "up" });
    }
    await menuState.handleKey({ name: "enter" });
    assert.equal(controllerA.state().running, false);
  };
  await controllerA.handleCommand();
  assert.equal(controllerA.state().running, false);
  assert.equal(sessionState.info.remote_running, false);
});

test("E2E CLI /remote: user runs /remote, scans terminal QR code, pairs over HTTP/WS, prompts session, and syncs live to CLI", { timeout: 30000 }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-cli-remote-e2e-"));
  const workspace = path.join(home, "workspace");
  const webDir = path.join(home, "web-dist");
  await mkdir(workspace, { recursive: true });
  await mkdir(webDir, { recursive: true });
  await writeFile(path.join(workspace, "HELLO.md"), "Workspace file for remote E2E test", "utf8");
  await writeFile(path.join(webDir, "index.html"), "<!doctype html><title>Rind Remote</title>", "utf8");

  // Local fake OpenAI-compatible provider so the real Python runtime and CLI run end-to-end
  const provider = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "remote-e2e-model" }] }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let userText = "unknown";
      try {
        const parsed = JSON.parse(body);
        const lastUser = [...(parsed.messages || [])].reverse().find((m) => m.role === "user");
        if (lastUser) {
          userText = typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);
        }
      } catch {
        // ignore
      }
      const reply = `Remote reply to: ${userText}`;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = {
        id: "chatcmpl-remote-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }],
      };
      const doneChunk = {
        id: "chatcmpl-remote-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = provider.address().port;

  await writeFile(
    path.join(home, "settings.json"),
    JSON.stringify({ provider: "custom-gw", model: "remote-e2e-model" }),
    "utf8",
  );
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: "test-key" } }), "utf8");
  await writeFile(
    path.join(home, "providers.json"),
    JSON.stringify({
      providers: {
        "custom-gw": {
          api: "openai-chat",
          baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        },
      },
    }),
    "utf8",
  );

  const cliChild = spawn(process.execPath, [cliBin, "--cwd", workspace], {
    cwd: workspace,
    env: {
      ...process.env,
      RIND_HOME: home,
      RIND_WEB_ROOT: webDir,
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutText = "";
  let stderrText = "";
  cliChild.stdout.setEncoding("utf8");
  cliChild.stderr.setEncoding("utf8");
  cliChild.stdout.on("data", (chunk) => {
    stdoutText += chunk;
  });
  cliChild.stderr.on("data", (chunk) => {
    stderrText += chunk;
  });

  t.after(async () => {
    try {
      cliChild.kill();
    } catch {
      // ignore
    }
    await new Promise((resolve) => provider.close(resolve));
    await removeRindHome(home);
  });

  async function waitForStdout(predicate, timeoutMs = 15000, description = "stdout condition") {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(stdoutText)) return stdoutText;
      if (cliChild.exitCode !== null) {
        throw new Error(`CLI exited early (${cliChild.exitCode}) while waiting for ${description}.\nSTDOUT:\n${stdoutText}\nSTDERR:\n${stderrText}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Timed out waiting for ${description}.\nSTDOUT:\n${stdoutText}\nSTDERR:\n${stderrText}`);
  }

  // Wait for CLI startup banner
  await waitForStdout((out) => out.includes("remote-e2e-model"), 15000, "startup banner");

  // 1. User runs `/remote` in CLI and selects "Turn on (This computer)" from the interactive menu
  cliChild.stdin.write("/remote\n");
  await waitForStdout((out) => out.includes("Remote access · Off ["), 15000, "/remote Off menu");
  cliChild.stdin.write("Turn on (This computer)\n");
  await waitForStdout((out) => out.includes("Access code:") && out.includes(" · ⚯"), 15000, "/remote QR output and ⚯ indicator");

  // 2. Scan/decode the terminal QR code directly from CLI stdout
  const qrDecodedUrl = decodeTerminalQr(stdoutText);
  const parsedUrl = new URL(qrDecodedUrl);
  const origin = parsedUrl.origin;
  const hashParams = new URLSearchParams(parsedUrl.hash.replace(/^#/, ""));
  const accessCode = hashParams.get("connect");
  assert.ok(accessCode && accessCode.length >= 32, "QR code must contain a valid access code in #connect=");
  assert.equal(stdoutText.includes(`Sign-in URL: ${qrDecodedUrl}`), true);
  assert.equal(stdoutText.includes(`Access code: ${accessCode}`), true);

  // 3. Verify HTTP web UI is served at the QR origin
  const webRes = await fetch(origin);
  assert.equal(webRes.status, 200);
  assert.match(webRes.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  const webHtml = await webRes.text();
  assert.match(webHtml, /<!doctype html>/i);

  // 4. Exchange access code for a one-time WebSocket ticket
  const ticketRes = await fetch(`${origin}/ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessCode}` },
  });
  assert.equal(ticketRes.status, 200);
  const { ticket } = await ticketRes.json();
  assert.ok(ticket, "ticket endpoint must return a one-time ticket");

  // 5. Connect via WebSocket using the ticket
  const ws = new RemoteWebSocket(`${origin.replace("http:", "ws:")}/ws?ticket=${ticket}`, { origin });
  t.after(() => ws.terminate());
  await once(ws, "open");

  let reqSeq = 0;
  const pending = new Map();
  const wsEvents = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString("utf8"));
    if (msg.kind === "event") {
      wsEvents.push(msg);
    } else if (msg.kind === "response") {
      pending.get(msg.request_id)?.(msg);
      pending.delete(msg.request_id);
    }
  });
  const wsRequest = (method, params = {}) =>
    new Promise((resolve) => {
      const id = `r-${++reqSeq}`;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ kind: "request", request_id: id, method, params }));
    });

  // 6. Initialize remote session and create + prompt a conversation from the remote client
  const initResp = await wsRequest("initialize", {});
  assert.equal(initResp.result.protocol_version, "2");
  assert.equal(initResp.result.gateway.desktop, true);

  const createdResp = await wsRequest("session/create", { workspace_root: workspace });
  const sessionId = createdResp.result.session_id;
  assert.ok(sessionId, "remote client must create a session in the CLI workspace");

  const promptResp = await wsRequest("session/prompt", {
    session_id: sessionId,
    input: "Hello from phone QR scan",
  });
  assert.equal(promptResp.error, undefined);

  // Verify remote client received turn_started, assistant_delta, and turn_completed
  assert.equal(
    wsEvents.some((e) => e.session_id === sessionId && e.event?.type === "turn_started"),
    true,
    "remote client must receive turn_started",
  );
  assert.equal(
    wsEvents.some(
      (e) =>
        e.session_id === sessionId &&
        e.event?.type === "assistant_delta" &&
        String(e.event?.text || "").includes("Remote reply to: Hello from phone QR scan"),
    ),
    true,
    "remote client must receive streamed assistant_delta",
  );
  assert.equal(
    wsEvents.some((e) => e.session_id === sessionId && e.event?.type === "turn_completed"),
    true,
    "remote client must receive turn_completed",
  );

  // Verify the CLI terminal stdout ALSO rendered the remote user input and assistant response!
  await waitForStdout(
    (out) =>
      out.includes("Hello from phone QR scan") && out.includes("Remote reply to: Hello from phone QR scan"),
    10000,
    "remote prompt and assistant response in CLI stdout",
  );

  // 7. Test remote file listing, reading, and uploading in the session workspace
  const fileListResp = await wsRequest("file/list", { session_id: sessionId, path: "" });
  assert.equal(
    fileListResp.result.entries.some((e) => e.name === "HELLO.md"),
    true,
  );
  const fileReadResp = await wsRequest("file/read", { session_id: sessionId, path: "HELLO.md" });
  assert.equal(
    Buffer.from(fileReadResp.result.content_base64, "base64").toString("utf8"),
    "Workspace file for remote E2E test",
  );
  const uploadContent = Buffer.from("Uploaded from mobile client").toString("base64");
  const fileWriteResp = await wsRequest("file/write", {
    session_id: sessionId,
    path: "uploads/mobile-note.txt",
    content_base64: uploadContent,
  });
  assert.equal(fileWriteResp.result.path, "uploads/mobile-note.txt");

  // 8. Rotate access code from CLI (`/remote` -> "Rotate access code") and verify old WS closes with 4401
  const beforeRotateLen = stdoutText.length;
  const wsClosed = once(ws, "close");
  cliChild.stdin.write("/remote\n");
  await waitForStdout((out) => out.slice(beforeRotateLen).includes("Remote access · On ["), 10000, "/remote On menu for rotate");
  cliChild.stdin.write("Rotate access code\n");
  const [closeCode] = await wsClosed;
  assert.equal(closeCode, 4401, "rotating access code must disconnect existing WebSocket with 4401");

  await waitForStdout(
    (out) => out.slice(beforeRotateLen).includes("Access code rotated.") && out.slice(beforeRotateLen).includes("Access code:"),
    10000,
    "rotated QR output",
  );
  const rotatedQrUrl = decodeTerminalQr(stdoutText.slice(beforeRotateLen));
  const rotatedCode = new URLSearchParams(new URL(rotatedQrUrl).hash.replace(/^#/, "")).get("connect");
  assert.notEqual(rotatedCode, accessCode);

  const oldTicketAttempt = await fetch(`${origin}/ticket`, {
    headers: { Authorization: `Bearer ${accessCode}` },
  });
  assert.equal(oldTicketAttempt.status, 401);

  const newTicketAttempt = await fetch(`${origin}/ticket`, {
    headers: { Authorization: `Bearer ${rotatedCode}` },
  });
  assert.equal(newTicketAttempt.status, 200);

  // 9. Turn off remote access (`/remote` -> "Turn off") and verify ⚯ is removed from prompt header
  const beforeOffLen = stdoutText.length;
  cliChild.stdin.write("/remote\n");
  await waitForStdout((out) => out.slice(beforeOffLen).includes("Remote access · On ["), 10000, "/remote On menu for stop");
  cliChild.stdin.write("Turn off\n");
  await waitForStdout(
    (out) => out.slice(beforeOffLen).includes("Remote access turned off.") && out.slice(beforeOffLen).includes("  ▷ "),
    10000,
    "/remote off confirmation and next prompt",
  );
  const afterOffPrompt = stdoutText.slice(stdoutText.lastIndexOf("Remote access turned off."));
  assert.equal(afterOffPrompt.includes("⚯"), false, "prompt after turning off remote must not show ⚯");

  cliChild.stdin.write("/exit\n");
  await once(cliChild, "exit");
  await removeRindHome(home);
});

test("E2E multi-surface unification: CLI and Desktop share Remote gateway, Workspaces, Teams, and auto-reclaim on last window exit", { timeout: 30000 }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-multi-surface-e2e-"));
  const desktopWorkspace = path.join(home, "desktop-project");
  const cliWorkspace = path.join(home, "cli-project");
  const teamMemberWorkspace = path.join(home, "team-member");
  await mkdir(desktopWorkspace, { recursive: true });
  await mkdir(cliWorkspace, { recursive: true });
  await mkdir(teamMemberWorkspace, { recursive: true });

  await writeFile(
    path.join(home, "settings.json"),
    JSON.stringify({ provider: "openai", model: "gpt-4o" }),
    "utf8",
  );

  // 1. Simulate Desktop registering a project workspace and creating a Team in RIND_HOME
  await registerSharedWorkspace(home, desktopWorkspace, { setActive: true });
  const mgmt = await connectManagement({ home, repoRoot, start: true });
  await mgmt.request("createTeam", { name: "Unified Alpha Team", description: "Shared across CLI and Desktop" });
  mgmt.close();

  // 2. Start CLI in cliWorkspace
  const cliChild = spawn(process.execPath, [cliBin, "--cwd", cliWorkspace], {
    cwd: cliWorkspace,
    env: {
      ...process.env,
      RIND_HOME: home,
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutText = "";
  let stderrText = "";
  cliChild.stdout.setEncoding("utf8");
  cliChild.stderr.setEncoding("utf8");
  cliChild.stdout.on("data", (chunk) => {
    stdoutText += chunk;
  });
  cliChild.stderr.on("data", (chunk) => {
    stderrText += chunk;
  });

  const desktopRemoteEvents = [];
  let desktopPeer = null;

  t.after(async () => {
    try {
      desktopPeer?.close();
    } catch {
      // ignore
    }
    try {
      cliChild.kill();
    } catch {
      // ignore
    }
    await removeRindHome(home);
  });

  async function waitForStdout(predicate, timeoutMs = 15000, description = "stdout condition") {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(stdoutText)) return stdoutText;
      if (cliChild.exitCode !== null) {
        throw new Error(`CLI exited early (${cliChild.exitCode}) while waiting for ${description}.\nSTDOUT:\n${stdoutText}\nSTDERR:\n${stderrText}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Timed out waiting for ${description}.\nSTDOUT:\n${stdoutText}\nSTDERR:\n${stderrText}`);
  }

  await waitForStdout((out) => out.includes("gpt-4o"), 15000, "CLI startup banner");

  // 3. Connect Desktop peer to the same shared runtime (initialize + runtime/observe, matching desktop/src/main/runtime.ts)
  desktopPeer = await connectSharedRuntime({
    rindHome: home,
    repoRoot,
    onMessage: (event) => {
      if (event?.kind === "remote" && event.state) {
        desktopRemoteEvents.push(event.state);
      }
    },
  });
  await desktopPeer.request("initialize");
  await desktopPeer.request("runtime/observe");

  const initialDesktopRemote = await desktopPeer.request("remote/get");
  assert.equal(initialDesktopRemote.running, false);

  // 4. Enable /remote in CLI via interactive menu -> verify Desktop immediately receives the running state and matches QR/code/port
  cliChild.stdin.write("/remote\n");
  await waitForStdout((out) => out.includes("Remote access · Off ["), 15000, "CLI /remote Off menu");
  cliChild.stdin.write("Turn on (This computer)\n");
  await waitForStdout((out) => out.includes("Access code:") && out.includes(" · ⚯"), 15000, "CLI /remote QR output and ⚯ indicator");

  const cliQrUrl = decodeTerminalQr(stdoutText);
  const parsedUrl = new URL(cliQrUrl);
  const origin = parsedUrl.origin;
  const cliAccessCode = new URLSearchParams(parsedUrl.hash.replace(/^#/, "")).get("connect");

  const syncedDesktopRemote = await desktopPeer.request("remote/get");
  assert.equal(syncedDesktopRemote.running, true, "Desktop must see Remote running when enabled from CLI");
  assert.equal(syncedDesktopRemote.accessCode, cliAccessCode, "Desktop and CLI must share the exact same accessCode");
  assert.equal(syncedDesktopRemote.port, Number(parsedUrl.port), "Desktop and CLI must share the exact same port");
  assert.equal(
    desktopRemoteEvents.some((s) => s.running && s.accessCode === cliAccessCode),
    true,
    "Desktop must receive real-time remote state broadcast when CLI starts /remote",
  );

  // 5. Connect remote WebSocket client and verify unified Workspaces AND existing Teams are loaded!
  const ticketRes = await fetch(`${origin}/ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cliAccessCode}` },
  });
  const { ticket } = await ticketRes.json();
  const ws = new RemoteWebSocket(`${origin.replace("http:", "ws:")}/ws?ticket=${ticket}`, { origin });
  t.after(() => ws.terminate());
  await once(ws, "open");

  let reqSeq = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString("utf8"));
    if (msg.kind === "response") {
      pending.get(msg.request_id)?.(msg);
      pending.delete(msg.request_id);
    }
  });
  const wsRequest = (method, params = {}) =>
    new Promise((resolve) => {
      const id = `r-${++reqSeq}`;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ kind: "request", request_id: id, method, params }));
    });

  const initResp = await wsRequest("initialize", {});
  const remoteWorkspaces = initResp.result.workspaces || [];
  assert.equal(
    remoteWorkspaces.some((w) => samePath(w, desktopWorkspace)),
    true,
    "Remote workspaces must include Desktop registered project",
  );
  assert.equal(
    remoteWorkspaces.some((w) => samePath(w, cliWorkspace)),
    true,
    "Remote workspaces must include CLI active workspace",
  );
  assert.equal(
    initResp.result.methods.includes("workspace/dirs"),
    true,
    "initialize must advertise workspace/dirs for remote folder browsing",
  );

  // Browse host directories via workspace/dirs and open an unregistered folder dynamically
  const unregisteredWorkspace = path.join(home, "ws-unregistered");
  await mkdir(unregisteredWorkspace, { recursive: true });
  const browseResp = await wsRequest("workspace/dirs", { path: home });
  assert.ok(browseResp.result, "workspace/dirs must return directory listing");
  assert.equal(
    browseResp.result.directories.some((d) => d.name === "ws-unregistered"),
    true,
    "workspace/dirs must list ws-unregistered subfolder",
  );
  assert.equal(
    browseResp.result.directories.some((d) => d.name === "runtime" || d.name === "sessions"),
    false,
    "workspace/dirs must hide internal Rind runtime/sessions directories",
  );

  const openUnregisteredResp = await wsRequest("session/list", {
    limit: 20,
    workspace_root: unregisteredWorkspace,
  });
  assert.ok(openUnregisteredResp.result, "session/list must succeed for a valid unregistered host directory");
  assert.equal(
    samePath(openUnregisteredResp.result.workspace_root, unregisteredWorkspace),
    true,
    "session/list must return canonical workspace_root of newly opened folder",
  );
  assert.equal(
    (openUnregisteredResp.result.workspaces || []).some((w) => samePath(w, unregisteredWorkspace)),
    true,
    "Newly opened folder must be automatically added to shared workspaces list",
  );

  // Verify existing Team ("Unified Alpha Team") is loaded when connected to CLI-started Remote!
  const agentsState = initResp.result.agents_state;
  assert.ok(agentsState, "initialize must include agents_state");
  assert.equal(agentsState.connection, "connected");
  assert.equal(
    agentsState.snapshot.teams.some((team) => team.name === "Unified Alpha Team"),
    true,
    "CLI /remote must load existing Teams from agents-management",
  );

  // Also verify Desktop received clients: 1 update when WS connected
  const withClientDesktopState = await desktopPeer.request("remote/get");
  assert.equal(withClientDesktopState.clients, 1);

  ws.terminate();

  // 6. Lifecycle test: exit CLI while Desktop is still open -> Remote MUST stay running!
  cliChild.stdin.write("/exit\n");
  await once(cliChild, "exit");

  const afterCliExitState = await desktopPeer.request("remote/get");
  assert.equal(
    afterCliExitState.running,
    true,
    "Remote must remain running when CLI exits while Desktop window is still open",
  );
  const stillAliveRes = await fetch(origin);
  assert.equal(stillAliveRes.status, 200);

  // 7. Now close Desktop (the last local frontend window) -> Remote MUST automatically stop!
  desktopPeer.close();
  desktopPeer = null;

  const deadline = Date.now() + 5000;
  let remoteStopped = false;
  while (Date.now() < deadline) {
    const checkPeer = await connectSharedRuntime({ rindHome: home, start: false }).catch(() => null);
    if (!checkPeer) {
      remoteStopped = true;
      break;
    }
    const st = await checkPeer.request("remote/get").catch(() => ({ running: false }));
    checkPeer.close();
    if (!st.running) {
      remoteStopped = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(remoteStopped, true, "Remote must automatically stop when the last local frontend window exits");

  await removeRindHome(home);
});
