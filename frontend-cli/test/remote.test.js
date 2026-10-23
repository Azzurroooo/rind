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
import { createCliRemoteController, createRemoteMenuState } from "../lib/remote.js";
import { promptText, remoteMenuText } from "../lib/rendering.js";
import { createCliInputActions } from "../lib/cli-input-actions.js";
import { createCliState } from "../lib/cli-state.js";
import { createVirtualOutput } from "./helpers/virtual-terminal.js";
import { removeRindHome } from "./helpers/rind-home.js";
import { connectSharedRuntime } from "../../rind-runtime-client/shared-runtime.js";
import {
  decodeQrMatrix,
  decodeTerminalQr,
  encodeQrMatrix,
  parseTerminalQrMatrix,
  renderSvgQrDataUrl,
  renderTerminalQr,
} from "../../rind-runtime-client/remote/qr.js";
import { RemoteWebSocket } from "../../rind-runtime-client/remote/server.js";
import { canonicalDirectory, registerSharedWorkspace, samePath } from "../../rind-runtime-client/remote/workspaces.js";
import { connectManagement } from "../../agent-management/dist/client.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliImplHref = new URL("../lib/frontend-cli-implementation.js", import.meta.url).href;
const QR_BLOCKS = /[█▀▄]/;
const LOOPBACK_LINK = /http:\/\/127\.0\.0\.1:\d+\/#connect=\S+/;

function spawnTtyCli({ home, workspace, args = [], webRoot = "" }) {
  const script = `
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    process.stdin.setRawMode = value => { process.stdin.isRaw = value; };
    process.stdout.columns = 100;
    process.stdout.rows = 38;
    const { runFrontendCliApp } = await import(${JSON.stringify(cliImplHref)});
    await runFrontendCliApp(${JSON.stringify(["--cwd", workspace, ...args])});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: workspace,
    env: {
      ...process.env,
      RIND_HOME: home,
      RIND_PYTHON: process.env.RIND_PYTHON || "python",
      ...(webRoot ? { RIND_WEB_ROOT: webRoot } : {}),
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const virtual = createVirtualOutput({ columns: 100, rows: 38 });
  child.stdout.on("data", (chunk) => virtual.output.write(chunk));
  let stderrText = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrText += chunk;
  });
  const screen = async () => (await virtual.flushAndGetViewport()).join("\n");
  const waitForScreen = async (predicate, timeoutMs = 15000, description = "screen condition") => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await screen();
      if (predicate(current)) return current;
      if (child.exitCode !== null) {
        throw new Error(
          `CLI exited early (${child.exitCode}) while waiting for ${description}.\nSCREEN:\n${current}\nSTDERR:\n${stderrText}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    throw new Error(
      `Timed out waiting for ${description}.\nSCREEN:\n${await screen()}\nSTDERR:\n${stderrText}`,
    );
  };
  return {
    child,
    virtual,
    screen,
    waitForScreen,
    sendKey: (value) => child.stdin.write(value),
  };
}

function fakeRemoteMenu(addresses, scope = "lan") {
  let accessCode = "abCD1234_-efGH567890ijklMNOPqrst";
  let running = true;
  const picked = [];
  const snapshot = () => ({
    running,
    scope,
    port: 8766,
    addresses: running ? addresses : [],
    accessCode: running ? accessCode : "",
    clients: 0,
  });
  const menu = createRemoteMenuState({
    initialState: snapshot(),
    onStart: async (next) => {
      running = true;
      scope = next;
      return snapshot();
    },
    onStop: async () => {
      running = false;
      return snapshot();
    },
    onRotate: async () => {
      accessCode = "rotated-0987654321-zyxwVUTSrqpo";
      return snapshot();
    },
    onAddressChange: (address) => picked.push(address),
  });
  return { menu, picked };
}

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
    assert.match(terminalQr, QR_BLOCKS, "terminal QR must use Unicode half-block characters");
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

