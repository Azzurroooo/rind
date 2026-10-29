const response = await fetch("http://127.0.0.1:8765/healthz", { signal: AbortSignal.timeout(2000) });
if (response.status !== 200) {
  process.exit(1);
}
