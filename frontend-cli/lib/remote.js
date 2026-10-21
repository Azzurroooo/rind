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

const TURN_ON_LAN_OPTION = "Turn on (Local network) · Wi-Fi / LAN devices and this computer";
const TURN_ON_LOCAL_OPTION = "Turn on (This computer) · 127.0.0.1 only";
const TURN_OFF_OPTION = "Turn off · Stop remote access and disconnect devices";
const SHOW_QR_OPTION = "Show QR code · Display pairing QR code and connection details";
const SWITCH_TO_LOCAL_OPTION = "Switch to this computer · Restrict access to 127.0.0.1 only";
const SWITCH_TO_LAN_OPTION = "Switch to local network · Share on Wi-Fi / LAN";
const ROTATE_CODE_OPTION = "Rotate access code · Generate new code and disconnect devices";

function matchesChoice(choice, option) {
  const picked = String(choice || "").trim();
  if (!picked) return false;
  const label = option.split(" · ")[0].trim();
  return picked === option || picked === label;
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

  function applyState(state) {
    cachedState = state && typeof state === "object" ? { ...STOPPED_STATE, ...state } : { ...STOPPED_STATE };
    const running = Boolean(cachedState.running);
    if (sessionState?.info && Boolean(sessionState.info.remote_running) !== running) {
      sessionState.info = { ...sessionState.info, remote_running: running };
    }
    redraw?.();
    return cachedState;
  }

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
        applyState(state);
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
          return applyState(res);
        }
        if (sharedSupported === null) {
          sharedSupported = false;
        }
      } catch (error) {
        if (sharedSupported === true) throw error;
        sharedSupported = false;
      }
    }
    if (method === "remote/get" && !localHost) {
      return applyState(STOPPED_STATE);
    }
    const host = getLocalHost();
    if (method === "remote/get") return applyState(host.state());
    if (method === "remote/start") return applyState(await host.start(params));
    if (method === "remote/stop") return applyState(await host.stop());
    if (method === "remote/rotate") return applyState(host.rotate());
    return cachedState;
  }

  async function refresh() {
    try {
      return await requestRemote("remote/get");
    } catch {
      return cachedState;
    }
  }

  function handleRuntimeEvent(message) {
    if (!message || typeof message !== "object") return;
    if (message.kind === "remote" && message.state) {
      applyState(message.state);
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

  async function startWithScope(scope) {
    const next = await requestRemote("remote/start", {
      scope,
      ...(webRoot ? { webRoot: resolveWebRoot(webRoot) } : {}),
      workspace_root: currentWorkspace(),
    });
    if (!selectedAddress || !next.addresses.includes(selectedAddress)) {
      selectedAddress = next.addresses[0] || "";
    }
    log(formatRemoteOutput(next, { selectedAddress }));
    return next;
  }

  async function handleCommand() {
    await registerSharedWorkspace(rindHome, currentWorkspace(), { setActive: true }).catch(() => {});
    let current = await requestRemote("remote/get");

    if (!current.running) {
      const choice = await askChoice?.({
        title: "Remote access · Off",
        message: "Share this session with your phone or browser via QR code.",
        options: [TURN_ON_LAN_OPTION, TURN_ON_LOCAL_OPTION],
      });
      if (!choice) return current;
      const scope = matchesChoice(choice, TURN_ON_LOCAL_OPTION)
        ? "loopback"
        : matchesChoice(choice, TURN_ON_LAN_OPTION)
          ? "lan"
          : "";
      if (!scope) return current;
      return startWithScope(scope);
    }

    while (true) {
      const activeAddr =
        selectedAddress && current.addresses.includes(selectedAddress)
          ? selectedAddress
          : current.addresses[0] || `http://127.0.0.1:${current.port}`;
      const scopeLabel = current.scope === "lan" ? "Local network" : "This computer";
      const clientLabel = `${current.clients} connected ${current.clients === 1 ? "device" : "devices"}`;
      const switchScopeOption = current.scope === "lan" ? SWITCH_TO_LOCAL_OPTION : SWITCH_TO_LAN_OPTION;
      const switchAddressOption = `Switch address · ${activeAddr}`;
      const options = [
        TURN_OFF_OPTION,
        SHOW_QR_OPTION,
        switchScopeOption,
        ...(current.addresses.length > 1 ? [switchAddressOption] : []),
        ROTATE_CODE_OPTION,
      ];
      const choice = await askChoice?.({
        title: "Remote access · On",
        message: `${scopeLabel} · ${activeAddr} · ${clientLabel}`,
        options,
      });
      if (!choice) return current;

      if (matchesChoice(choice, TURN_OFF_OPTION)) {
        const stopped = await requestRemote("remote/stop");
        selectedAddress = "";
        log("Remote access turned off.");
        return stopped;
      }
      if (matchesChoice(choice, SHOW_QR_OPTION)) {
        const latest = await requestRemote("remote/get");
        log(formatRemoteOutput(latest, { selectedAddress }));
        return latest;
      }
      if (matchesChoice(choice, switchScopeOption)) {
        const nextScope = current.scope === "lan" ? "loopback" : "lan";
        selectedAddress = "";
        return startWithScope(nextScope);
      }
      if (current.addresses.length > 1 && matchesChoice(choice, switchAddressOption)) {
        const picked = await askChoice?.({
          title: "Remote access · Address",
          message: "Choose the address encoded in the QR code and sign-in link.",
          options: current.addresses,
        });
        current = await requestRemote("remote/get");
        if (!picked) {
          if (!current.running) return current;
          continue;
        }
        if (current.addresses.includes(picked)) {
          selectedAddress = picked;
          log(formatRemoteOutput(current, { selectedAddress }));
        }
        return current;
      }
      if (matchesChoice(choice, ROTATE_CODE_OPTION)) {
        const next = await requestRemote("remote/rotate");
        log(
          formatRemoteOutput(next, {
            heading: "Access code rotated. Previous devices have been disconnected.",
            selectedAddress,
          }),
        );
        return next;
      }
      return current;
    }
  }

  async function stop() {
    if (localHost) {
      await localHost.close().catch(() => {});
      applyState(STOPPED_STATE);
    }
  }

  return {
    state: () => (localHost ? localHost.state() : cachedState),
    refresh,
    handleCommand,
    handleRuntimeEvent,
    stop,
    get server() {
      return localHost?.server || null;
    },
  };
}