test("/remote On view fits the QR code to the terminal and never wraps or clips it", () => {
  const { menu } = fakeRemoteMenu(["http://192.168.1.44:8766", "http://127.0.0.1:8766"]);
  const link = menu.connection().link;
  assert.equal(link, "http://192.168.1.44:8766/#connect=abCD1234_-efGH567890ijklMNOPqrst");

  const roomy = remoteMenuText(menu, 96, 40);
  assert.equal(decodeTerminalQr(roomy), link, "QR code must encode the reachable LAN link");
  assert.match(roomy, /Remote access · On · Local network · 0 devices/);
  assert.match(roomy, /Scan with your phone, or open:/);
  assert.equal(roomy.includes(`Code  abCD1234_-efGH567890ijklMNOPqrst`), true);
  assert.doesNotMatch(roomy, /←→ address/, "a single reachable address needs no address switcher");

  const narrow = remoteMenuText(menu, 42, 40);
  for (const line of narrow.trimEnd().split("\n").filter((line) => QR_BLOCKS.test(line))) {
    assert.ok(line.length <= 42, `QR row exceeds 42 columns: ${line}`);
  }
  assert.equal(decodeTerminalQr(narrow), link, "QR code at 42 columns must still decode accurately");
  assert.equal(narrow.includes(link), true, "the link wraps rather than being clipped");

  const exact = remoteMenuText(menu, 96, 24);
  assert.equal(exact.trimEnd().split("\n").length, 24, "QR code and text exactly fill 24 rows");
  assert.equal(decodeTerminalQr(exact), link, "QR code must still decode within 24 rows");

  for (const [columns, rows] of [[32, 40], [96, 23]]) {
    const cramped = remoteMenuText(menu, columns, rows);
    assert.doesNotMatch(cramped, QR_BLOCKS, `${columns}x${rows} omits the QR code instead of corrupting it`);
    assert.match(cramped, /Enlarge the terminal to show the QR code, or open:/);
    assert.equal(cramped.includes(link), true);
  }
});

test("/remote On view cycles reachable addresses, skips loopback, and links loopback-only access without a QR code", async () => {
  const { menu, picked } = fakeRemoteMenu([
    "http://192.168.1.44:8766",
    "http://10.0.0.7:8766",
    "http://127.0.0.1:8766",
  ]);
  assert.match(remoteMenuText(menu, 96, 40), /←→ address 1\/2 · r new code · x turn off · esc close/);
  await menu.handleKey({ name: "right" });
  assert.equal(menu.connection().link.startsWith("http://10.0.0.7:8766/"), true);
  assert.equal(decodeTerminalQr(remoteMenuText(menu, 96, 40)), menu.connection().link);
  await menu.handleKey({ name: "right" });
  assert.equal(menu.connection().link.startsWith("http://192.168.1.44:8766/"), true, "loopback is never offered for pairing");
  await menu.handleKey({ name: "left" });
  assert.deepEqual(picked, ["http://10.0.0.7:8766", "http://192.168.1.44:8766", "http://10.0.0.7:8766"]);

  const { menu: loopback } = fakeRemoteMenu(["http://127.0.0.1:8766"], "loopback");
  const text = remoteMenuText(loopback, 96, 40);
  assert.doesNotMatch(text, QR_BLOCKS, "a phone cannot reach 127.0.0.1, so no QR code is drawn");
  assert.match(text, /Remote access · On · This computer · 0 devices/);
  assert.match(text, /Open in a browser on this computer:/);
  assert.match(text, LOOPBACK_LINK);
  assert.match(text, /    r new code · x turn off · esc close/);
  assert.equal(await loopback.handleKey({ name: "right" }), null);
});

