// rind config: a folder's defaults for new conversations started there. The
// only scope is a folder; settings.json, the default for every other folder,
// is edited by hand.
import path from "node:path";

import { createRuntimeClient } from "./runtime-client.js";
import { requireRuntimeInitialization, runtimeMethods } from "./runtime-protocol.js";

export const configHelp = [
  "Usage: rind config set model <model> --folder [dir] [--connection <id>]",
  "       rind config set effort <level> --folder [dir]",
  "       rind config unset model|effort --folder [dir]",
  "",
  "Sets what new conversations in a folder start with (the current folder unless dir is given).",
  "Existing conversations keep their own model. A Git worktree without its own value uses its",
  "main repository's. Anything a folder does not set comes from ~/.rind/settings.json.",
].join("\n");

const GROUPS = { model: "model", effort: "reasoning_effort" };

export function parseConfigArgs(args, cwd = process.cwd()) {
  const [action, name, ...rest] = args;
  const usage = () => new Error(configHelp);
  if (!["set", "unset"].includes(action) || !GROUPS[name]) throw usage();
  const values = [];
  let folder = null, connection = "";
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--folder") {
      const next = rest[index + 1];
      folder = path.resolve(cwd, next && !next.startsWith("--") ? (index += 1, next) : ".");
    } else if (arg === "--connection") {
      connection = String(rest[(index += 1)] || "");
      if (!connection) throw usage();
    } else if (arg.startsWith("--")) throw new Error(`Unknown config option: ${arg}\n\n${configHelp}`);
    else values.push(arg);
  }
  if (!folder) throw new Error(`Say which folder with --folder; settings.json is the default for all others.\n\n${configHelp}`);
  if (action === "set" ? values.length !== 1 : values.length) throw usage();
  if (connection && !(action === "set" && name === "model")) throw usage();
  return { action, group: GROUPS[name], value: values[0] || "", folder, connection };
}

export async function runConfig({ args, launch, cwd = process.cwd(), write = text => process.stdout.write(text), clientFactory = createRuntimeClient }) {
  const options = parseConfigArgs(args, cwd);
  const client = clientFactory({ ...launch, cwd: options.folder, cliArgs: ["--cwd", options.folder] });
  client.start();
  try {
    requireRuntimeInitialization(await client.request(runtimeMethods.initialize));
    const result = options.action === "unset"
      ? await client.request(runtimeMethods.folderDefaultsUnset, { workspace_root: options.folder, group: options.group })
      : await client.request(runtimeMethods.folderDefaultsSet, { workspace_root: options.folder, ...await setParams(client, options) });
    write(describeFolderDefaults(result) + "\n");
  } finally {
    await client.shutdown();
  }
}

async function setParams(client, { group, value, connection }) {
  if (group === "reasoning_effort") return { reasoning_effort: value };
  const { models = [] } = await client.request(runtimeMethods.modelList);
  const matches = models.filter(model => model.id === value && (!connection || model.provider_id === connection));
  if (!matches.length) throw new Error(`${value} is not listed${connection ? " for " + connection : ""}. Log in with /login, or check the id with /model.`);
  if (matches.length > 1) throw new Error(`${value} is offered by ${matches.map(model => model.provider_id).join(", ")}. Add --connection <id>.`);
  return { provider_id: matches[0].provider_id, model_id: value };
}

const SOURCES = { folder: "this folder", main_repository: "the main repository", settings: "settings.json" };

export function describeFolderDefaults(result) {
  const { resolved } = result;
  return [
    `New conversations in ${result.workspace_root} start with:`,
    `  model   ${resolved.provider} / ${resolved.model}  (${SOURCES[resolved.model_source] || resolved.model_source})`,
    `  effort  ${resolved.reasoning_effort || "unset"}  (${SOURCES[resolved.effort_source] || resolved.effort_source})`,
  ].join("\n");
}
