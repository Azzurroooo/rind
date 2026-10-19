import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "..");
const fsAllow = [currentDir, repoRoot];
try {
  fsAllow.push(realpathSync(resolve(currentDir, "node_modules")));
} catch {
  // Ignore if node_modules does not exist yet
}

const VALID_EFFORTS = new Set(["", "low", "medium", "high", "xhigh", "max"]);
const VALID_APIS = new Set([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

function maskSecret(raw) {
  const clean = typeof raw === "string" ? raw.trim() : "";
  if (!clean) return "";
  if (clean.length <= 8) return "••••••••";
  const prefix = clean.slice(0, Math.min(4, clean.indexOf("-") > 0 ? clean.indexOf("-") + 1 : 3));
  return `${prefix}••••${clean.slice(-4)}`;
}

async function readJsonSafe(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeJsonSafe(filePath, data, secret = false) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: secret ? 0o600 : 0o666,
    });
    if (secret && process.platform !== "win32") {
      await chmod(tmp, 0o600).catch(() => {});
    }
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function loadLocalSettings(rindHome) {
  const settingsPath = join(rindHome, "settings.json");
  const authPath = join(rindHome, "auth.json");
  const providersPath = join(rindHome, "providers.json");
  const [settingsData, authData, providersData] = await Promise.all([
    readJsonSafe(settingsPath),
    readJsonSafe(authPath),
    readJsonSafe(providersPath),
  ]);
  const provider = String(settingsData.provider || "").trim() || "openai";
  const model = String(settingsData.model || "").trim() || "gpt-4o-mini";
  const rawEffort = String(settingsData.reasoningEffort || "").trim().toLowerCase();
  const reasoningEffort = VALID_EFFORTS.has(rawEffort) ? rawEffort : "";

  const authDetails = {};
  for (const [id, entry] of Object.entries(authData)) {
    if (!id.trim() || !entry || typeof entry !== "object") continue;
    const type = String(entry.type || "").trim();
    if (type === "oauth" && (entry.access || entry.refresh)) {
      authDetails[id.trim()] = {
        type: "oauth",
        expiresAt: typeof entry.expires_at === "number" ? entry.expires_at : null,
      };
    } else if ((type === "api_key" || !type) && String(entry.key || "").trim()) {
      authDetails[id.trim()] = {
        type: "api_key",
        maskedKey: maskSecret(String(entry.key)),
      };
    }
  }

  const rawProviders =
    providersData.providers && typeof providersData.providers === "object"
      ? providersData.providers
      : providersData;
  const customProviders = [];
  for (const [id, entry] of Object.entries(rawProviders)) {
    if (!id.trim() || !entry || typeof entry !== "object") continue;
    const baseUrl = String(entry.baseUrl || "").trim().replace(/\/+$/, "");
    if (!baseUrl) continue;
    const modelsObj = entry.models && typeof entry.models === "object" ? entry.models : {};
    customProviders.push({
      id: id.trim(),
      name: String(entry.name || id).trim(),
      api: String(entry.api || "openai-chat").trim(),
      baseUrl,
      ...(entry.envKey ? { envKey: String(entry.envKey).trim() } : {}),
      models: Object.keys(modelsObj).map((m) => m.trim()).filter(Boolean),
    });
  }

  const matchingCustom = customProviders.find((item) => item.id === provider);
  const baseUrl = matchingCustom?.baseUrl || String(settingsData.baseUrl || "").trim();
  const hasApiKey = Boolean(
    settingsData.provider ||
      settingsData.model ||
      settingsData.apiKey ||
      Object.keys(authDetails).length > 0 ||
      customProviders.length > 0,
  );
  return {
    provider,
    model,
    baseUrl,
    reasoningEffort,
    hasApiKey,
    authDetails,
    customProviders,
  };
}

async function saveLocalSettings(rindHome, patch = {}) {
  const settingsPath = join(rindHome, "settings.json");
  const authPath = join(rindHome, "auth.json");
  const providersPath = join(rindHome, "providers.json");

  if (
    patch.provider !== undefined ||
    patch.model !== undefined ||
    patch.reasoningEffort !== undefined
  ) {
    const settingsData = await readJsonSafe(settingsPath);
    if (typeof patch.provider === "string" && patch.provider.trim()) {
      settingsData.provider = patch.provider.trim();
    } else if (!settingsData.provider) {
      settingsData.provider = "openai";
    }
    if (typeof patch.model === "string" && patch.model.trim()) {
      settingsData.model = patch.model.trim();
    } else if (!settingsData.model) {
      settingsData.model = "gpt-4o-mini";
    }
    if (typeof patch.reasoningEffort === "string") {
      const eff = patch.reasoningEffort.trim().toLowerCase();
      if (!VALID_EFFORTS.has(eff)) throw new Error(`Invalid reasoning effort: ${patch.reasoningEffort}`);
      settingsData.reasoningEffort = eff;
    }
    await writeJsonSafe(settingsPath, settingsData, false);
  }

  if (patch.customProvider && typeof patch.customProvider === "object") {
    const cp = patch.customProvider;
    const name = String(cp.name || "").trim();
    if (!name) throw new Error("Connection name is required.");
    const rawId = String(cp.id || name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    if (!rawId) throw new Error("Connection name needs at least one letter or digit.");
    const api = String(cp.api || "openai-chat").trim();
    if (!VALID_APIS.has(api)) throw new Error(`Unsupported protocol: ${api}`);
    const baseUrl = String(cp.baseUrl || "").trim().replace(/\/+$/, "");
    let parsedUrl;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      throw new Error("Base URL must be a valid HTTP(S) URL.");
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Base URL must be a valid HTTP(S) URL.");
    }
    const root = await readJsonSafe(providersPath);
    const providersMap =
      root.providers && typeof root.providers === "object"
        ? { ...root.providers }
        : { ...root };
    delete providersMap.providers;
    const existing = providersMap[rawId] && typeof providersMap[rawId] === "object" ? providersMap[rawId] : {};
    const entry = { name, api, baseUrl };
    const envKey = String(cp.envKey || existing.envKey || "").trim();
    if (envKey) entry.envKey = envKey;
    const models = existing.models && typeof existing.models === "object" ? { ...existing.models } : {};
    const defaultModel = String(cp.defaultModel || "").trim();
    if (defaultModel) models[defaultModel] = models[defaultModel] || {};
    if (Object.keys(models).length > 0) entry.models = models;
    providersMap[rawId] = entry;
    await writeJsonSafe(providersPath, { providers: providersMap }, false);

    const apiKey = String(cp.apiKey || "").trim();
    if (apiKey) {
      const authData = await readJsonSafe(authPath);
      authData[rawId] = { type: "api_key", key: apiKey };
      await writeJsonSafe(authPath, authData, true);
    }
  }

  if (typeof patch.deleteCustomProviderId === "string" && patch.deleteCustomProviderId.trim()) {
    const targetId = patch.deleteCustomProviderId.trim();
    const root = await readJsonSafe(providersPath);
    const providersMap =
      root.providers && typeof root.providers === "object"
        ? { ...root.providers }
        : { ...root };
    delete providersMap.providers;
    if (Object.hasOwn(providersMap, targetId)) {
      delete providersMap[targetId];
      await writeJsonSafe(providersPath, { providers: providersMap }, false);
    }
    const authData = await readJsonSafe(authPath);
    if (Object.hasOwn(authData, targetId)) {
      delete authData[targetId];
      await writeJsonSafe(authPath, authData, true);
    }
  }

  if (patch.providerCredential && typeof patch.providerCredential === "object") {
    const providerId = String(patch.providerCredential.providerId || "").trim();
    const apiKey = String(patch.providerCredential.apiKey || "").trim();
    if (!providerId || !apiKey) throw new Error("Provider ID and API key are required.");
    const authData = await readJsonSafe(authPath);
    authData[providerId] = { type: "api_key", key: apiKey };
    await writeJsonSafe(authPath, authData, true);
  }

  if (typeof patch.removeProviderCredentialId === "string" && patch.removeProviderCredentialId.trim()) {
    const targetId = patch.removeProviderCredentialId.trim();
    const authData = await readJsonSafe(authPath);
    if (Object.hasOwn(authData, targetId)) {
      delete authData[targetId];
      await writeJsonSafe(authPath, authData, true);
    }
  }

  return loadLocalSettings(rindHome);
}

function rindAgentsDevPlugin() {
  return {
    name: "rind-agents-dev-bridge",
    configureServer(server) {
      let client = null;
      let connecting = null;
      let snapshot = {
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
      let connection = "connecting";
      let service = null;
      let explicitlyStopped = false;
      const sseClients = new Set();

      function currentState() {
        return { snapshot, connection, service };
      }

      function broadcast() {
        const payload = `data: ${JSON.stringify(currentState())}\n\n`;
        for (const res of sseClients) {
          try {
            res.write(payload);
          } catch {
            sseClients.delete(res);
          }
        }
      }

      async function loadManagement() {
        const modUrl = pathToFileURL(join(repoRoot, "agent-management", "dist", "client.js")).href;
        const envUrl = pathToFileURL(join(repoRoot, "rind-runtime-client", "runtime-env.js")).href;
        const filesUrl = pathToFileURL(join(repoRoot, "rind-runtime-client", "local-files.js")).href;
        const [mgmt, runtimeEnv, localFiles] = await Promise.all([
          import(modUrl),
          import(envUrl),
          import(filesUrl),
        ]);
        return { ...mgmt, ...runtimeEnv, ...localFiles };
      }

      async function ensureConnected({ start = true } = {}) {
        if (client && connection === "connected") return client;
        if (connecting) return connecting;
        if (!start && explicitlyStopped) throw new Error("Agents management is stopped.");
        connection = client ? "reconnecting" : "connecting";
        broadcast();
        connecting = (async () => {
          const { connectManagement, buildRuntimeEnv, resolveSourcePython, resolveRindHome } = await loadManagement();
          const home = resolveRindHome(process.env.RIND_HOME);
          const runtimePath = process.env.RIND_RUNTIME_PATH || "";
          const python = runtimePath ? undefined : resolveSourcePython(process.env.RIND_PYTHON, repoRoot);
          buildRuntimeEnv(repoRoot, process.env, { sourceRuntime: !runtimePath, rindHome: home });
          const connected = await connectManagement({
            home,
            python,
            repoRoot,
            runtimePath,
            start,
            onSnapshot(next) {
              if (next && typeof next === "object") {
                snapshot = { ...snapshot, ...next };
                broadcast();
              }
            },
            onDisconnect() {
              client = null;
              connection = explicitlyStopped ? "stopped" : "offline";
              service = null;
              broadcast();
            },
          });
          client = connected;
          explicitlyStopped = false;
          connection = "connected";
          service = connected.service ? { ...connected.service, ...(connected.stale ? { stale: connected.stale } : {}) } : null;
          const initial = await connected.request("subscribe", { afterSeq: snapshot.seq || 0 });
          if (initial && typeof initial === "object") snapshot = { ...snapshot, ...initial };
          broadcast();
          return connected;
        })().catch((err) => {
          connection = explicitlyStopped ? "stopped" : "offline";
          broadcast();
          throw err;
        }).finally(() => {
          connecting = null;
        });
        return connecting;
      }

      function normalizeWorkspaceKey(target) {
        if (typeof target !== "string" || !target.trim()) return "";
        const resolved = resolve(target.trim()).replace(/[\\/]+$/, "");
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
      }

      async function listManagedSessionsLocal(params = {}) {
        const { managementPaths, resolveRindHome } = await loadManagement();
        const rindHome = resolveRindHome(process.env.RIND_HOME);
        const managerWorkspace = managementPaths(rindHome).manager;
        let runtimeSessions = [];
        try {
          const raw = JSON.parse(await readFile(join(rindHome, "session_index.json"), "utf8"));
          const map = raw && typeof raw === "object" && raw.sessions && typeof raw.sessions === "object"
            ? raw.sessions
            : raw && typeof raw === "object"
              ? raw
              : {};
          runtimeSessions = Object.entries(map)
            .filter(([, value]) => value && typeof value === "object")
            .map(([id, value]) => ({
              session_id: String(value.id || value.session_id || id),
              title: String(value.title || ""),
              updated_at: String(value.updated_at || value.created_at || ""),
              workspace_root: String(value.workspace_root || ""),
              message_count: Number(value.message_count || 0),
              last_model: String(value.last_model || ""),
              last_user_message: String(value.last_user_message || ""),
            }));
        } catch {
          runtimeSessions = [];
        }

        const byWorkspace = new Map();
        const byAgent = new Map();
        for (const agent of snapshot.agents || []) {
          byWorkspace.set(normalizeWorkspaceKey(agent.canonicalWorkspace), agent);
          if (typeof agent.id === "string") byAgent.set(agent.id, agent);
        }
        const byTeam = new Map();
        for (const team of snapshot.teams || []) {
          if (typeof team.id === "string") byTeam.set(team.id, team);
        }
        const byRuntimeSession = new Map();
        const connected = new Set(snapshot.connectedSessions || []);
        for (const session of snapshot.sessions || []) {
          const rId = typeof session.runtimeSessionId === "string" ? session.runtimeSessionId : "";
          if (!rId) continue;
          const prev = byRuntimeSession.get(rId);
          if (
            !prev ||
            (connected.has(String(session.id)) && !connected.has(String(prev.id))) ||
            String(session.updatedAt || "") > String(prev.updatedAt || "")
          ) {
            byRuntimeSession.set(rId, session);
          }
        }
        const runningBySession = new Set(
          (snapshot.runs || [])
            .filter((run) => run.status === "starting" || run.status === "running")
            .map((run) => String(run.runtimeSessionId || ""))
            .filter(Boolean),
        );
        const liveBySession = new Map();
        for (const item of snapshot.live || []) {
          if (typeof item.id === "string") liveBySession.set(item.id, item);
        }
        const managerKey = normalizeWorkspaceKey(managerWorkspace);

        const sessions = runtimeSessions
          .map((item) => {
            const runtimeSessionId = String(item.session_id || "");
            const record = byRuntimeSession.get(runtimeSessionId);
            const agent =
              (record && typeof record.agentId === "string" ? byAgent.get(record.agentId) : undefined) ||
              byWorkspace.get(normalizeWorkspaceKey(item.workspace_root));
            const isManager = Boolean(
              managerKey &&
                normalizeWorkspaceKey(item.workspace_root || agent?.canonicalWorkspace) === managerKey,
            );
            if (!agent && !isManager) return null;
            const memberships = agent
              ? (snapshot.memberships || []).filter((m) => m.agentId === agent.id)
              : [];
            const membership =
              (record?.teamId ? memberships.find((m) => m.teamId === record.teamId) : undefined) ||
              (params.teamId ? memberships.find((m) => m.teamId === params.teamId) : undefined) ||
              memberships[0];
            const team = membership ? byTeam.get(String(membership.teamId || "")) : undefined;
            const live = liveBySession.get(runtimeSessionId);
            const running =
              (live ? live.turn !== "idle" : false) || runningBySession.has(runtimeSessionId);
            const attached = Boolean(
              (live && Number(live.windows || 0) > 0) ||
                (record && connected.has(String(record.id || ""))),
            );
            return {
              runtimeSessionId,
              title: String(item.title || item.last_user_message || runtimeSessionId),
              updatedAt: String(item.updated_at || record?.updatedAt || ""),
              workspaceRoot: String(item.workspace_root || agent?.canonicalWorkspace || managerWorkspace || ""),
              agentId: String(agent?.id || ""),
              agentName: isManager ? "Manager" : String(agent?.displayName || ""),
              teamId: String(team?.id || record?.teamId || ""),
              teamName: String(team?.name || ""),
              roleTitle: isManager ? "Manager" : String(membership?.roleTitle || ""),
              manager: isManager,
              attached,
              running,
              status: running ? "working" : attached ? "open" : "idle",
              messageCount: Number(item.message_count || 0),
              model: String(item.last_model || ""),
              lastActivity: String(item.last_user_message || ""),
            };
          })
          .filter(Boolean)
          .filter((item) => (params.manager ? item.manager : true))
          .filter((item) => (params.agentId ? item.agentId === params.agentId : true))
          .filter((item) => (params.teamId ? item.teamId === params.teamId : true))
          .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

        return { sessions };
      }

      async function tailFile(filePath, maxBytes = 16384) {
        let handle;
        try {
          handle = await open(filePath, "r");
          const { size } = await handle.stat();
          const buffer = Buffer.alloc(Math.min(maxBytes, size));
          await handle.read(buffer, 0, buffer.length, size - buffer.length);
          const lines = buffer.toString("utf8").split(/\r?\n/);
          return (size > maxBytes ? lines.slice(1) : lines).slice(-80);
        } catch {
          return ["No log yet."];
        } finally {
          await handle?.close();
        }
      }

      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        if (req.url === "/api/settings" && (req.method === "GET" || req.method === "POST")) {
          try {
            const { resolveRindHome } = await loadManagement().catch(() => ({
              resolveRindHome: (h) => h || join(homedir(), ".rind"),
            }));
            const rindHome = resolveRindHome(process.env.RIND_HOME);
            if (req.method === "GET") {
              const result = await loadLocalSettings(rindHome);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ result }));
              return;
            }
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            const result = await saveLocalSettings(rindHome, body);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result }));
          } catch (error) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: error?.message || String(error) } }));
          }
          return;
        }
        if (req.url.startsWith("/api/agents/stream") && req.method === "GET") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          sseClients.add(res);
          res.write(`data: ${JSON.stringify(currentState())}\n\n`);
          void ensureConnected({ start: true }).catch(() => {});
          req.on("close", () => sseClients.delete(res));
          return;
        }
        if (req.url === "/api/agents" && req.method === "POST") {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let body = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON." }));
            return;
          }
          const method = String(body.method || "");
          const params = body.params && typeof body.params === "object" ? body.params : {};
          try {
            let result;
            if (method === "getState") {
              if (!client && !explicitlyStopped) await ensureConnected({ start: true }).catch(() => {});
              result = currentState();
            } else if (method === "reconnect") {
              explicitlyStopped = false;
              await ensureConnected({ start: true });
              result = currentState();
            } else if (method === "serviceLog") {
              const { managementPaths, resolveRindHome } = await loadManagement();
              const paths = managementPaths(resolveRindHome(process.env.RIND_HOME));
              const logPath = params.target === "runtime" ? join(dirname(paths.root), "runtime", "runtime.log") : join(paths.state, "service.log");
              result = { path: logPath, lines: await tailFile(logPath) };
            } else if (method === "listSessions") {
              if (!client && !explicitlyStopped) await ensureConnected({ start: true }).catch(() => {});
              result = await listManagedSessionsLocal(params);
            } else if (method === "restartService") {
              const active = await ensureConnected({ start: true });
              explicitlyStopped = true;
              await active.request("serviceShutdown", { restart: true });
              client?.close();
              client = null;
              await new Promise((r) => setTimeout(r, 250));
              explicitlyStopped = false;
              await ensureConnected({ start: true });
              result = currentState();
            } else if (method === "stopServices") {
              const stopAgents = Boolean(params.stopAgents);
              const active = await ensureConnected({ start: false }).catch(() => null);
              explicitlyStopped = true;
              if (active) {
                const shutdownRes = await active.request("serviceShutdown", { stopAgents });
                client?.close();
                client = null;
                connection = "stopped";
                service = null;
                if (stopAgents) snapshot = { ...snapshot, runs: [] };
                broadcast();
                result = { stopped: true, ...shutdownRes };
              } else {
                connection = "stopped";
                service = null;
                broadcast();
                result = { stopped: true, working: 0 };
              }
            } else if (method === "readArtifactPreview" || method === "readArtifact") {
              const active = await ensureConnected({ start: true });
              const artifact = await active.request("readArtifact", { artifactId: params.artifactId });
              if (artifact?.path) {
                try {
                  const data = await readFile(artifact.path);
                  result = data.includes(0)
                    ? { ...artifact, binary: true }
                    : { ...artifact, content: data.subarray(0, 262144).toString("utf8"), truncated: data.length > 262144 };
                } catch {
                  result = artifact;
                }
              } else {
                result = artifact;
              }
            } else if (method === "openSession") {
              const active = await ensureConnected({ start: true });
              const manager = params.manager === true;
              const teamId = typeof params.teamId === "string" && !manager ? params.teamId.trim() : "";
              const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
              let runtimeSessionId = typeof params.runtimeSessionId === "string" ? params.runtimeSessionId.trim() : "";
              if (!runtimeSessionId && params.resumeLatest === true) {
                const history = await listManagedSessionsLocal(
                  manager
                    ? { manager: true }
                    : {
                        ...(teamId ? { teamId } : {}),
                        ...(agentId ? { agentId } : {}),
                      },
                ).catch(() => ({ sessions: [] }));
                runtimeSessionId = String(history?.sessions?.[0]?.runtimeSessionId || "");
              }
              const attached = await active.request("attachSession", {
                ...(agentId ? { agentId } : {}),
                ...(teamId ? { teamId } : {}),
                ...(manager ? { manager: true } : {}),
                ...(runtimeSessionId ? { runtimeSessionId } : {}),
                shared: false,
              });
              const externalTools = await active.request("sessionTools", { sessionId: attached.id }).catch(() => null);
              if (runtimeSessionId && !attached.runtimeSessionId) {
                await active.request("bindSession", {
                  sessionId: attached.id,
                  runtimeSessionId,
                }).catch(() => {});
              }
              let snap = await active.request("snapshot");
              if (snap && typeof snap === "object") snapshot = { ...snapshot, ...snap };
              const { managementPaths, resolveRindHome } = await loadManagement();
              const agentRecord = snapshot.agents.find((a) => a.id === attached.agentId);
              const workspaceRoot = String(
                agentRecord?.canonicalWorkspace ||
                  (manager ? managementPaths(resolveRindHome(process.env.RIND_HOME)).manager : params.workspace || ""),
              );
              // Reconcile any stale unknown or idle direct runs on this agent/workspace so chatting is never blocked.
              const wsKey = normalizeWorkspaceKey(workspaceRoot);
              const matchingAgentIds = new Set([String(attached.agentId || agentId)].filter(Boolean));
              for (const ag of snapshot.agents || []) {
                if (typeof ag.id === "string" && wsKey && normalizeWorkspaceKey(ag.canonicalWorkspace) === wsKey) {
                  matchingAgentIds.add(ag.id);
                }
              }
              const sessionById = new Map();
              for (const s of snapshot.sessions || []) {
                if (typeof s.id === "string" && matchingAgentIds.has(String(s.agentId || ""))) {
                  sessionById.set(s.id, s);
                }
              }
              const liveRunningIds = new Set(
                (snapshot.live || [])
                  .filter((item) => item && typeof item.id === "string" && item.turn && item.turn !== "idle")
                  .map((item) => String(item.id)),
              );
              let reconciledAny = false;
              for (const run of snapshot.runs || []) {
                const s = sessionById.get(String(run.sessionId || ""));
                if (!s) continue;
                if (run.status === "unknown" && typeof run.id === "string") {
                  await active.request("resolveRun", { runId: run.id, confirmStopped: true }).catch(() => {});
                  reconciledAny = true;
                } else if (
                  !run.taskId &&
                  !run.delegationId &&
                  (run.status === "running" || run.status === "starting") &&
                  typeof run.sessionId === "string"
                ) {
                  const rSid = String(s.runtimeSessionId || "");
                  if (!rSid || !liveRunningIds.has(rSid)) {
                    await active.request("reconcileSession", {
                      sessionId: run.sessionId,
                      connected: true,
                      active: false,
                      outcome: "failed",
                    }).catch(() => {});
                    reconciledAny = true;
                  }
                }
              }
              if (reconciledAny) {
                snap = await active.request("snapshot").catch(() => null);
                if (snap && typeof snap === "object") snapshot = { ...snapshot, ...snap };
              }
              broadcast();
              result = {
                managementSessionId: String(attached.id),
                agentId: String(attached.agentId || agentId),
                teamId: String(attached.teamId || teamId),
                manager,
                workspaceRoot,
                runtimeSessionId: String(runtimeSessionId || attached.runtimeSessionId || ""),
                externalTools: externalTools || null,
              };
            } else {
              const active = await ensureConnected({ start: true });
              result = await active.request(method, params);
              if (method === "serviceInfo" && result && typeof result === "object") {
                service = { ...result, ...(active.stale ? { stale: active.stale } : {}) };
                broadcast();
              } else if (method !== "snapshot" && method !== "subscribe") {
                const snap = await active.request("snapshot").catch(() => null);
                if (snap && typeof snap === "object") {
                  snapshot = { ...snapshot, ...snap };
                  broadcast();
                }
              }
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result }));
          } catch (error) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: error?.message || String(error), type: error?.name || "ManagementError" } }));
          }
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), rindAgentsDevPlugin()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    fs: {
      strict: false,
      allow: fsAllow,
    },
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:8765",
        ws: true,
      },
      "/ticket": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{js,jsx}"],
  },
});