test("/remote two-view menu: Off picks the scope to turn on with, On connects, x returns to Off, and nothing reaches the transcript", async (t) => {
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

  let frame = "";
  const renderCurrentFrame = () => {
    const session = cliState.input.session;
    frame = session?.mode === "remote" ? remoteMenuText(session.remoteState, 90, 40) : "";
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

  const flush = () => new Promise((resolve) => setTimeout(resolve, 25));
  const menu = () => cliState.input.session.remoteState;

  // 1. Subcommands are rejected, and a non-TTY explains the requirement
  await commandController.handle("/remote status");
  assert.equal(logs.at(-1), "Usage: /remote");
  logs.length = 0;
  const nonTtyController = createCommandController({
    request: async () => ({}),
    turn: {},
    input: { isTerminal: false, runRemote: () => remoteController.handleCommand() },
    state: { slashCommands: LOCAL_SLASH_COMMANDS },
    output: {
      log: (msg) => logs.push(typeof msg === "function" ? msg() : String(msg)),
      notify: (msg) => logs.push(String(msg)),
    },
  });
  await nonTtyController.handle("/remote");
  assert.equal(logs.at(-1), "/remote requires an interactive terminal.");
  logs.length = 0;
  assert.equal(promptText(sessionState.info).includes("⚯"), false, "⚯ must not appear when remote is off");

  // 2. Off view offers the two scopes; Esc closes without side effects
  const browse = commandController.handle("/remote");
  await flush();
  assert.match(frame, /Remote access · Off/);
  assert.match(frame, /› Local network\s+Phones and computers on the same Wi-Fi/);
  assert.match(frame, /· This computer\s+A browser on this machine only/);
  assert.match(frame, /↑↓ choose · enter turn on · esc close/);
  inputActions.handleTerminalInput("\x1b");
  await browse;
  assert.equal(cliState.input.session, null);
  assert.equal(frame, "");
  assert.equal(remoteController.state().running, false);

  // 3. Choosing "This computer" turns remote on and switches to the On view in place
  const session = commandController.handle("/remote");
  await flush();
  inputActions.handleTerminalInput("\x1b[B");
  inputActions.handleTerminalInput("\r");
  await flush();
  assert.equal(remoteController.state().running, true);
  assert.equal(remoteController.state().scope, "loopback");
  assert.match(promptText(sessionState.info).split("\n")[1], /gpt-test · medium · .* · ⚯$/);
  assert.match(frame, /Remote access · On · This computer · 0 devices/);
  assert.match(frame, /Open in a browser on this computer:/);
  assert.doesNotMatch(frame, QR_BLOCKS, "loopback access draws no QR code");
  const loopbackLink = frame.match(LOOPBACK_LINK)[0];
  assert.equal(loopbackLink, menu().connection().link);
  assert.equal(loopbackLink.endsWith(encodeURIComponent(remoteController.state().accessCode)), true);

  // Live device count while the view is open
  remoteController.handleRuntimeEvent({ kind: "remote", state: { ...remoteController.state(), clients: 2 } });
  assert.match(frame, /This computer · 2 devices/);

  // 4. r issues a new code in place
  const oldCode = remoteController.state().accessCode;
  inputActions.handleTerminalInput("r");
  await flush();
  assert.notEqual(remoteController.state().accessCode, oldCode);
  assert.match(frame, /New access code\. Previous devices were disconnected\./);
  assert.equal(frame.includes(menu().connection().link), true);

  // 5. x turns remote off and returns to the Off view with the last scope selected
  inputActions.handleTerminalInput("x");
  await flush();
  assert.equal(remoteController.state().running, false);
  assert.equal(promptText(sessionState.info).includes("⚯"), false, "⚯ must disappear when remote is turned off");
  assert.match(frame, /Remote access · Off/);
  assert.match(frame, /› This computer/);
  assert.doesNotMatch(frame, /New access code/);

  // 6. Changing scope is simply choosing the other one
  inputActions.handleTerminalInput("\x1b[A");
  inputActions.handleTerminalInput(" ");
  await flush();
  assert.equal(remoteController.state().scope, "lan");
  assert.match(frame, /Remote access · On · Local network/);
  const lan = menu().connection();
  if (lan.reachable) {
    assert.equal(decodeTerminalQr(frame), lan.link);
  } else {
    assert.match(frame, /Open in a browser on this computer:/);
  }

  // 7. Esc closes the view; remote keeps running and reopening goes straight to the On view
  inputActions.handleTerminalInput("\x1b");
  await session;
  assert.equal(frame, "");
  assert.equal(remoteController.state().running, true);
  const reopen = commandController.handle("/remote");
  await flush();
  assert.match(frame, /Remote access · On · Local network/);
  inputActions.handleTerminalInput("\x1b");
  await reopen;
  assert.deepEqual(logs, [], "the interactive /remote lifecycle must leave nothing in the transcript");
});

test("/remote controller: missing webRoot still serves, a busy port falls back, and x stops sharing", async (t) => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "rind-cli-remote-menu-"));
  const missingWebDir = path.join(tempHome, "missing-web");
  const sessionState = {
    info: { session_id: "s-menu", cwd: tempHome, workspace_root: tempHome, model: "gpt-test", reasoning_effort: "medium" },
    reservedId: "s-menu",
    pendingName: "",
    pendingSkillSources: null,
  };
  const turnOnThisComputer = async (menuState) => {
    await menuState.handleKey({ name: "down" });
    await menuState.handleKey({ name: "enter" });
    await menuState.handleKey({ name: "escape" });
  };

  let menuScript = turnOnThisComputer;
  const controllerA = createCliRemoteController({
    runtimeClient: { request: async () => ({}) },
    sessionState,
    askRemoteMenu: (menuState) => menuScript(menuState),
    cwd: tempHome,
    rindHome: tempHome,
    getInitInfo: () => ({ capabilities: [], methods: ["session/prompt"] }),
    webRoot: missingWebDir,
  });
  const controllerB = createCliRemoteController({
    runtimeClient: { request: async () => ({}) },
    sessionState: { info: { cwd: tempHome, workspace_root: tempHome } },
    askRemoteMenu: turnOnThisComputer,
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

  const stateA = await controllerA.handleCommand();
  assert.equal(stateA.running, true);
  assert.equal(stateA.scope, "loopback");
  assert.equal(sessionState.info.remote_running, true);
  const rootRes = await fetch(`${stateA.addresses[0]}/`);
  assert.equal(rootRes.status, 200);
  assert.match(await rootRes.text(), /Rind Remote Access is active/);

  const stateB = await controllerB.handleCommand();
  assert.equal(stateB.running, true);
  assert.notEqual(stateB.port, stateA.port);

  menuScript = async (menuState) => {
    assert.ok(menuState.connection(), "reopening while on shows the On view directly");
    await menuState.handleKey({ name: "x", text: "x" });
    assert.equal(menuState.connection(), null);
    await menuState.handleKey({ name: "escape" });
  };
  const stopped = await controllerA.handleCommand();
  assert.equal(stopped.running, false);
  assert.equal(sessionState.info.remote_running, false);
});

