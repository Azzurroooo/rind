import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConfig, parseYaml, renderYaml } from "./config.js";
import { ensureChannelSdks, looksLikeSourceDir, runChecks } from "./doctor.js";
import { type ChannelGuide, guideFor } from "./onboarding.js";
import { type PromptIO, PromptSession, WizardCancelled } from "./prompt.js";
import { runGateway } from "./runner.js";
import { PairingStore } from "./security.js";

export const DEFAULT_WORKER = "ws://127.0.0.1:8765";

const INT_FIELD_NAMES: ReadonlySet<string> = new Set([
  "imap_port",
  "smtp_port",
  "poll_interval",
  "callback_port",
  "webhook_port",
  "ws_port",
]);

export function envAnswer(
  channelId: string,
  fieldName: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const key = `RIND_GW_${channelId.toUpperCase()}_${fieldName.toUpperCase()}`;
  return env[key] ?? "";
}

export interface CollectedChannelEnv {
  readonly answers: Record<string, string>;
  readonly allow_from: string[];
  readonly group_allow: string[];
}

export function collectAnswersEnv(
  guide: ChannelGuide,
  env: Readonly<Record<string, string | undefined>>,
): readonly [CollectedChannelEnv, string[]] {
  const answers: Record<string, string> = {};
  const missingRequired: string[] = [];
  for (const spec of guide.fields) {
    const value =
      envAnswer(guide.id, spec.name, env) || (spec.default ? spec.default : "");
    answers[spec.name] = value;
    if (spec.required && !value) {
      missingRequired.push(
        `RIND_GW_${guide.id.toUpperCase()}_${spec.name.toUpperCase()}`,
      );
    }
  }
  const allowRaw = envAnswer(guide.id, "allow_from", env);
  const groupRaw = envAnswer(guide.id, "group_allow", env);
  return [
    {
      answers,
      allow_from: allowRaw
        .split(",")
        .map(s => s.trim())
        .filter(Boolean),
      group_allow: groupRaw
        .split(",")
        .map(s => s.trim())
        .filter(Boolean),
    },
    missingRequired,
  ];
}

export function buildConfigData(
  selected: readonly string[],
  answers: Readonly<Record<string, Readonly<Record<string, string>>>>,
  lists: Readonly<
    Record<
      string,
      { readonly allow_from?: readonly string[]; readonly group_allow?: readonly string[] }
    >
  >,
  options: {
    readonly worker: string;
    readonly worker_token: string;
    readonly workspace: string;
    readonly pairing_enabled?: boolean;
    readonly auto_install_sdk?: boolean;
  },
): Record<string, unknown> {
  const channels: Record<string, unknown> = {};
  for (const channelId of selected) {
    const guide = guideFor(channelId);
    if (!guide) continue;
    const block: Record<string, unknown> = {};
    const channelAnswers = answers[channelId] ?? {};
    for (const spec of guide.fields) {
      const value = channelAnswers[spec.name] ?? "";
      if (value) {
        block[spec.name] =
          /^\d+$/.test(value) && INT_FIELD_NAMES.has(spec.name)
            ? Number.parseInt(value, 10)
            : value;
      }
    }
    const allow = (lists[channelId]?.allow_from ?? []).filter(Boolean);
    const group = (lists[channelId]?.group_allow ?? []).filter(Boolean);
    if (allow.length > 0) {
      block.allow_from = allow;
    }
    if (group.length > 0) {
      block.group_allow = group;
    }
    if (Object.keys(block).length > 0) {
      channels[channelId] = block;
    }
  }

  const data: Record<string, unknown> = {
    worker: options.worker,
    workspace: options.workspace,
    channels,
  };
  if (options.worker_token) {
    data.worker_token = options.worker_token;
  }
  if (options.pairing_enabled ?? true) {
    data.pairing = { enabled: true };
  }
  if (options.auto_install_sdk) {
    data.auto_install_sdk = true;
  }
  return data;
}

