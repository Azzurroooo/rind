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
  decodeQrMatrix,
  decodeTerminalQr,
  encodeQrMatrix,
  formatRemoteOutput,
  parseRemoteArgs,
  parseTerminalQrMatrix,
  RemoteWebSocket,
  renderSvgQrDataUrl,
  renderTerminalQr,
} from "../lib/remote.js";
import { removeRindHome } from "./helpers/rind-home.js";

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

test("parseRemoteArgs parses /remote subcommands, scopes, ports, and origins", () => {
  assert.deepEqual(parseRemoteArgs([]), {
    action: "auto",
    scope: undefined,
    port: undefined,
    externalOrigin: undefined,
  });
  assert.deepEqual(parseRemoteArgs(["on", "loopback", "--port", "9123"]), {
    action: "start",
    scope: "loopback",
    port: 9123,
    externalOrigin: undefined,
  });
  assert.deepEqual(parseRemoteArgs(["lan", "--port=8899", "--origin=https://my.host.example"]), {
    action: "start",
    scope: "lan",
    port: 8899,
    externalOrigin: "https://my.host.example",
  });
  assert.deepEqual(parseRemoteArgs(["rotate"]), {
    action: "rotate",
    scope: undefined,
    port: undefined,
    externalOrigin: undefined,
  });
  assert.deepEqual(parseRemoteArgs(["off"]), {
    action: "stop",
    scope: undefined,
    port: undefined,
    externalOrigin: undefined,
  });
  assert.throws(() => parseRemoteArgs(["--port", "99999"]), /Invalid port/);
  assert.throws(() => parseRemoteArgs(["unknown-subcommand"]), /Unknown \/remote option/);
});

test("/remote is registered in LOCAL_SLASH_COMMANDS and dispatches through commandController", async (t) => {
  assert.equal(
    LOCAL_SLASH_COMMANDS.some((cmd) => cmd.name === "remote"),
    true,
    "/remote must be listed in LOCAL_SLASH_COMMANDS",
  );

  const webDir = await mkdtemp(path.join(os.tmpdir(), "rind-cli-remote-unit-"));
  await writeFile(path.join(webDir, "index.html"), "<!doctype html><title>Rind Remote</title>");
  const logs = [];
  const sessionState = {
    info: { session_id: "", workspace_root: webDir, model: "gpt-test", reasoning_effort: "medium" },
    reservedId: "",
    pendingName: "",
    pendingSkillSources: null,
  };

  const remoteController = createCliRemoteController({
    runtimeClient: {
      request: async (method, params) => ({ method, params, session_id: "s-unit", workspace_root: webDir }),
    },
    sessionState,
    log: (msg) => logs.push(typeof msg === "function" ? msg() : String(msg)),
    cwd: webDir,
    getInitInfo: () => ({ capabilities: [], methods: ["session/prompt"] }),
    webRoot: webDir,
  });
  t.after(async () => {
    await remoteController.stop();
    await rm(webDir, { recursive: true, force: true });
  });

  const commandController = createCommandController({
    request: async () => ({}),
    turn: {},
    input: {
      isTerminal: true,
      runRemote: (args) => remoteController.handleCommand(args),
    },
    state: { slashCommands: LOCAL_SLASH_COMMANDS },
    output: { log: (msg) => logs.push(typeof msg === "function" ? msg() : String(msg)) },
  });

  await commandController.handle("/remote loopback --port 0");
  assert.equal(remoteController.state().running, true);
  assert.equal(remoteController.state().scope, "loopback");
  const output = logs.at(-1);
  const expectedUrl = buildPairingUrl(remoteController.state());
  assert.equal(decodeTerminalQr(output), expectedUrl);
  assert.equal(output.includes(remoteController.state().accessCode), true);

  const oldCode = remoteController.state().accessCode;
  await commandController.handle("/remote rotate");
  const rotatedOutput = logs.at(-1);
  assert.notEqual(remoteController.state().accessCode, oldCode);
  assert.equal(decodeTerminalQr(rotatedOutput), buildPairingUrl(remoteController.state()));

  await commandController.handle("/remote off");
  assert.equal(remoteController.state().running, false);
  assert.match(logs.at(-1), /Remote access turned off/);
});

