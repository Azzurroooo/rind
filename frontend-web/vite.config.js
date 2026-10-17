import { open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "..");

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
              const runtimeSessionId = typeof params.runtimeSessionId === "string" ? params.runtimeSessionId.trim() : "";
              const attached = await active.request("attachSession", {
                ...(agentId ? { agentId } : {}),
                ...(teamId ? { teamId } : {}),
                ...(manager ? { manager: true } : {}),
                ...(runtimeSessionId ? { runtimeSessionId } : {}),
                shared: false,
              });
              const snap = await active.request("snapshot");
              if (snap && typeof snap === "object") snapshot = { ...snapshot, ...snap };
              const { managementPaths, resolveRindHome } = await loadManagement();
              const agentRecord = snapshot.agents.find((a) => a.id === attached.agentId);
              const workspaceRoot = String(
                agentRecord?.canonicalWorkspace ||
                  (manager ? managementPaths(resolveRindHome(process.env.RIND_HOME)).manager : params.workspace || ""),
              );
              broadcast();
              result = {
                managementSessionId: String(attached.id),
                agentId: String(attached.agentId || agentId),
                teamId: String(attached.teamId || teamId),
                manager,
                workspaceRoot,
                runtimeSessionId,
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
