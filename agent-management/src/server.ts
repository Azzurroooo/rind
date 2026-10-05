import { startServer } from "./ipc.js";
try {
  const server = await startServer({ ...JSON.parse(process.argv[2] || "{}"), onShutdown: () => setImmediate(() => process.exit(0)) });
  const stop = () => server.close();
  process.on("SIGTERM", () => { void stop(); });
  process.on("SIGINT", () => { void stop(); });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" && (error as { code?: string }).code !== "ALREADY_RUNNING") console.error(error);
  process.exitCode = 1;
}