test("interactive TTY /remote menu, missing webRoot fallback, and port collision auto-fallback", async (t) => {
  const missingWebDir = path.join(os.tmpdir(), `rind-missing-web-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const logs = [];
  const choices = [];
  const sessionState = {
    info: { session_id: "s-menu", workspace_root: process.cwd(), model: "gpt-test", reasoning_effort: "medium" },
    reservedId: "s-menu",
    pendingName: "",
    pendingSkillSources: null,
  };

  let nextChoice = "";
  const controllerA = createCliRemoteController({
    runtimeClient: { request: async () => ({}) },
    sessionState,
    log: (msg) => logs.push(typeof msg === "function" ? msg() : String(msg)),
    askChoice: async (options, meta) => {
      choices.push({ options, meta });
      return typeof nextChoice === "function" ? nextChoice(options) : nextChoice;
    },
    cwd: process.cwd(),
    getInitInfo: () => ({ capabilities: [], methods: ["session/prompt"] }),
    webRoot: missingWebDir,
  });

  const controllerB = createCliRemoteController({
    runtimeClient: { request: async () => ({}) },
    sessionState,
    log: () => {},
    cwd: process.cwd(),
    getInitInfo: () => ({ capabilities: [], methods: ["session/prompt"] }),
    webRoot: missingWebDir,
  });

  t.after(async () => {
    await controllerA.stop();
    await controllerB.stop();
  });

  // 1. Start controllerA even when webRoot directory does not exist (allowMissingWebRoot: true)
  const stateA = await controllerA.handleCommand(["loopback"]);
  assert.equal(stateA.running, true);
  const rootRes = await fetch(`${stateA.addresses[0]}/`);
  assert.equal(rootRes.status, 200);
  assert.match(await rootRes.text(), /Rind Remote Access is active/);

  // 2. If port 8766 was bound by controllerA, starting controllerB with no explicit --port falls back automatically
  const stateB = await controllerB.handleCommand(["loopback"]);
  assert.equal(stateB.running, true);
  assert.notEqual(stateB.port, stateA.port);

  // 3. Running bare /remote while already running opens interactive TTY choice menu:
  //    - "Show QR code & connection details"
  nextChoice = "Show QR code & connection details";
  await controllerA.handleCommand([]);
  assert.equal(choices.at(-1).meta.title, "Remote access");
  assert.equal(decodeTerminalQr(logs.at(-1)), buildPairingUrl(controllerA.state()));

  //    - "Generate new code & disconnect devices"
  const prevCode = controllerA.state().accessCode;
  nextChoice = "Generate new code & disconnect devices";
  await controllerA.handleCommand([]);
  assert.notEqual(controllerA.state().accessCode, prevCode);
  assert.equal(decodeTerminalQr(logs.at(-1)), buildPairingUrl(controllerA.state()));

  //    - "Turn off remote access"
  nextChoice = "Turn off remote access";
  await controllerA.handleCommand([]);
  assert.equal(controllerA.state().running, false);
});

test("E2E CLI /remote: user runs /remote, scans terminal QR code, pairs over HTTP/WS, prompts session, and syncs live to CLI", { timeout: 30000 }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-cli-remote-e2e-"));
  const workspace = path.join(home, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "HELLO.md"), "Workspace file for remote E2E test", "utf8");

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

  // 1. User runs `/remote loopback` in CLI
  cliChild.stdin.write("/remote loopback\n");
  await waitForStdout((out) => out.includes("Commands:    /remote status · /remote rotate · /remote off"), 15000, "/remote QR output");

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

  // 8. Rotate access code from CLI (`/remote rotate`) and verify old WS closes with 4401
  const beforeRotateLen = stdoutText.length;
  const wsClosed = once(ws, "close");
  cliChild.stdin.write("/remote rotate\n");
  const [closeCode] = await wsClosed;
  assert.equal(closeCode, 4401, "rotating access code must disconnect existing WebSocket with 4401");

  await waitForStdout(
    (out) => out.slice(beforeRotateLen).includes("Access code rotated.") && out.slice(beforeRotateLen).includes("Commands:"),
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

  // 9. Turn off remote access (`/remote off`) and exit CLI
  cliChild.stdin.write("/remote off\n");
  await waitForStdout((out) => out.includes("Remote access turned off."), 10000, "/remote off confirmation");

  cliChild.stdin.write("/exit\n");
  await once(cliChild, "exit");
  await removeRindHome(home);
});
