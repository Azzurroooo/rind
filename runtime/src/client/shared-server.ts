import net from "node:net";
import { existsSync } from "node:fs";
import { privateDirectory, recordedNonce, resolveRindHome } from "./local-files.js";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile, unlink, link } from "node:fs/promises";
import { createRuntimeClient } from "./runtime-client.js";
import { sharedRuntimePaths, type SharedRuntimePaths } from "./shared-runtime.js";
import { listenOwned } from "./endpoint.js";
import { runtimeBuildId } from "./build-id.js";
import { createLineBuffer } from "./ndjson.js";
import { createLiveSessions } from "./live-sessions.js";
import { createRemoteHost, type RemoteHost } from "../remote/host.js";
import type { RemoteOptions, RemoteState } from "../remote/server.js";
import { registerSharedWorkspace, samePath } from "../remote/workspaces.js";

const hostEntry = Boolean(process.argv[1]?.endsWith("shared-server.js"));
const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000;

const writeStderr = (text: string): void => {
  const at = `[${new Date().toISOString()}] `;
  process.stderr.write(text.replace(/^(?=.)/gm, at));
};

const OBSERVE_EVENTS = new Set([
  "turn_started",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "user_question_requested",
  "user_question_answered",
  "background_wait_changed",
  "folder_defaults_changed",
  "wait_released",
  "session_discarded",
  "session_deleted",
  "session_renamed",
  "session_settings_changed",
]);

const STOPPED_REMOTE_STATE: RemoteState = {
  running: false,
  scope: "loopback",
  port: 0,
  addresses: [],
  accessCode: "",
  clients: 0,
};

export interface SharedServerOptions {
  rindHome?: string;
  repoRoot?: string;
  runtimePath?: string;
  idleTtlMs?: number;
  stopWhenIdle?: boolean;
  hostNonce?: string;
}

interface PeerState {
  socket: net.Socket;
  sessions: Set<string>;
  prompts: Map<string, number>;
  requestPrompts: Map<string, number>;
  observe: boolean;
  oneShot: boolean;
  window: boolean;
  acceptsInput?: boolean;
  workspace: string;
  send: (message: Record<string, unknown>) => void;
}

function resolveIdleTtlMs(options?: SharedServerOptions): number {
  const raw = options?.idleTtlMs ?? process.env.RIND_RUNTIME_IDLE_TTL_MS;
  if (raw === undefined || raw === "") return DEFAULT_IDLE_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_TTL_MS;
}

