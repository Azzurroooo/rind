import { sendIpc } from "./ipc.js";
import { paint } from "./theme.js";
import { connectSharedRuntime } from "../../rind-runtime-client/shared-runtime.js";

export const sendHelp = [
  "Usage: rind send --session <id> \"<prompt>\"",
  "",
  "Sends a prompt to the rind session with that id. Find the id in its startup",
  "banner or /status. A window showing the session takes it as if typed there;",
  "with none, a turn that is still running takes it as a follow-up.",
  "Delivery is acknowledged immediately.",
].join("\n");

export function parseSendArgs(args) {
  const result = { prompt: null, session: null };
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--session") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--session requires a value.");
      }
      index += 1;
      if (result.session !== null) throw new Error("--session may only be specified once.");
      if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid session id.");
      result.session = value;
      continue;
    }
    if (flag.startsWith("--")) {
      throw new Error(`Unknown send option: ${flag}`);
    }
    if (result.prompt !== null) {
      throw new Error("send accepts exactly one prompt.");
    }
    result.prompt = flag;
  }
  if (!result.session) {
    throw new Error("send requires --session <id>.");
  }
  if (!String(result.prompt || "").trim()) {
    throw new Error("send requires a non-empty prompt.");
  }
  return result;
}

const DELIVERED = { window: "sent to rind", queued: "queued for the running turn", ipc: "sent to rind" };

// The shared Runtime knows every interactive window. A window with its own
// private worker (--trace-llm, --session-dir), or one on a Runtime from before
// this routing, still listens on its own endpoint.
async function deliver(session, input, connect) {
  let refused;
  const host = await connect().catch(() => null);
  if (host) {
    try { return { ok: true, delivered: (await host.request("runtime/send", { session_id: session, input })).delivered }; }
    catch (error) {
      if (error.code === "INVALID_INPUT") return { ok: false, message: error.message };
      if (error.code === "SESSION_NOT_OPEN") refused = error.message;
    } finally { host.close(); }
  }
  const result = await sendIpc({ session, input });
  return result.ok ? { ok: true, delivered: "ipc" } : { ok: false, message: refused || result.message };
}

export async function runSend({ args, stdout = process.stdout, stderr = process.stderr, connect = () => connectSharedRuntime({ start: false }) }) {
  const options = parseSendArgs(args);
  const result = await deliver(options.session, options.prompt, connect);
  if (!result.ok) {
    stderr.write(`${result.message}\n`);
    return 1;
  }
  stdout.write(`${paint.success("✓")} ${DELIVERED[result.delivered] || DELIVERED.window} · session ${options.session}\n`);
  return 0;
}