function expandHome(rawPath: string): string {
  if (rawPath === "~") {
    return os.homedir();
  }
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

export function configPathFor(workspace: string): string {
  return path.join(expandHome(workspace), ".rind", "gateway.yaml");
}

function defaultWorkspace(cwd = process.cwd()): string {
  if (looksLikeSourceDir(cwd)) {
    return path.join(os.homedir(), "rind-workspace");
  }
  return cwd;
}

async function resolveWorkspace(
  raw: string | null | undefined,
  prompt: PromptSession | null,
): Promise<string> {
  let candidate = path.resolve(expandHome(raw || defaultWorkspace()));
  if (looksLikeSourceDir(candidate)) {
    if (!prompt) {
      throw new WizardCancelled();
    }
    prompt.println(
      "  ✘ This is the Rind source tree — runtime data (state/pairing/uploads) must not live here.",
    );
    const fallback = path.join(os.homedir(), "rind-workspace");
    const picked = (
      await prompt.inputLine(`Pick another workspace directory (Enter = ${fallback}): `)
    ).trim();
    const nextCandidate = path.resolve(expandHome(picked || fallback));
    if (looksLikeSourceDir(nextCandidate)) {
      prompt.println("  ✘ Still the source tree. Cancelled.");
      throw new WizardCancelled();
    }
    candidate = nextCandidate;
  }
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

async function guideWalk(
  guide: ChannelGuide,
  env: Readonly<Record<string, string | undefined>>,
  prompt: PromptSession,
): Promise<readonly [Record<string, string>, { allow_from: string[]; group_allow: string[] }]> {
  prompt.println(`\n=== ${guide.emoji} ${guide.label} ===`);
  for (const step of guide.setup_steps) {
    prompt.println(`  · ${step}`);
  }
  if (guide.scopes.length > 0) {
    prompt.println(
      "  Exact permission/event codes (paste each into the platform's search box to pin them down):",
    );
    for (const code of guide.scopes) {
      prompt.println(`      ${code}`);
    }
  }
  const answers: Record<string, string> = {};
  const envPrefix = `RIND_GW_${guide.id.toUpperCase()}_`;
  for (const spec of guide.fields) {
    const envValue = env[`${envPrefix}${spec.name.toUpperCase()}`] ?? "";
    const label = spec.help ? `${spec.label} (${spec.help})` : spec.label;
    answers[spec.name] =
      (await prompt.ask(label, spec.default, { secret: spec.secret })) || envValue;
  }
  prompt.println(
    "  allow_from / group_allow can stay empty — unknown accounts get a pairing code on their first message,",
  );
  prompt.println(
    "  and `rind gateway approve <code>` on the server adds them to the allowlist automatically.",
  );
  let allow = await prompt.askList("allow_from allowlist");
  const group = await prompt.askList("group_allow group allowlist");

  let probeDetail = "";
  const nonEmptyAnswers = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(answers)) {
      if (v) out[k] = v;
    }
    return out;
  };

  if (guide.probe && Object.keys(nonEmptyAnswers()).length > 0) {
    if (await prompt.confirm("Verify credentials now (calls the platform API)?")) {
      let result = await guide.probe(nonEmptyAnswers());
      probeDetail = result.detail;
      prompt.println(`  ${result.ok ? "✔" : "✘"} ${probeDetail}`);
      let retries = 0;
      while (
        !result.ok &&
        retries < 2 &&
        (await prompt.confirm("Re-enter the proxy URL and verify again?", false))
      ) {
        answers.proxy = await prompt.ask("Proxy URL (e.g. http://127.0.0.1:7890)");
        result = await guide.probe(nonEmptyAnswers());
        probeDetail = result.detail;
        prompt.println(`  ${result.ok ? "✔" : "✘"} ${probeDetail}`);
        retries += 1;
      }
      if (!result.ok) {
        prompt.println(
          "     You can re-run the health check later with `rind gateway doctor --probe`.",
        );
      }
    }
  }

  if (guide.discover_senders) {
    const botMatch = /@[\w]+/.exec(probeDetail);
    const where = botMatch
      ? `send your bot ${botMatch[0]} a message on Telegram`
      : "find your bot on Telegram (the username BotFather gave you) and send it a message";
    if (
      await prompt.confirm(
        `Capture your account ID now? (within 60 seconds, ${where})`,
        false,
      )
    ) {
      prompt.println(
        `  Waiting for a message — send anything to ${botMatch ? botMatch[0] : "your bot"} on Telegram…`,
      );
      const senders = await guide.discover_senders(nonEmptyAnswers(), 60.0);
      if (senders.length > 0) {
        prompt.println("  Discovered senders:");
        senders.forEach((sender, index) => {
          prompt.println(`    ${index + 1}. ${sender}`);
        });
        const picked = (
          await prompt.inputLine(
            "Add which to allow_from (numbers, Enter = all, 0 = none): ",
          )
        ).trim();
        if (picked !== "0") {
          const ids = picked
            ? picked
                .replace(/，/g, ",")
                .split(",")
                .map(t => t.trim())
                .filter(t => /^\d+$/.test(t))
                .map(t => Number.parseInt(t, 10))
                .filter(idx => idx > 0 && idx <= senders.length)
                .map(idx => senders[idx - 1]!.split(" ")[0]!)
            : senders.map(s => s.split(" ")[0]!);
          if (allow.length === 0) {
            allow = ids;
          }
        }
      } else {
        prompt.println(
          "  No message within 60 seconds. Messaging the bot later returns a pairing card (with your ID);",
        );
        prompt.println(
          "  approve it with `rind gateway approve <code>` — no need to rerun the wizard.",
        );
      }
    }
  }

  return [answers, { allow_from: allow, group_allow: group }];
}