export async function startSharedServer(
  options: SharedServerOptions = {},
): Promise<{ paths: SharedRuntimePaths; close: (reason?: string) => Promise<void> }> {
  const rindHome = resolveRindHome(options.rindHome);
  const paths = sharedRuntimePaths(rindHome);
  await privateDirectory(paths.directory);
  let token = "";
  let recordNonce = "";
  let initialized: Promise<any> | null | undefined;
  let workerPid: number | null = null;
  let authOwner: PeerState | null = null;
  let stopping = false;
  let closing: Promise<void> | undefined;
  let remoteHost: RemoteHost | undefined;
  const startedAt = new Date().toISOString();
  const build = runtimeBuildId(options);
  const peers = new Set<PeerState>();
  const auth = new Map<string | number, { peer: PeerState; resolve: (value: string) => void }>();
  const prompts = new Map<string, number>();
  const deleting = new Set<string>();
  const opening = new Map<string, number>();
  const remoteEventListeners = new Set<(event: any) => void>();
  const sessionWorkspaces = new Map<string, string>();
  const pendingPromptTexts = new Map<
    string,
    { input: string; clientInputId?: unknown; remote: boolean }
  >();

  const holdPrompt = (map: Map<string, number>, sid: string): void => {
    map.set(sid, (map.get(sid) || 0) + 1);
  };
  const releasePrompt = (map: Map<string, number>, sid: string): void => {
    const count = (map.get(sid) || 1) - 1;
    if (count > 0) map.set(sid, count);
    else map.delete(sid);
  };
  const writeLog = (event: string, fields: Record<string, unknown> = {}): Promise<void> =>
    existsSync(paths.directory)
      ? appendFile(
          paths.log,
          `[${new Date().toISOString()}] ${event}${Object.entries(fields)
            .filter(([, v]) => v !== undefined && v !== null && v !== "")
            .map(([k, v]) => ` ${k}=${v}`)
            .join("")}\n`,
          { mode: 0o600 },
        ).catch(() => {})
      : Promise.resolve();

  const live = createLiveSessions<PeerState>({
    onChange(sessions) {
      for (const peer of peers) {
        if (peer.observe) {
          peer.send({ event: { kind: "runtime", type: "sessions_changed", sessions } });
        }
      }
    },
  });

  const busyCount = (): number =>
    new Set([
      ...prompts.keys(),
      ...live
        .list()
        .filter((item) => item.turn !== "idle" || item.background)
        .map((item) => item.id),
    ]).size;

  const idleTtlMs = resolveIdleTtlMs(options);
  let idleSince = Date.now();
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let stopWhenIdle = Boolean(options.stopWhenIdle);
  let hasConnectedPeer = false;

  const clearStopTimer = (): void => {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
  };
  const isIdle = (): boolean =>
    ![...peers].some((peer) => !peer.observe) &&
    !remoteHost?.state().running &&
    busyCount() === 0 &&
    opening.size === 0 &&
    deleting.size === 0 &&
    !authOwner;

  const touchActivity = (): void => {
    idleSince = Date.now();
    if (!stopWhenIdle || stopping || !isIdle()) {
      clearStopTimer();
      return;
    }
    if (!stopTimer) {
      stopTimer = setTimeout(
        () => {
          stopTimer = null;
          if (!stopping && stopWhenIdle && isIdle()) void close("shutdown");
        },
        hasConnectedPeer ? 200 : 5000,
      );
      stopTimer.unref?.();
    }
  };

  const client = createRuntimeClient({
    ...options,
    rindHome,
    cwd: paths.directory,
    cliArgs: [],
    env: { RIND_SHARED_HOST_PID: String(process.pid) },
    onMessage(rawEvent) {
      let event = rawEvent;
      if (event?.method === "rind/auth/update") {
        authOwner?.send({ event });
        return;
      }
      const type = event?.event?.type;
      if (
        type === "turn_started" &&
        Number(event.event.user_message_chars) > 0 &&
        pendingPromptTexts.has(event.session_id)
      ) {
        const pending = pendingPromptTexts.get(event.session_id)!;
        pendingPromptTexts.delete(event.session_id);
        event = {
          ...event,
          event: {
            ...event.event,
            input: event.event.input || pending.input,
            ...(pending.clientInputId
              ? { client_input_id: event.event.client_input_id || pending.clientInputId }
              : {}),
            ...(pending.remote ? { remote_origin: true } : {}),
          },
        };
      }
      live.event(event);
      const observeEvent =
        OBSERVE_EVENTS.has(type) ||
        (type === "tool_result" && event.event.tool_name === "ask_user_question");
      for (const peer of peers) {
        if (peer.sessions.has(event.session_id) || (peer.observe && observeEvent)) {
          peer.send({ event });
        }
      }
      for (const listener of remoteEventListeners) {
        try {
          listener(event);
        } catch {
          // Ignore listener failure.
        }
      }
      if (type === "session_discarded" || type === "session_deleted") {
        live.forget(event.session_id);
        for (const peer of peers) peer.sessions.delete(event.session_id);
      }
      if (isIdle()) touchActivity();
    },
    onRequest(prompt) {
      return new Promise<string>((resolve) => {
        if (!authOwner || authOwner.socket.destroyed) {
          resolve("");
          return;
        }
        auth.set(prompt.request_id, { peer: authOwner, resolve });
        authOwner.send({ prompt });
      });
    },
    onStderr: writeStderr,
    onExit() {
      live.reset();
      initialized = null;
      if (stopping) return;
      for (const peer of peers) peer.socket.destroy();
      void close("worker_exit");
    },
  });

  async function deliver(
    sessionId: string,
    input: string,
  ): Promise<{ delivered: "window" | "queued" }> {
    if (!sessionId || !input.trim()) {
      throw Object.assign(new Error("A session and a non-empty prompt are required."), {
        code: "INVALID_INPUT",
      });
    }
    const window = live.newestViewer(
      sessionId,
      (other) => Boolean(other.acceptsInput) && peers.has(other),
    );
    if (window) {
      window.send({ deliver: { session_id: sessionId, input } });
      return { delivered: "window" };
    }
    if (live.turn(sessionId) === "idle") {
      throw Object.assign(
        new Error("No Rind window has session " + sessionId + " open, and it is not running."),
        { code: "SESSION_NOT_OPEN" },
      );
    }
    await initialize();
    await client.request("rind/session/follow_up", { session_id: sessionId, input });
    return { delivered: "queued" };
  }

  const viewIfOpen = (peer: PeerState, id: string, details?: { workspace?: string }): void => {
    if (peers.has(peer)) live.view(peer, id, details);
  };
  const writeRecord = (pid: number | null = workerPid): Promise<void> =>
    writeFile(
      paths.record,
      JSON.stringify({
        pid: process.pid,
        ...(pid ? { workerPid: pid } : {}),
        nonce: recordNonce,
        startedAt,
      }),
      { mode: 0o600 },
    );
  const initialize = (): Promise<any> =>
    (initialized ||= (async () => {
      const child = client.start();
      workerPid = child?.pid || null;
      await writeRecord(workerPid).catch(() => {});
      await writeLog("worker started", { pid: process.pid, workerPid });
      return client.request("initialize");
    })().catch((error) => {
      initialized = undefined;
      throw error;
    }));

  function attachIdleWindowPeersToSession(sessionId: string, workspaceRoot: string): void {
    if (!sessionId) return;
    for (const p of peers) {
      if (
        p.window &&
        !p.observe &&
        p.sessions.size === 0 &&
        (!workspaceRoot || !p.workspace || samePath(p.workspace, workspaceRoot))
      ) {
        p.sessions.add(sessionId);
        viewIfOpen(p, sessionId, workspaceRoot ? { workspace: workspaceRoot } : undefined);
      }
    }
  }

  async function requestFromRemote(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<any> {
    if (method === "session/subscribe" || method === "session/unsubscribe") return { ok: true };
    const base = await initialize();
    if (method === "initialize") return base;
    const sid = String(params.session_id || "");
    if (method === "session/prompt") {
      if (
        !prompts.has(sid) &&
        live.turn(sid) === "idle" &&
        typeof params.input === "string" &&
        params.input.trim() &&
        !params.resume
      ) {
        pendingPromptTexts.set(sid, {
          input: params.input,
          clientInputId: params.client_input_id,
          remote: true,
        });
      }
      holdPrompt(prompts, sid);
      attachIdleWindowPeersToSession(sid, sessionWorkspaces.get(sid) || "");
      let promptFailed = false;
      let result: any;
      try {
        result = await client.request(method, params);
        return result;
      } catch (error) {
        promptFailed = true;
        throw error;
      } finally {
        pendingPromptTexts.delete(sid);
        releasePrompt(prompts, sid);
        if (!result?.steered && !prompts.has(sid)) live.settle(sid, promptFailed);
        if (isIdle()) touchActivity();
      }
    }
    const result = await client.request(method, params);
    if (["session/open", "session/new", "session/switch", "session/create"].includes(method)) {
      const nextSid = String(result?.session_id || sid || "");
      const ws = String(result?.workspace_root || params.workspace_root || "");
      if (nextSid && ws) sessionWorkspaces.set(nextSid, ws);
      if (nextSid) attachIdleWindowPeersToSession(nextSid, ws);
    }
    return result;
  }

  const getRemoteHost = (): RemoteHost =>
    (remoteHost ||= createRemoteHost({
      getRindHome: () => rindHome,
      repoRoot: options.repoRoot,
      getRuntimePath: () => options.runtimePath || "",
      initializeRuntime: () => initialize(),
      requestRuntime: (method, params) => requestFromRemote(method, params),
      subscribeRuntime: (listener) => {
        remoteEventListeners.add(listener);
        return () => remoteEventListeners.delete(listener);
      },
      ensureRuntimeForWorkspace: async () => {
        await initialize();
      },
      isSharedRuntime: () => true,
      allowSharedObserver: false,
      allowMissingWebRoot: true,
      onStateChange: (state) => {
        for (const p of peers) p.send({ event: { kind: "remote", state } });
      },
    }));

  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  ready.catch(() => {});

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    const peer: PeerState = {
      socket,
      sessions: new Set(),
      prompts: new Map(),
      requestPrompts: new Map(),
      observe: false,
      oneShot: false,
      window: false,
      workspace: "",
      send(message) {
        if (!socket.destroyed) {
          if (socket.writableLength > 32 * 1024 * 1024) socket.destroy();
          else socket.write(JSON.stringify(message) + "\n");
        }
      },
    };
    peers.add(peer);
    touchActivity();
    socket.on("error", () => {});
    socket.on("close", () => {
      peers.delete(peer);
      live.leave(peer);
      if (initialized) {
        const toCancel = new Set([
          ...(peer.oneShot ? peer.prompts.keys() : []),
          ...peer.requestPrompts.keys(),
        ]);
        for (const sessionId of toCancel) {
          void client.request("session/cancel", { session_id: sessionId }).catch(() => {});
        }
      }
      for (const [id, entry] of auth) {
        if (entry.peer === peer) {
          entry.resolve("");
          auth.delete(id);
        }
      }
      if (peer.window && remoteHost && ![...peers].some((other) => other.window)) {
        void remoteHost.stop().catch(() => {});
      }
      if (isIdle()) touchActivity();
    });

    const lines = createLineBuffer(
      (line) => {
        void handle(line);
      },
      { maxBytes: 32 * 1024 * 1024, onOverflow: () => socket.destroy() },
    );
    socket.on("data", (chunk: string) => {
      lines.push(chunk);
    });

    async function handle(line: string): Promise<void> {
      let id: unknown;
      let sessionId = "";
      let holdsSession = false;
      let deletesSession = false;
      try {
        await ready;
        const message = JSON.parse(line);
        id = message.id;
        if (message.token !== token) throw new Error("Invalid Runtime credentials.");
        if (message.authReply) {
          const entry = auth.get(message.authReply);
          if (entry?.peer === peer) {
            auth.delete(message.authReply);
            entry.resolve(String(message.value ?? ""));
          }
          return;
        }
        const { method, params = {} } = message;
        if (
          typeof method !== "string" ||
          !params ||
          typeof params !== "object" ||
          Array.isArray(params)
        ) {
          throw new Error("Expected a method and params object.");
        }
        if (stopping) throw new Error("Runtime is shutting down.");
        sessionId = String(params.session_id || "");
        if (sessionId && deleting.has(sessionId)) {
          throw Object.assign(new Error("This conversation is being deleted."), {
            code: "SESSION_BUSY",
          });
        }
        if (method === "session/delete" && sessionId) {
          if (opening.has(sessionId) || prompts.has(sessionId) || live.turn(sessionId) !== "idle") {
            throw Object.assign(
              new Error("This conversation is running or being opened. Wait before deleting it."),
              { code: "SESSION_BUSY" },
            );
          }
          if (live.newestViewer(sessionId)) {
            throw Object.assign(
              new Error(
                "A Rind window is showing this conversation. Close it before deleting it.",
              ),
              { code: "SESSION_OPEN" },
            );
          }
          deleting.add(sessionId);
          deletesSession = true;
        } else if (
          sessionId &&
          [
            "session/open",
            "session/switch",
            "session/create",
            "session/subscribe",
            "session/prompt",
            "rind/session/compact",
          ].includes(method)
        ) {
          opening.set(sessionId, (opening.get(sessionId) || 0) + 1);
          holdsSession = true;
        }
        if (method === "runtime/info") {
          const attached = [...peers].filter(
            (other) => other !== peer && other.sessions.size > 0,
          ).length;
          peer.send({
            id,
            result: {
              buildId: await build,
              pid: process.pid,
              startedAt,
              busy: busyCount(),
              attached,
              observed: [...peers].some((other) => other !== peer && other.observe),
            },
          });
          return;
        }
        if (method === "runtime/sessions") {
          peer.send({ id, result: { sessions: live.list() } });
          return;
        }
        if (method === "runtime/accept-input") {
          peer.acceptsInput = true;
          peer.send({ id, result: { ok: true } });
          return;
        }
        if (method === "runtime/visibility") {
          if (params.visible === false) live.hide(peer);
          else live.show(peer, (sid) => !deleting.has(sid));
          peer.send({ id, result: { ok: true } });
          return;
        }
        if (method === "runtime/send") {
          peer.send({
            id,
            result: await deliver(String(params.session_id || ""), String(params.input || "")),
          });
          return;
        }
        if (method === "remote/get") {
          if (!peer.oneShot) peer.window = true;
          peer.send({ id, result: remoteHost ? remoteHost.state() : STOPPED_REMOTE_STATE });
          return;
        }
        if (method === "remote/start") {
          if (!peer.oneShot) peer.window = true;
          if (typeof params.workspace_root === "string" && params.workspace_root.trim()) {
            await registerSharedWorkspace(rindHome, params.workspace_root.trim(), {
              setActive: true,
            }).catch(() => {});
          }
          peer.send({ id, result: await getRemoteHost().start(params as Partial<RemoteOptions>) });
          return;
        }
        if (method === "remote/stop") {
          peer.send({ id, result: remoteHost ? await remoteHost.stop() : STOPPED_REMOTE_STATE });
          return;
        }
        if (method === "remote/rotate") {
          if (!remoteHost) throw new Error("Enable remote access first.");
          peer.send({ id, result: remoteHost.rotate() });
          return;
        }
        if (method === "remote/allow-network") {
          if (!remoteHost) throw new Error("Enable local-network access first.");
          peer.send({ id, result: await remoteHost.allowNetwork(process.execPath) });
          return;
        }
        if (method === "remote/workspaces-changed") {
          peer.send({
            id,
            result: remoteHost ? remoteHost.notifyWorkspacesChanged() : STOPPED_REMOTE_STATE,
          });
          return;
        }
        if (method === "runtime/shutdown") {
          if (params.if_idle) {
            const attached = [...peers].some((other) => other !== peer && !other.observe);
            if (
              attached ||
              busyCount() > 0 ||
              opening.size > 0 ||
              deleting.size > 0 ||
              authOwner
            ) {
              peer.send({ id, result: { stopped: false, busy: busyCount() } });
              return;
            }
          }
          stopping = true;
          await remoteHost?.close().catch(() => {});
          if (initialized) {
            try {
              await client.shutdown();
            } catch (error) {
              writeStderr(
                "runtime shutdown: " + ((error as Error)?.message || String(error)) + "\n",
              );
            }
          }
          peer.send({ id, result: { stopped: true } });
          await close("shutdown");
          return;
        }

        const base = await initialize();
        let result: any;
        if (method !== "runtime/observe") hasConnectedPeer = true;
        if (method === "initialize") {
          if (!peer.oneShot) peer.window = true;
          result = base;
        } else if (method === "runtime/observe") {
          peer.observe = true;
          result = { pid: client.child?.pid };
        } else if (method === "shutdown") {
          result = { detached: true };
          peer.sessions.clear();
          live.leave(peer);
        } else {
          if (["session/open", "session/create", "session/subscribe"].includes(method)) {
            if (params.one_shot === true) {
              peer.oneShot = true;
              peer.window = false;
              if (params.stop_when_idle === true) stopWhenIdle = true;
            } else if (!peer.oneShot) {
              stopWhenIdle = false;
              if (!peer.observe) peer.window = true;
            }
          }
          const {
            one_shot: _oneShot,
            stop_when_idle: _stopWhenIdle,
            ...workerParams
          } = params as Record<string, any>;
          if (
            typeof workerParams.workspace_root === "string" &&
            workerParams.workspace_root.trim() &&
            !peer.observe &&
            !peer.oneShot
          ) {
            peer.workspace = workerParams.workspace_root.trim();
            if (["session/open", "session/create", "session/new"].includes(method)) {
              void registerSharedWorkspace(rindHome, peer.workspace, { setActive: true })
                .then(() => remoteHost?.notifyWorkspacesChanged())
                .catch(() => {});
            }
          }
          if (method === "session/prompt") {
            if (
              !prompts.has(sessionId) &&
              live.turn(sessionId) === "idle" &&
              typeof workerParams.input === "string" &&
              workerParams.input.trim() &&
              !workerParams.resume
            ) {
              pendingPromptTexts.set(sessionId, {
                input: workerParams.input,
                clientInputId: workerParams.client_input_id,
                remote: false,
              });
            }
            holdPrompt(prompts, sessionId);
            holdPrompt(peer.prompts, sessionId);
            if (workerParams.completion_scope === "request") {
              holdPrompt(peer.requestPrompts, sessionId);
            }
            viewIfOpen(peer, sessionId);
          }
          if (method === "rind/auth/login") {
            if (authOwner) throw new Error("Another connection is signing in.");
            authOwner = peer;
          }
          if (method === "session/subscribe" || method === "session/prompt") {
            peer.sessions.add(sessionId);
          }
          if (method === "session/unsubscribe") {
            peer.sessions.delete(sessionId);
            live.leave(peer, sessionId);
            result = { ok: true };
          }
          let promptFailed = false;
          try {
            if (method !== "session/unsubscribe") {
              result = await client.request(method, workerParams);
            }
          } catch (error) {
            promptFailed = true;
            throw error;
          } finally {
            if (method === "rind/auth/login") authOwner = null;
            if (method === "session/prompt") {
              pendingPromptTexts.delete(sessionId);
              releasePrompt(prompts, sessionId);
              releasePrompt(peer.prompts, sessionId);
              if (workerParams.completion_scope === "request") {
                releasePrompt(peer.requestPrompts, sessionId);
              }
              if (!result?.steered && !prompts.has(sessionId)) {
                live.settle(sessionId, promptFailed);
              }
            }
          }
          if (
            ["session/open", "session/new", "session/switch", "session/create"].includes(method) &&
            result?.session_id
          ) {
            peer.sessions.add(result.session_id);
            const ws = result.workspace_root || workerParams.workspace_root || "";
            if (ws) sessionWorkspaces.set(result.session_id, ws);
            viewIfOpen(peer, result.session_id, { workspace: result.workspace_root });
          }
        }
        peer.send({ id, result });
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        peer.send({ id, error: { message: err.message, code: err.code } });
      } finally {
        if (deletesSession) deleting.delete(sessionId);
        if (holdsSession) {
          const count = (opening.get(sessionId) || 1) - 1;
          if (count > 0) opening.set(sessionId, count);
          else opening.delete(sessionId);
        }
        if (isIdle()) touchActivity();
      }
    }
  });

  try {
    await listenOwned(server, paths.endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENDPOINT_OCCUPIED") {
      throw Object.assign(new Error("Shared Runtime is already running."), {
        code: "ALREADY_RUNNING",
      });
    }
    throw error;
  }

  try {
    try {
      token = (await readFile(paths.token, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!token) {
      const candidate = randomBytes(32).toString("hex");
      const draft = paths.token + "." + randomUUID() + ".tmp";
      await writeFile(draft, candidate, { mode: 0o600, flag: "wx" });
      try {
        await link(draft, paths.token);
        token = candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        token = (await readFile(paths.token, "utf8")).trim();
      } finally {
        await unlink(draft).catch(() => {});
      }
    }
    if (!token) throw new Error("Shared Runtime credentials are empty.");
    recordNonce = options.hostNonce || randomUUID();
    await writeRecord();
    await writeLog("host started", { pid: process.pid, rindHome, endpoint: paths.endpoint });
    if (hostEntry || options.idleTtlMs !== undefined) {
      const checkMs = Math.max(50, Math.min(idleTtlMs || 1000, 1000));
      idleTimer = setInterval(async () => {
        if (stopping) return;
        const owner = await recordedNonce(paths.record);
        if (owner && owner !== recordNonce) {
          void close("superseded");
          return;
        }
        if (!isIdle()) {
          touchActivity();
          return;
        }
        if (owner !== recordNonce) {
          void close("record_removed");
          return;
        }
        if (idleTtlMs > 0 && Date.now() - idleSince >= idleTtlMs) void close("idle_timeout");
      }, checkMs);
      idleTimer.unref?.();
    }
    touchActivity();
    readyResolve();
  } catch (error) {
    readyReject(error);
    for (const peer of peers) peer.socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  async function releaseRecord(): Promise<void> {
    if ((await recordedNonce(paths.record)) === recordNonce) {
      await unlink(paths.record).catch(() => {});
    }
  }

  function close(reason = "shutdown"): Promise<void> {
    return (closing ||= (async () => {
      stopping = true;
      clearStopTimer();
      if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
      const forced = setTimeout(() => {
        for (const peer of peers) peer.socket.destroy();
      }, 1000);
      forced.unref?.();
      for (const peer of peers) peer.socket.end();
      await remoteHost?.close().catch(() => {});
      try {
        if (initialized) await client.shutdown();
      } catch {
        // Worker already exited or refused; host still exits.
      }
      client.forceShutdown();
      if (reason !== "record_removed") {
        await writeLog("host stopped", { pid: process.pid, workerPid, reason });
      }
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const peer of peers) peer.socket.destroy();
      await closed;
      clearTimeout(forced);
      await releaseRecord();
      if (hostEntry) process.exit(0);
    })());
  }

  return { paths, close };
}

if (hostEntry) {
  startSharedServer({
    ...JSON.parse(process.argv[2] || "{}"),
    hostNonce: process.argv[3]?.replace(/^--rind-host-nonce=/, ""),
  })
    .then((server) => {
      const stop = (signal: string) => {
        void server.close(signal);
      };
      process.once("SIGTERM", () => stop("SIGTERM"));
      process.once("SIGINT", () => stop("SIGINT"));
    })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException)?.code !== "ALREADY_RUNNING") {
        writeStderr(String((error as Error)?.stack || error) + "\n");
      }
      process.exitCode = 1;
    });
}
