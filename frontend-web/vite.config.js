import { realpathSync } from "node:fs";
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

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function rindAgentsDevPlugin() {
  return {
    name: "rind-agents-dev-bridge",
    configureServer(server) {
      let bridgePromise;
      const sseClients = new Set();

      function loadBridge() {
        if (!bridgePromise) {
          const hostUrl = pathToFileURL(join(repoRoot, "rind-runtime-client", "remote", "host.js")).href;
          const mgmtUrl = pathToFileURL(join(repoRoot, "rind-runtime-client", "remote", "management.js")).href;
          bridgePromise = Promise.all([import(hostUrl), import(mgmtUrl)])
            .then(([host, mgmt]) => {
              const management = mgmt.createManagementBridge({
                getRindHome: () => host.resolveRindHome(process.env.RIND_HOME),
                repoRoot,
                getRuntimePath: () => process.env.RIND_RUNTIME_PATH || "",
                isSharedRuntime: () => false,
                autoStartOnGetState: true,
              });
              management.subscribeManagement((state) => {
                const payload = `data: ${JSON.stringify(state)}\n\n`;
                for (const res of sseClients) {
                  try {
                    res.write(payload);
                  } catch {
                    sseClients.delete(res);
                  }
                }
              });
              server.httpServer?.once("close", () => {
                void management.closeManagement().catch(() => {});
              });
              return {
                resolveRindHome: host.resolveRindHome,
                loadRuntimeSettings: host.loadRuntimeSettings,
                saveRuntimeSettings: host.saveRuntimeSettings,
                management,
              };
            })
            .catch((error) => {
              bridgePromise = undefined;
              throw error;
            });
        }
        return bridgePromise;
      }

      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        if (req.url === "/api/settings" && (req.method === "GET" || req.method === "POST")) {
          try {
            const { resolveRindHome, loadRuntimeSettings, saveRuntimeSettings } = await loadBridge();
            const rindHome = resolveRindHome(process.env.RIND_HOME);
            const result =
              req.method === "GET"
                ? await loadRuntimeSettings(rindHome)
                : await saveRuntimeSettings(await readJsonBody(req), rindHome);
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
          req.on("close", () => sseClients.delete(res));
          try {
            const { management } = await loadBridge();
            res.write(`data: ${JSON.stringify(management.getManagementState())}\n\n`);
            void management.ensureManagementConnected({ start: true }).catch(() => {});
          } catch {
            // Keep SSE open; offline state is reported on next retry.
          }
          return;
        }
        if (req.url === "/api/agents" && req.method === "POST") {
          let body;
          try {
            body = await readJsonBody(req);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON." }));
            return;
          }
          const method = String(body?.method || "");
          const params = body?.params && typeof body.params === "object" ? body.params : {};
          try {
            const { management } = await loadBridge();
            const result = await management.requestManagement(method, params);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result }));
          } catch (error) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: {
                  message: error?.message || String(error),
                  type: error?.name || "ManagementError",
                },
              }),
            );
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