export interface InitArgs {
  readonly channel?: string;
  readonly yes?: boolean;
  readonly workerUrl?: string;
  readonly workspace?: string | null;
}

export interface InitOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly io?: PromptIO;
  readonly promptSession?: PromptSession;
  readonly workerAliveImpl?: (
    worker: string,
    token: string | null,
  ) => Promise<readonly [boolean, string]>;
}

export async function runInit(
  args: InitArgs,
  options?: InitOptions,
): Promise<number> {
  const env = options?.env ?? process.env;
  const prompt = options?.promptSession ?? new PromptSession(options?.io);
  try {
    if (args.yes) {
      const rawTokens = (args.channel ?? "")
        .split(",")
        .map(t => t.trim())
        .filter(Boolean);
      const selected = rawTokens.filter(t => Boolean(guideFor(t)));
      const unknown = rawTokens.filter(t => !guideFor(t));
      if (unknown.length > 0) {
        prompt.printerr(`Unknown channels ignored: ${unknown.join(", ")}`);
      }
      if (selected.length === 0) {
        prompt.printerr("--channel has no valid channels.");
        return 2;
      }
      const worker = args.workerUrl || env.RIND_GW_WORKER || DEFAULT_WORKER;
      const workerToken = env.RIND_SERVER_TOKEN ?? "";
      let workspace: string;
      try {
        workspace = await resolveWorkspace(args.workspace, null);
      } catch (err) {
        if (err instanceof WizardCancelled) {
          prompt.printerr(
            "Workspace points to Rind source directory; pass a dedicated --workspace.",
          );
          return 2;
        }
        throw err;
      }
      const guides = selected.map(id => guideFor(id)!);
      const answers: Record<string, Record<string, string>> = {};
      const lists: Record<string, { allow_from: string[]; group_allow: string[] }> = {};
      for (const guide of guides) {
        const [collected, missing] = collectAnswersEnv(guide, env);
        answers[guide.id] = collected.answers;
        lists[guide.id] = {
          allow_from: collected.allow_from,
          group_allow: collected.group_allow,
        };
        if (missing.length > 0) {
          prompt.printerr(
            `✘ ${guide.label} is missing required fields (environment variables): ${missing.join(", ")}`,
          );
          return 2;
        }
      }
      const [keptGuides, autoInstall] = await ensureChannelSdks(guides, {
        interactive: false,
        echo: line => prompt.println(line),
      });
      if (keptGuides.length === 0) {
        prompt.printerr("No channels available to start.");
        return 2;
      }
      return await finishInit({
        selected: keptGuides.map(g => g.id),
        answers,
        lists,
        worker,
        workerToken,
        workspace,
        confirmWrite: false,
        autoInstallSdk: autoInstall,
        prompt,
        env,
        workerAliveImpl: options?.workerAliveImpl,
      });
    }

    prompt.println(
      "Rind gateway configuration wizard — connect IM channels to your worker step by step (about 2 minutes)",
    );
    let selected: string[];
    if (args.channel) {
      const rawTokens = args.channel
        .split(",")
        .map(t => t.trim())
        .filter(Boolean);
      selected = rawTokens.filter(t => Boolean(guideFor(t)));
      const unknown = rawTokens.filter(t => !guideFor(t));
      if (unknown.length > 0) {
        prompt.printerr(`Unknown channels ignored: ${unknown.join(", ")}`);
      }
      if (selected.length === 0) {
        prompt.printerr("No usable channels.");
        return 2;
      }
    } else {
      selected = await prompt.pickChannels();
    }

    let workerToken = env.RIND_SERVER_TOKEN ?? "";
    const worker = await prompt.ask("Worker URL", args.workerUrl || DEFAULT_WORKER);
    const workspaceRaw = await prompt.ask(
      "Workspace directory (root for gateway sessions, absolute path)",
      args.workspace || defaultWorkspace(),
    );
    const workspace = await resolveWorkspace(workspaceRaw, prompt);
    if (!workerToken) {
      workerToken = await prompt.ask(
        "Worker Token (value of RIND_SERVER_TOKEN, optional)",
        "",
        { secret: true },
      );
    }

    const initialGuides = selected.map(id => guideFor(id)!);
    const [guides, autoInstall] = await ensureChannelSdks(initialGuides, {
      interactive: true,
      confirm: label => prompt.confirm(label),
      echo: line => prompt.println(line),
    });
    if (guides.length === 0) {
      prompt.printerr("No channels available to start.");
      return 2;
    }

    const answers: Record<string, Record<string, string>> = {};
    const lists: Record<string, { allow_from: string[]; group_allow: string[] }> = {};
    for (const guide of guides) {
      const [a, l] = await guideWalk(guide, env, prompt);
      answers[guide.id] = a;
      lists[guide.id] = l;
    }

    return await finishInit({
      selected: guides.map(g => g.id),
      answers,
      lists,
      worker,
      workerToken,
      workspace,
      confirmWrite: true,
      autoInstallSdk: autoInstall,
      prompt,
      env,
      workerAliveImpl: options?.workerAliveImpl,
    });
  } catch (err) {
    if (err instanceof WizardCancelled) {
      prompt.println("\nCancelled (nothing written).");
      return 1;
    }
    throw err;
  } finally {
    prompt.close();
  }
}

