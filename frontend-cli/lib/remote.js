import { resolve } from "node:path";
import {
  createRemoteHost,
  resolveRindHome,
  resolveWebRoot,
} from "../../rind-runtime-client/remote/host.js";
import {
  decodeQrMatrix,
  decodeTerminalQr,
  encodeQrMatrix,
  parseTerminalQrMatrix,
  renderSvgQrDataUrl,
  renderTerminalQr,
} from "../../rind-runtime-client/remote/qr.js";
import { RemoteServer, RemoteWebSocket } from "../../rind-runtime-client/remote/server.js";
import { registerSharedWorkspace } from "../../rind-runtime-client/remote/workspaces.js";

export {
  decodeQrMatrix,
  decodeTerminalQr,
  encodeQrMatrix,
  parseTerminalQrMatrix,
  RemoteServer,
  RemoteWebSocket,
  renderSvgQrDataUrl,
  renderTerminalQr,
  resolveWebRoot,
};

const STOPPED_STATE = {
  running: false,
  scope: "loopback",
  port: 8766,
  addresses: [],
  accessCode: "",
  clients: 0,
};

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
  rindHome: explicitRindHome = "",
  managementLaunch = {},
} = {}) {
  const eventListeners = new Set();
  const pendingPromptInputs = new Map();
  const client = rawClient || runtimeClient;
  const rindHome = explicitRindHome
    ? resolve(explicitRindHome)
    : managementLaunch?.home
      ? resolve(managementLaunch.home)
      : resolveRindHome();
  let cachedState = { ...STOPPED_STATE };
  let localHost = null;
  let sharedSupported = null;
  let selectedAddress = "";

  const currentWorkspace = () =>
    String(sessionState?.info?.workspace_root || sessionState?.info?.cwd || cwd || process.cwd());

  void registerSharedWorkspace(rindHome, currentWorkspace(), { setActive: true }).catch(() => {});

  function bindCliSessionIfEmpty(result, fallbackWorkspace = "") {
    const nextSessionId = String(result?.session_id || "").trim();
    if (!nextSessionId || sessionState?.info?.session_id) return;
    sessionState.info = {
      ...sessionState.info,
      ...(result && typeof result === "object" ? result : {}),
      session_id: nextSessionId,
      workspace_root: String(result?.workspace_root || fallbackWorkspace || currentWorkspace()),
    };
    sessionState.reservedId = nextSessionId;
    sessionState.pendingName = "";
    sessionState.pendingSkillSources = null;
    redraw?.();
    onSessionRestored?.();
  }

  function getLocalHost() {
    if (localHost) return localHost;
    localHost = createRemoteHost({
      getRindHome: () => rindHome,
      repoRoot: managementLaunch?.repoRoot,
      getRuntimePath: () => managementLaunch?.runtimePath || "",
      getPython: () => managementLaunch?.python,
      initializeRuntime: async () => {
        const initInfo = getInitInfo?.() || {};
        return {
          protocol_version: "2",
          capabilities: Array.isArray(initInfo.capabilities) ? initInfo.capabilities : [],
          methods: Array.isArray(initInfo.methods) ? initInfo.methods : [],
          session_id: String(sessionState?.info?.session_id || ""),
          workspace_root: currentWorkspace(),
          model: String(sessionState?.info?.model || ""),
          reasoning_effort: String(sessionState?.info?.reasoning_effort || ""),
        };
      },
      requestRuntime: async (method, params = {}) => {
        if (method === "session/new" || method === "session/create") {
          const target = !sessionState?.info?.session_id && runtimeClient?.request ? runtimeClient : client;
          const result = await target.request("session/create", params);
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
            bindCliSessionIfEmpty({ session_id: targetSessionId }, currentWorkspace());
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
      subscribeRuntime: (listener) => {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      webRoot: resolveWebRoot(webRoot),
      allowMissingWebRoot: true,
      onStateChange: (state) => {
        cachedState = state;
        redraw?.();
      },
    });
    return localHost;
  }

  async function requestRemote(method, params = {}) {
    if (sharedSupported !== false && client?.request) {
      try {
        const res = await client.request(method, params);
        if (res && typeof res.running === "boolean" && Array.isArray(res.addresses)) {
          sharedSupported = true;
          cachedState = res;
          return res;
        }
        if (sharedSupported === null) {
          sharedSupported = false;
        }
      } catch (error) {
        if (sharedSupported === true) throw error;
        sharedSupported = false;
      }
    }
    const host = getLocalHost();
    if (method === "remote/get") cachedState = host.state();
    else if (method === "remote/start") cachedState = await host.start(params);
    else if (method === "remote/stop") cachedState = await host.stop();
    else if (method === "remote/rotate") cachedState = host.rotate();
    else if (method === "remote/allow-network") cachedState = await host.allowNetwork(process.execPath);
    return cachedState;
  }

  function handleRuntimeEvent(message) {
    if (!message || typeof message !== "object") return;
    if (message.kind === "remote" && message.state) {
      cachedState = message.state;
      redraw?.();
      return;
    }
    const sessionId = String(message.session_id || "");
    if (sessionId && !sessionState?.info?.session_id) {
      bindCliSessionIfEmpty({ session_id: sessionId }, currentWorkspace());
    }
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
    await registerSharedWorkspace(rindHome, currentWorkspace(), { setActive: true }).catch(() => {});
    const current = await requestRemote("remote/get");

    if (parsed.action === "stop") {
      if (!current.running) {
        log("Remote access is already off.");
        return current;
      }
      const stopped = await requestRemote("remote/stop");
      selectedAddress = "";
      log("Remote access turned off.");
      return stopped;
    }

    if (parsed.action === "rotate") {
      if (!current.running) {
        throw new Error("Remote access is off. Run /remote to enable it first.");
      }
      const next = await requestRemote("remote/rotate");
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
      const next = await requestRemote("remote/allow-network");
      log("Windows firewall rule updated for the current remote port.");
      return next;
    }

    if (parsed.action === "status") {
      log(formatRemoteOutput(current, { selectedAddress }));
      return current;
    }

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
            const latest = await requestRemote("remote/get");
            log(formatRemoteOutput(latest, { selectedAddress }));
            return latest;
          }
          if (choice === switchOption) {
            const picked = await askChoice(current.addresses, {
              title: "Remote address",
              message: "Choose the address encoded in the QR code and sign-in link.",
            });
            const latest = await requestRemote("remote/get");
            if (picked && latest.addresses.includes(picked)) {
              selectedAddress = picked;
              log(formatRemoteOutput(latest, { selectedAddress }));
            }
            return latest;
          }
          if (choice === rotateOption) {
            const next = await requestRemote("remote/rotate");
            log(
              formatRemoteOutput(next, {
                heading: "Access code rotated. Previous devices have been disconnected.",
                selectedAddress,
              }),
            );
            return next;
          }
          if (choice === stopOption) {
            const stopped = await requestRemote("remote/stop");
            selectedAddress = "";
            log("Remote access turned off.");
            return stopped;
          }
        }
        log(formatRemoteOutput(current, { selectedAddress }));
        return current;
      }
    }

    const startOptions = {
      scope: parsed.scope || "lan",
      ...(parsed.port !== undefined ? { port: parsed.port } : {}),
      ...(parsed.externalOrigin ? { externalOrigin: parsed.externalOrigin } : {}),
      ...(webRoot ? { webRoot: resolveWebRoot(webRoot) } : {}),
      workspace_root: currentWorkspace(),
    };
    const next = await requestRemote("remote/start", startOptions);
    if (!selectedAddress || !next.addresses.includes(selectedAddress)) {
      selectedAddress = next.addresses[0] || "";
    }
    log(formatRemoteOutput(next, { selectedAddress }));
    return next;
  }

  async function stop() {
    if (localHost) {
      await localHost.close().catch(() => {});
      cachedState = { ...STOPPED_STATE };
    }
  }

  return {
    state: () => (localHost ? localHost.state() : cachedState),
    handleCommand,
    handleRuntimeEvent,
    stop,
    get server() {
      return localHost?.server || null;
    },
  };
}