test("E2E CLI /remote: user turns remote on from the Off view, signs in over HTTP/WS with the shown link, prompts a session, gets a new code, and turns it off", { timeout: 30000 }, async (t) => {
  const home = await canonicalDirectory(await mkdtemp(path.join(os.tmpdir(), "rind-cli-remote-e2e-")));
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

  const tty = spawnTtyCli({ home, workspace, webRoot: webDir });
  const { child: cliChild, waitForScreen, sendKey } = tty;

  t.after(async () => {
    try {
      cliChild.kill();
    } catch {
      // ignore
    }
    await new Promise((resolve) => provider.close(resolve));
    await removeRindHome(home);
  });

  // Wait for CLI startup banner
  await waitForScreen((s) => s.includes("remote-e2e-model"), 15000, "startup banner");

  // 1. User runs `/remote`, picks "This computer" in the Off view, and the On view appears in place
  sendKey("/remote\r");
  await waitForScreen((s) => s.includes("Remote access · Off") && s.includes("› Local network"), 15000, "/remote Off view");
  sendKey("\x1b[B\r"); // Down to This computer, Enter turns remote on
  const onScreen = await waitForScreen(
    (s) => s.includes("Remote access · On · This computer") && s.includes(" · ⚯"),
    15000,
    "/remote On view",
  );

  // 2. Loopback access shows a complete sign-in link and code, and no QR code a phone could not use
  assert.doesNotMatch(onScreen, QR_BLOCKS);
  assert.equal(onScreen.includes("Open in a browser on this computer:"), true);
  const signInUrl = new URL(onScreen.match(LOOPBACK_LINK)[0]);
  const origin = signInUrl.origin;
  const accessCode = new URLSearchParams(signInUrl.hash.replace(/^#/, "")).get("connect");
  assert.ok(accessCode && accessCode.length >= 32, "sign-in link must contain a valid access code in #connect=");
  assert.equal(onScreen.includes(`Code  ${accessCode}`), true);

  // Esc closes /remote; remote keeps running
  sendKey("\x1b");
  await waitForScreen((s) => !s.includes("Remote access · On"), 10000, "Esc closes /remote");

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

  // Verify the CLI terminal screen ALSO rendered the remote user input and assistant response!
  await waitForScreen(
    (s) =>
      s.includes("Hello from phone QR scan") && s.includes("Remote reply to: Hello from phone QR scan"),
    10000,
    "remote prompt and assistant response in CLI screen",
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

  // 8. Reopening `/remote` goes straight to the On view; r issues a new code and the old WS closes with 4401
  const wsClosed = once(ws, "close");
  sendKey("/remote\r");
  await waitForScreen((s) => s.includes("Remote access · On · This computer"), 10000, "/remote On view on reopen");
  sendKey("r");
  const [closeCode] = await wsClosed;
  assert.equal(closeCode, 4401, "a new access code must disconnect existing WebSocket with 4401");

  const rotatedScreen = await waitForScreen(
    (s) => s.includes("New access code. Previous devices were disconnected.") && !s.includes(accessCode),
    10000,
    "new access code",
  );
  const rotatedCode = new URLSearchParams(new URL(rotatedScreen.match(LOOPBACK_LINK)[0]).hash.replace(/^#/, "")).get("connect");
  assert.notEqual(rotatedCode, accessCode);
  assert.equal(rotatedScreen.includes(`Code  ${rotatedCode}`), true);

  const oldTicketAttempt = await fetch(`${origin}/ticket`, {
    headers: { Authorization: `Bearer ${accessCode}` },
  });
  assert.equal(oldTicketAttempt.status, 401);

  const newTicketAttempt = await fetch(`${origin}/ticket`, {
    headers: { Authorization: `Bearer ${rotatedCode}` },
  });
  assert.equal(newTicketAttempt.status, 200);

  // 9. x turns remote off in place (⚯ disappears), then Esc closes the Off view
  sendKey("x");
  await waitForScreen((s) => s.includes("Remote access · Off") && !s.includes(" · ⚯"), 10000, "Remote access turned off");
  sendKey("\x1b");
  await waitForScreen((s) => !s.includes("Remote access · Off"), 10000, "/remote closed");

  sendKey("/exit\r");
  await once(cliChild, "exit");
  await removeRindHome(home);
});

test("E2E multi-surface unification: CLI and Desktop share Remote gateway, Workspaces, Teams, and auto-reclaim on last window exit", { timeout: 30000 }, async (t) => {
  const home = await canonicalDirectory(await mkdtemp(path.join(os.tmpdir(), "rind-multi-surface-e2e-")));
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
  const tty = spawnTtyCli({ home, workspace: cliWorkspace });
  const { child: cliChild, waitForScreen, sendKey } = tty;

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

  await waitForScreen((s) => s.includes("gpt-4o"), 15000, "CLI startup banner");

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

  // 4. Turn remote on from the CLI's /remote Off view -> Desktop immediately sees the same running gateway
  sendKey("/remote\r");
  await waitForScreen((s) => s.includes("Remote access · Off"), 15000, "CLI /remote Off view");
  sendKey("\x1b[B\r"); // This computer, Enter turns remote on
  const onScreen = await waitForScreen(
    (s) => s.includes("Remote access · On · This computer") && s.includes(" · ⚯"),
    15000,
    "CLI /remote On view",
  );
  const parsedUrl = new URL(onScreen.match(LOOPBACK_LINK)[0]);
  const origin = parsedUrl.origin;
  const cliAccessCode = new URLSearchParams(parsedUrl.hash.replace(/^#/, "")).get("connect");

  sendKey("\x1b");
  await waitForScreen((s) => !s.includes("Remote access · On"), 10000, "Esc closes /remote");

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
  sendKey("/exit\r");
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

