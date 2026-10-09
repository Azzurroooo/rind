import { connectClient } from "./client.js";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let client;
try {
  const input = JSON.parse(raw);
  client = await connectClient({ endpoint: process.env.RIND_MANAGEMENT_ENDPOINT!, token: process.env.RIND_MANAGEMENT_TOKEN!, runtimeSessionId: input.runtimeSessionId });
  // agent_management carries its operation inside; every other tool is the operation.
  const [method, params] = input.method === "agent_management" ? [input.params?.action, input.params?.parameters || {}] : [input.method, input.params || {}];
  const result = await client.request(method, params);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  const failure = error as Error & { code?: string; details?: unknown };
  process.stdout.write(JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message, details: failure.details } }));
} finally { client?.close(); }
