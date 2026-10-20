import { startServer } from "./ipc.js";
try {
  const server = await startServer({ ...JSON.parse(process.argv[2] || "{}"), serviceNonce: process.argv[3]?.replace(/^--rind-service-nonce=/, ""), onShutdown: () => setImmediate(() => process.exit(0)) });
  const stop = (signal: string) => server.close(signal).finally(() => process.exit(0));
  process.once("SIGTERM", () => { void stop("SIGTERM"); });
  process.once("SIGINT", () => { void stop("SIGINT"); });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" && (error as { code?: string }).code !== "ALREADY_RUNNING") console.error(error);
  process.exitCode = 1;
}
