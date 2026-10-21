import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allowRemoteOnWindows } from "../../rind-runtime-client/remote/firewall.js";
import {
  decodeQrMatrix,
  decodeTerminalQr,
  encodeQrMatrix,
  parseTerminalQrMatrix,
  renderSvgQrDataUrl,
  renderTerminalQr,
} from "../../rind-runtime-client/remote/qr.js";
import { RemoteServer, RemoteWebSocket } from "../../rind-runtime-client/remote/server.js";

export {
  decodeQrMatrix,
  decodeTerminalQr,
  encodeQrMatrix,
  parseTerminalQrMatrix,
  RemoteServer,
  RemoteWebSocket,
  renderSvgQrDataUrl,
  renderTerminalQr,
};

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(currentDir, "../..");

export function resolveWebRoot(override = "") {
  if (override) return override;
  const candidates = [
    process.env.RIND_WEB_ROOT || "",
    resolve(defaultRepoRoot, "frontend-web/dist"),
    resolve(defaultRepoRoot, "desktop/out/web"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return resolve(defaultRepoRoot, "frontend-web/dist");
}

function resolveRindHome() {
  const envHome = process.env.RIND_HOME?.trim();
  return envHome ? resolve(envHome) : join(homedir(), ".rind");
}

async function loadCliSettings() {
  const filePath = join(resolveRindHome(), "settings.json");
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

async function saveCliSettings(patch) {
  const rindHome = resolveRindHome();
  await mkdir(rindHome, { recursive: true });
  const filePath = join(rindHome, "settings.json");
  const current = await loadCliSettings();
  const next = {
    ...current,
    ...(patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}),
  };
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
  return next;
}

export function parseRemoteArgs(args = []) {
  const tokens = Array.isArray(args) ? args.map((arg) => String(arg).trim()).filter(Boolean) : [];
  let action = "auto";
  let scope;
  let port;
  let externalOrigin;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    if (lower === "on" || lower === "start" || lower === "enable") {
      action = "start";
    } else if (lower === "off" || lower === "stop" || lower === "disable") {
      action = "stop";
    } else if (lower === "status") {
      action = "status";
    } else if (lower === "rotate" || lower === "regenerate") {
      action = "rotate";
    } else if (lower === "firewall" || lower === "allow-network") {
      action = "firewall";
    } else if (lower === "lan" || lower === "--lan") {
      scope = "lan";
      if (action === "auto") action = "start";
    } else if (lower === "loopback" || lower === "local" || lower === "--loopback" || lower === "--local") {
      scope = "loopback";
      if (action === "auto") action = "start";
    } else if (lower === "--port" || lower === "-p") {
      const value = Number(tokens[++i]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error("Invalid port. Choose a port between 1024 and 65535.");
      }
      port = value;
      if (action === "auto") action = "start";
    } else if (lower.startsWith("--port=")) {
      const value = Number(token.slice("--port=".length));
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error("Invalid port. Choose a port between 1024 and 65535.");
      }
      port = value;
      if (action === "auto") action = "start";
    } else if (lower === "--origin") {
      externalOrigin = tokens[++i] || "";
      if (action === "auto") action = "start";
    } else if (lower.startsWith("--origin=")) {
      externalOrigin = token.slice("--origin=".length);
      if (action === "auto") action = "start";
    } else if (/^\d+$/.test(token) && port === undefined) {
      const value = Number(token);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error("Invalid port. Choose a port between 1024 and 65535.");
      }
      port = value;
      if (action === "auto") action = "start";
    } else if (token.startsWith("https://") && !externalOrigin) {
      externalOrigin = token;
      if (action === "auto") action = "start";
    } else {
      throw new Error(
        `Unknown /remote option "${token}". Usage: /remote [on|off|status|rotate|lan|loopback] [--port <port>] [--origin <https://...>]`,
      );
    }
  }

  return { action, scope, port, externalOrigin };
}

export function buildPairingUrl(state, selectedAddress = "") {
  if (!state?.running || !state.addresses?.length || !state.accessCode) return "";
  const primary = selectedAddress && state.addresses.includes(selectedAddress) ? selectedAddress : state.addresses[0];
  return `${primary}/#connect=${encodeURIComponent(state.accessCode)}`;
}

