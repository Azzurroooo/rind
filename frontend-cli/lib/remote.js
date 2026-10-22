import { resolve } from "node:path";
import {
  createRemoteHost,
  resolveRindHome,
  resolveWebRoot,
} from "../../rind-runtime-client/remote/host.js";
import { registerSharedWorkspace } from "../../rind-runtime-client/remote/workspaces.js";

const STOPPED_STATE = {
  running: false,
  scope: "loopback",
  port: 8766,
  addresses: [],
  accessCode: "",
  clients: 0,
};

const REMOTE_SCOPES = Object.freeze([
  { name: "lan", label: "Local network", description: "Phones and computers on the same Wi-Fi" },
  { name: "loopback", label: "This computer", description: "A browser on this machine only" },
]);

const LOOPBACK_ADDRESS = /^https?:\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])(?::\d+)?\/?$/i;

function scopeIndexOf(scope) {
  return Math.max(0, REMOTE_SCOPES.findIndex((item) => item.name === scope));
}

// /remote shows one of two views: Off picks the network scope to turn on
// with; On shows how to connect. Esc closes either view.
export function createRemoteMenuState({
  initialState = STOPPED_STATE,
  initialScope = "lan",
  initialAddress = "",
  onStart,
  onStop,
  onRotate,
  onAddressChange = () => {},
}) {
  let state = { ...STOPPED_STATE, ...initialState };
  let scopeIndex = scopeIndexOf(state.running ? state.scope : initialScope);
  let selectedAddress = initialAddress;
  let notice = "";
  let busy = false;

  // A phone can never reach a loopback address, so only other addresses are offered for pairing.
  const reachableAddresses = () => state.addresses.filter((address) => !LOOPBACK_ADDRESS.test(address));

  function activeAddress() {
    const reachable = reachableAddresses();
    if (!reachable.length) return state.addresses[0] || "";
    return reachable.includes(selectedAddress) ? selectedAddress : reachable[0];
  }

  function connection() {
    if (!state.running) return null;
    const reachable = reachableAddresses();
    const address = activeAddress();
    return {
      scopeLabel: REMOTE_SCOPES[scopeIndexOf(state.scope)].label,
      clients: state.clients,
      reachable: reachable.length > 0,
      addressIndex: reachable.indexOf(address),
      addressCount: reachable.length,
      link: address && state.accessCode ? `${address}/#connect=${encodeURIComponent(state.accessCode)}` : "",
      accessCode: state.accessCode,
      notice,
    };
  }

  async function apply(action) {
    busy = true;
    try {
      state = { ...STOPPED_STATE, ...(await action()) };
    } finally {
      busy = false;
    }
  }

  async function handleKey(key) {
    if (busy) return null;
    const name = key?.name;
    if (name === "escape") return "close";
    if (!state.running) {
      if (name === "up" || name === "down") {
        scopeIndex = (scopeIndex + 1) % REMOTE_SCOPES.length;
        return "redraw";
      }
      if (name === "enter" || name === "return" || key?.text === " ") {
        notice = "";
        await apply(() => onStart(REMOTE_SCOPES[scopeIndex].name));
        return "redraw";
      }
      return null;
    }
    const reachable = reachableAddresses();
    if ((name === "left" || name === "right") && reachable.length > 1) {
      const step = name === "left" ? -1 : 1;
      selectedAddress = reachable[(reachable.indexOf(activeAddress()) + step + reachable.length) % reachable.length];
      onAddressChange(selectedAddress);
      return "redraw";
    }
    const letter = String(key?.text || key?.name || "").toLowerCase();
    if (letter === "r") {
      await apply(onRotate);
      notice = "New access code. Previous devices were disconnected.";
      return "redraw";
    }
    if (letter === "x") {
      scopeIndex = scopeIndexOf(state.scope);
      notice = "";
      await apply(onStop);
      return "redraw";
    }
    return null;
  }

  return {
    state: () => state,
    scopes: () => REMOTE_SCOPES,
    scopeIndex: () => scopeIndex,
    connection,
    updateState: (next) => {
      state = { ...STOPPED_STATE, ...next };
    },
    handleKey,
  };
}

export function createCliRemoteController({
  runtimeClient,
  rawClient,
  sessionState,
  redraw = () => {},
  askRemoteMenu,
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
  let preferredScope = "lan";
  let activeMenuState = null;

  const currentWorkspace = () =>
    String(sessionState?.info?.workspace_root || sessionState?.info?.cwd || cwd || process.cwd());

  void registerSharedWorkspace(rindHome, currentWorkspace(), { setActive: true }).catch(() => {});

  function applyState(state) {
    cachedState = state && typeof state === "object" ? { ...STOPPED_STATE, ...state } : { ...STOPPED_STATE };
    const running = Boolean(cachedState.running);
    if (running) {
      preferredScope = cachedState.scope;
    }
    if (sessionState?.info && Boolean(sessionState.info.remote_running) !== running) {
      sessionState.info = { ...sessionState.info, remote_running: running };
    }
    activeMenuState?.updateState(cachedState);
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

  async function handleCommand() {
    await registerSharedWorkspace(rindHome, currentWorkspace(), { setActive: true }).catch(() => {});
    const menuState = createRemoteMenuState({
      initialState: await requestRemote("remote/get"),
      initialScope: preferredScope,
      initialAddress: selectedAddress,
      onStart: (scope) => requestRemote("remote/start", {
        scope,
        ...(webRoot ? { webRoot: resolveWebRoot(webRoot) } : {}),
        workspace_root: currentWorkspace(),
      }),
      onStop: () => requestRemote("remote/stop"),
      onRotate: () => requestRemote("remote/rotate"),
      onAddressChange: (address) => {
        selectedAddress = address;
      },
    });
    activeMenuState = menuState;
    try {
      await askRemoteMenu(menuState);
    } finally {
      activeMenuState = null;
    }
    return cachedState;
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

