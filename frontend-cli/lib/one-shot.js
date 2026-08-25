import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createRuntimeClient } from "./runtime-client.js";
import { requireRuntimeInitialization, runtimeMethods } from "./runtime-protocol.js";

export const oneShotHelp = [
  "Usage: rind run --prompt <text> [--cwd <absolute-path>] [--session <id>]",
  "",
  "Runs one prompt without the interactive TTY UI. The final assistant reply is written to stdout.",
  "",
  "Example:",
  '  rind run --prompt "Summarize the changes in src/" --cwd "E:\\code\\my-project" --session 20260825_101530_ab12cd34',
].join("\n");

export const cliHelp = [
  "Usage: rind [options]",
  "",
  "Start the interactive CLI.",
  "",
  oneShotHelp,
].join("\n");

export function parseOneShotArgs(args) {
  if (args[0] !== "run") return null;
  const result = { cwd: null, session: null, prompt: null, debug: false, traceLlm: false };
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--debug") {
      result.debug = true;
      continue;
    }
    if (flag === "--trace-llm") {
      result.traceLlm = true;
      continue;
    }
    if (!["--cwd", "--session", "--prompt"].includes(flag)) {
      throw new Error(`Unknown run option: ${flag}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value.`);
    }
    index += 1;
    const key = { "--cwd": "cwd", "--session": "session", "--prompt": "prompt" }[flag];
    if (result[key] !== null) throw new Error(`${flag} may only be specified once.`);
    result[key] = value;
  }
  if (!result.prompt?.trim()) throw new Error("--prompt requires a non-empty value.");
  if (result.cwd && !path.isAbsolute(result.cwd)) {
    throw new Error("--cwd must be an absolute path.");
  }
  return result;
}

export function promptSlug(prompt) {
  const slug = String(prompt || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
  return slug || "prompt";
}

export function logFileName({ sessionId, prompt, now = new Date(), suffix = "" }) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "_");
  return `${stamp}_${sessionId}_${promptSlug(prompt)}${suffix}.md`;
}

export async function writeRunLog({ workspace, sessionId, turnId, model, prompt, assistant, status, toolCount, error, startedAt = new Date(), finishedAt = new Date() }) {
  const logsDir = path.join(workspace, "logs");
  await mkdir(logsDir, { recursive: true });
  let fileName = logFileName({ sessionId, prompt, now: finishedAt });
  let target = path.join(logsDir, fileName);
  let suffix = 0;
  while (true) {
    try {
      const frontMatter = [
        "---",
        `session_id: ${yamlValue(sessionId)}`,
        `turn_id: ${yamlValue(turnId)}`,
        `workspace: ${yamlValue(workspace)}`,
        `model: ${yamlValue(model)}`,
        `status: ${yamlValue(status)}`,
        `tool_count: ${Number(toolCount) || 0}`,
        `started_at: ${yamlValue(startedAt.toISOString())}`,
        `finished_at: ${yamlValue(finishedAt.toISOString())}`,
        ...(error ? [`error: ${yamlValue(error)}`] : []),
        "---",
        "",
        "# Prompt",
        "",
        String(prompt || ""),
        "",
        "# Assistant",
        "",
        String(assistant || ""),
        "",
      ].join("\n");
      await writeFile(target, frontMatter, { encoding: "utf8", flag: "wx" });
      return target;
    } catch (errorValue) {
      if (errorValue?.code !== "EEXIST" || suffix >= 9) throw errorValue;
      suffix += 1;
      fileName = logFileName({ sessionId, prompt, now: finishedAt, suffix: `_${suffix}` });
      target = path.join(logsDir, fileName);
    }
  }
}

export async function runOneShot({ args, python, repoRoot, runtimePath, cwd = process.cwd(), stderr = console.error, stdout = console.log, clientFactory = createRuntimeClient }) {
  const options = parseOneShotArgs(args);
  if (!options) return false;
  const runtimeArgs = ["--no-user-question"];
  if (options.cwd) runtimeArgs.push("--cwd", options.cwd);
  if (options.session) runtimeArgs.push("--session", options.session);
  if (options.debug) runtimeArgs.push("--debug");
  if (options.traceLlm) runtimeArgs.push("--trace-llm");

  let assistant = "";
  let completed = "";
  let turnId = "";
  let toolCount = 0;
  let status = "failed";
  const startedAt = new Date();
  let sessionInfo = null;
  let client;
  try {
    stderr(`Starting session${options.session ? ` ${options.session}` : ""}...`);
    client = clientFactory({
      python,
      repoRoot,
      runtimePath,
      cwd: options.cwd || cwd,
      cliArgs: runtimeArgs,
      onMessage: (message) => {
        const event = message?.event;
        const type = event?.type;
        if (message?.turn_id) turnId = String(message.turn_id);
        if (type === "assistant_delta") assistant += String(event.text || "");
        if (type === "assistant_message_completed") completed = String(event.content || "");
        if (type === "tool_requested") {
          toolCount += 1;
          stderr(`Tool: ${String(event.tool_name || "unknown")}`);
        }
      },
      onStderr: (text) => {
        if (options.debug) stderr(String(text).trimEnd());
      },
    });
    client.start();
    sessionInfo = requireRuntimeInitialization(await client.request(runtimeMethods.initialize));
    stderr("Running turn...");
    const sessionId = String(sessionInfo.session_id || options.session || "").trim();
    if (!sessionId) throw new Error("Runtime initialization did not return a session_id.");
    const result = await client.request(runtimeMethods.sessionPrompt, {
      session_id: sessionId,
      input: options.prompt,
    });
    status = "completed";
    const responseTurnId = String(result?.turn_id || turnId || "");
    turnId = responseTurnId;
    const finalText = completed || assistant;
    const workspace = String(sessionInfo.workspace_root || options.cwd || cwd);
    const logPath = await writeRunLog({
      workspace,
      sessionId,
      turnId,
      model: sessionInfo.model || "",
      prompt: options.prompt,
      assistant: finalText,
      status,
      toolCount,
      startedAt,
      finishedAt: new Date(),
    });
    stdout(finalText);
    stderr(`Completed. Log written to ${logPath}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`Run failed: ${message}`);
    if (sessionInfo) {
      try {
        await writeRunLog({
          workspace: String(sessionInfo.workspace_root || options.cwd || cwd),
          sessionId: String(sessionInfo.session_id || options.session || "unknown"),
          turnId,
          model: sessionInfo.model || "",
          prompt: options.prompt,
          assistant: completed || assistant,
          status: "failed",
          toolCount,
          error: message,
          startedAt,
          finishedAt: new Date(),
        });
      } catch (logError) {
        stderr(`Log failed: ${logError instanceof Error ? logError.message : String(logError)}`);
      }
    }
    process.exitCode = 1;
    return true;
  } finally {
    if (client) await client.shutdown().catch(() => client.forceShutdown());
  }
}

function yamlValue(value) {
  return JSON.stringify(String(value || ""));
}