async function finishInit(params: {
  readonly selected: readonly string[];
  readonly answers: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly lists: Readonly<
    Record<string, { allow_from: string[]; group_allow: string[] }>
  >;
  readonly worker: string;
  readonly workerToken: string;
  readonly workspace: string;
  readonly confirmWrite: boolean;
  readonly autoInstallSdk: boolean;
  readonly prompt: PromptSession;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly workerAliveImpl?: (
    worker: string,
    token: string | null,
  ) => Promise<readonly [boolean, string]>;
}): Promise<number> {
  const { prompt } = params;
  const data = buildConfigData(params.selected, params.answers, params.lists, {
    worker: params.worker,
    worker_token: params.workerToken,
    workspace: params.workspace,
    auto_install_sdk: params.autoInstallSdk,
  });
  const text = renderYaml(data);
  prompt.println("\n—— Generated gateway.yaml ——");
  prompt.println(text);

  const target = configPathFor(params.workspace);
  if (params.confirmWrite && !(await prompt.confirm(`Write to ${target}?`))) {
    prompt.println("Cancelled (nothing written).");
    return 1;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
  prompt.println(`\n✔ Written to ${target}`);

  prompt.println("\n—— Health check ——");
  const checks = await runChecks(target, params.workspace, {
    env: params.env,
    workerAliveImpl: params.workerAliveImpl,
  });
  for (const check of checks) {
    const mark = check.ok === true ? "✔" : check.ok === null ? "⚠" : "✘";
    prompt.println(`  ${mark} ${check.name}: ${check.detail}`);
  }

  prompt.println("\nNext: start the gateway to begin chatting.");
  prompt.println(`  rind gateway --config "${target}"`);
  prompt.println("  (add/change channels: rerun rind gateway init)");

  // In non-interactive --yes mode, never prompt to start the gateway.
  if (!params.confirmWrite) {
    return 0;
  }

  let startNow = false;
  try {
    startNow = await prompt.confirm(
      "Start the gateway now? (Ctrl+C to stop)",
      true,
    );
  } catch (err) {
    if (err instanceof WizardCancelled) {
      startNow = false;
    } else {
      throw err;
    }
  }
  if (!startNow) {
    return 0;
  }

  prompt.close();
  const runtimeDir = path.join(params.workspace, ".rind");
  const config = buildConfig(parseYaml(text, { env: params.env }));
  return await runGateway(
    config,
    runtimeDir,
    new PairingStore(path.join(runtimeDir, "pairing.json")),
  );
}