export function formatRemoteOutput(state, { heading = "", selectedAddress = "" } = {}) {
  if (!state?.running) {
    return [
      heading || "Remote access is off.",
      "Use /remote to start remote access and display a pairing QR code.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const primaryAddress =
    selectedAddress && state.addresses?.includes(selectedAddress)
      ? selectedAddress
      : state.addresses?.[0] || `http://127.0.0.1:${state.port}`;
  const pairingUrl = buildPairingUrl(state, primaryAddress);
  const qrBlock = pairingUrl ? renderTerminalQr(pairingUrl, { margin: 2 }) : "";
  const scopeLabel = state.scope === "lan" ? "local network" : "this computer";
  const clientLabel = `${state.clients} connected ${state.clients === 1 ? "device" : "devices"}`;
  const alternates = (state.addresses || []).filter((addr) => addr !== primaryAddress);
  const lines = [
    heading || `Remote access is on (${scopeLabel} · port ${state.port} · ${clientLabel})`,
    "Scan this QR code with your phone camera or open the sign-in link in a browser:",
    "",
    qrBlock,
    "",
    `Sign-in URL: ${pairingUrl}`,
    `Address:     ${primaryAddress}`,
  ];
  if (alternates.length > 0) {
    lines.push(`Alternates:  ${alternates.join(", ")}`);
  }
  lines.push(`Access code: ${state.accessCode}`);
  lines.push("Commands:    /remote status · /remote rotate · /remote off");
  return lines.filter((line) => line !== undefined).join("\n");
}

function emptyAgentsSnapshot() {
  return {
    seq: 0,
    teams: [],
    memberships: [],
    agents: [],
    tasks: [],
    runs: [],
    sessions: [],
    connectedSessions: [],
    live: [],
    folderDefaultsVersion: 0,
    notices: [],
    approvals: [],
    archivedTeams: [],
    notes: [],
    artifacts: [],
  };
}

export function createCliRemoteController({
  runtimeClient,
  rawClient,
  sessionState,
  log = () => {},
  redraw = () => {},
  askChoice = null,
  onSessionRestored = () => {},
  cwd = process.cwd(),
  getInitInfo = () => null,
  webRoot = "",
  managementLaunch = {},
} = {}) {
  const eventListeners = new Set();
  const agentListeners = new Set();
  const pendingPromptInputs = new Map();
  const client = rawClient || runtimeClient;
  let mgmtClient = null;
  let mgmtSnapshot = emptyAgentsSnapshot();
  let selectedAddress = "";

  async function ensureManagementClient({ start = false } = {}) {
    if (mgmtClient) return mgmtClient;
    try {
      const { connectManagement } = await import("../../agent-management/dist/client.js");
      mgmtClient = await connectManagement({
        ...managementLaunch,
        home: managementLaunch?.home || resolveRindHome(),
        start,
        onEvent(event) {
          if (event?.type === "snapshot" && event.snapshot) {
            mgmtSnapshot = { ...emptyAgentsSnapshot(), ...event.snapshot };
            const payload = { snapshot: mgmtSnapshot, connection: "connected", service: mgmtClient?.service || null };
            for (const listener of agentListeners) {
              try {
                listener(payload);
              } catch {
                // ignore
              }
            }
          }
        },
      });
      if (mgmtClient?.snapshot) {
        mgmtSnapshot = { ...emptyAgentsSnapshot(), ...mgmtClient.snapshot };
      }
      return mgmtClient;
    } catch {
      return null;
    }
  }

  function bindCliSessionIfEmpty(result, fallbackWorkspace = "") {
    const nextSessionId = String(result?.session_id || "").trim();
    if (!nextSessionId || sessionState?.info?.session_id) return;
    sessionState.info = {
      ...sessionState.info,
      ...(result && typeof result === "object" ? result : {}),
      session_id: nextSessionId,
      workspace_root: String(result?.workspace_root || fallbackWorkspace || sessionState.info?.workspace_root || cwd),
    };
    sessionState.reservedId = nextSessionId;
    sessionState.pendingName = "";
    sessionState.pendingSkillSources = null;
    redraw?.();
    onSessionRestored?.();
  }

  const bridge = {
    async initialize() {
      const initInfo = getInitInfo?.() || {};
      return {
        protocol_version: "2",
        capabilities: Array.isArray(initInfo.capabilities) ? initInfo.capabilities : [],
        methods: Array.isArray(initInfo.methods) ? initInfo.methods : [],
        session_id: String(sessionState?.info?.session_id || ""),
        workspace_root: String(sessionState?.info?.workspace_root || cwd),
        model: String(sessionState?.info?.model || ""),
        reasoning_effort: String(sessionState?.info?.reasoning_effort || ""),
      };
    },
    async request(method, params = {}) {
      if (method === "session/new" || method === "session/create") {
        // When the CLI window has no active session yet, create it through runtimeController
        // so draft settings apply and the CLI window attaches to the new session.
        if (!sessionState?.info?.session_id && runtimeClient?.request) {
          const result = await runtimeClient.request("session/create", params);
          bindCliSessionIfEmpty(result, params.workspace_root);
          return result;
        }
        const result = await client.request(method, params);
        bindCliSessionIfEmpty(result, params.workspace_root);
        return result;
      }
      if (method === "session/switch") {
        const result = await client.request("session/switch", params);
        bindCliSessionIfEmpty(result, result?.workspace_root);
        return result;
      }
      if (method === "session/prompt") {
        const targetSessionId = String(params.session_id || "").trim();
        if (targetSessionId && !sessionState?.info?.session_id) {
          bindCliSessionIfEmpty({ session_id: targetSessionId }, cwd);
        }
        if (targetSessionId && typeof params.input === "string" && params.input.trim()) {
          pendingPromptInputs.set(targetSessionId, params.input);
        }
        try {
          return await client.request("session/prompt", params);
        } catch (error) {
          if (targetSessionId) pendingPromptInputs.delete(targetSessionId);
          throw error;
        }
      }
      return client.request(method, params);
    },
    subscribe(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    async agentsRequest(method, params = {}) {
      if (method === "getState") {
        const mgmt = await ensureManagementClient({ start: false });
        if (!mgmt) return { snapshot: mgmtSnapshot, connection: "offline", service: null };
        const res = await mgmt.request("state/get", {}).catch(() => null);
        if (res?.snapshot) mgmtSnapshot = { ...emptyAgentsSnapshot(), ...res.snapshot };
        return { snapshot: mgmtSnapshot, connection: "connected", service: mgmt.service || null };
      }
      const mgmt = await ensureManagementClient({ start: true });
      if (!mgmt) throw new Error("Agents management is offline.");
      if (method === "openSession") {
        const opened = await mgmt.request("session/open", params);
        const runtimeSessionId = String(opened?.runtimeSessionId || opened?.session?.session_id || "");
        if (runtimeSessionId) {
          await client.request("session/subscribe", { session_id: runtimeSessionId }).catch(() => {});
        }
        return opened;
      }
      if (method === "createSession") {
        const created = await client.request("session/create", {
          workspace_root: params.workspace_root || sessionState?.info?.workspace_root || cwd,
        });
        return created;
      }
      return mgmt.request(method, params);
    },
    subscribeAgents(listener) {
      agentListeners.add(listener);
      return () => agentListeners.delete(listener);
    },
    settingsLoad: loadCliSettings,
    settingsSave: saveCliSettings,
  };

  const server = new RemoteServer(
    bridge,
    resolveWebRoot(webRoot),
    () => {
      redraw?.();
    },
    { allowMissingWebRoot: true },
  );

  function handleRuntimeEvent(message) {
    if (!message || typeof message !== "object") return;
    const sessionId = String(message.session_id || "");
    if (message.event?.type === "turn_started" && sessionId && pendingPromptInputs.has(sessionId)) {
      const remoteInput = pendingPromptInputs.get(sessionId);
      pendingPromptInputs.delete(sessionId);
      if (!message.event.input && typeof remoteInput === "string") {
        message.event = { ...message.event, input: remoteInput };
      }
    }
    for (const listener of eventListeners) {
      try {
        listener(message);
      } catch {
        // ignore
      }
    }
  }

  async function handleCommand(args = []) {
    const parsed = parseRemoteArgs(args);
    const current = server.state();

    if (parsed.action === "stop") {
      if (!current.running) {
        log("Remote access is already off.");
        return server.state();
      }
      await server.stop();
      selectedAddress = "";
      log("Remote access turned off.");
      return server.state();
    }

    if (parsed.action === "rotate") {
      if (!current.running) {
        throw new Error("Remote access is off. Run /remote to enable it first.");
      }
      const next = server.rotate();
      log(
        formatRemoteOutput(next, {
          heading: "Access code rotated. Previous devices have been disconnected.",
          selectedAddress,
        }),
      );
      return next;
    }

    if (parsed.action === "firewall") {
      if (!current.running) {
        throw new Error("Remote access is off. Run /remote to enable it first.");
      }
      await allowRemoteOnWindows(process.execPath, current.port);
      log("Windows firewall rule updated for the current remote port.");
      return current;
    }

    if (parsed.action === "status") {
      log(formatRemoteOutput(current, { selectedAddress }));
      return current;
    }

    // action === "auto" or "start"
    if (current.running) {
      const wantsRestart =
        (parsed.scope && parsed.scope !== current.scope) ||
        (parsed.port !== undefined && parsed.port !== 0 && parsed.port !== current.port) ||
        Boolean(parsed.externalOrigin);
      if (!wantsRestart) {
        if (parsed.action === "auto" && typeof askChoice === "function") {
          const activeAddr =
            selectedAddress && current.addresses.includes(selectedAddress)
              ? selectedAddress
              : current.addresses[0] || `http://127.0.0.1:${current.port}`;
          const showOption = "Show QR code & connection details";
          const switchOption = `Switch address · ${activeAddr}`;
          const rotateOption = "Generate new code & disconnect devices";
          const stopOption = "Turn off remote access";
          const options = [
            showOption,
            ...(current.addresses.length > 1 ? [switchOption] : []),
            rotateOption,
            stopOption,
          ];
          const choice = await askChoice(options, {
            title: "Remote access",
            message: `${current.scope === "lan" ? "Local network" : "This computer"} · port ${current.port} · ${current.clients} connected`,
          });
          if (!choice) return current;
          if (choice === showOption) {
            log(formatRemoteOutput(server.state(), { selectedAddress }));
            return server.state();
          }
          if (choice === switchOption) {
            const picked = await askChoice(current.addresses, {
              title: "Remote address",
              message: "Choose the address encoded in the QR code and sign-in link.",
            });
            if (picked && current.addresses.includes(picked)) {
              selectedAddress = picked;
              log(formatRemoteOutput(server.state(), { selectedAddress }));
            }
            return server.state();
          }
          if (choice === rotateOption) {
            const next = server.rotate();
            log(
              formatRemoteOutput(next, {
                heading: "Access code rotated. Previous devices have been disconnected.",
                selectedAddress,
              }),
            );
            return next;
          }
          if (choice === stopOption) {
            await server.stop();
            selectedAddress = "";
            log("Remote access turned off.");
            return server.state();
          }
        }
        log(formatRemoteOutput(current, { selectedAddress }));
        return current;
      }
      await server.stop();
    }

    const scope = parsed.scope || "lan";
    const startOptions = {
      scope,
      port: parsed.port ?? 8766,
      ...(parsed.externalOrigin ? { externalOrigin: parsed.externalOrigin } : {}),
    };
    let next;
    try {
      next = await server.start(startOptions);
    } catch (error) {
      if (parsed.port === undefined && error?.code === "EADDRINUSE") {
        next = await server.start({ ...startOptions, port: 0 });
      } else {
        throw error;
      }
    }
    if (!selectedAddress || !next.addresses.includes(selectedAddress)) {
      selectedAddress = next.addresses[0] || "";
    }
    log(formatRemoteOutput(next, { selectedAddress }));
    return next;
  }

  async function stop() {
    await server.stop().catch(() => {});
    try {
      mgmtClient?.close?.();
    } catch {
      // ignore
    }
    mgmtClient = null;
  }

  return {
    state: () => server.state(),
    handleCommand,
    handleRuntimeEvent,
    stop,
    server,
  };
}
