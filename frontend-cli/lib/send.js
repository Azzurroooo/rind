import { sendIpc } from "./ipc.js";
import { paint } from "./theme.js";

export const sendHelp = [
  "Usage: rind send --session <id> \"<prompt>\"",
  "",
  "Sends a prompt to the running rind session with that id. Find the id in",
  "the target session's startup banner or /status. Delivery is acknowledged",
  "immediately; the reply appears in that session.",
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

export async function runSend({ args, stdout = process.stdout, stderr = process.stderr }) {
  const options = parseSendArgs(args);
  const result = await sendIpc({ session: options.session, input: options.prompt });
  if (!result.ok) {
    stderr.write(`${result.message}\n`);
    return 1;
  }
  stdout.write(`${paint.success("✓")} sent to rind · session ${options.session}\n`);
  return 0;
}
