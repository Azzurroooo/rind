import { spawn } from "node:child_process";
import path from "node:path";
import type { CancellationToken } from "../../domain/cancellation.js";
import { CancelledError } from "../../domain/errors.js";
import {
  GOAL_TERMINAL_STATUSES,
  type ImageAttachment,
  normalizeGoalStatus,
  normalizePlan,
  toolCancelled,
  toolError,
  toolOk,
} from "../../domain/models.js";
import { writePlan } from "../persistence/session-store.js";
import { buildFileToolSpecs, type FileMutationQueue } from "./file-tools.js";
import { ToolSpec, type ToolParametersSchema } from "./registry.js";
import { buildShellToolSpecs, type ShellTools } from "./shell-tools.js";
import { buildWebToolSpecs, type WebSessions } from "./web-tools.js";

export function updatePlan(plan: unknown, sessionBase: string | null): string {
  try {
    const normalized = normalizePlan(plan);
    writePlan(normalized, sessionBase);
  } catch (exc) {
    const err = exc as NodeJS.ErrnoException;
    if (err?.code === "ENOENT" || err?.name === "FileNotFoundError") {
      return toolError("update_plan", err.message, "NotFound");
    }
    if (err instanceof Error && (err.name === "ValueError" || err.name === "Error" || err.name === "TypeError")) {
      if (err.message.includes("session_base")) {
        return toolError("update_plan", err.message, "NotFound");
      }
      return toolError("update_plan", err.message, "ValidationError");
    }
    return toolError("update_plan", String(exc), err?.name || "Error");
  }
  return toolOk("update_plan", "Plan updated");
}

export function createPlanToolSpec(sessionBaseProvider?: (() => string | null) | null): ToolSpec {
  return new ToolSpec({
    name: "update_plan",
    isAsync: false,
    description:
      "Maintain a lightweight plan for a multi-step task. Every call must submit the complete list; array order is both the display and the execution priority. Stores control state only, not factual summaries. Status must be pending, in_progress, completed, or cancelled, with at most one in_progress; mark a step completed only after the work is done and verified.",
    parameters: {
      type: "object",
      properties: {
        plan: {
          description: "The complete plan; pass an empty array to clear the current plan.",
          type: "array",
          items: {
            type: "object",
            properties: {
              step: { type: "string", minLength: 1 },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "cancelled"],
              },
            },
            required: ["step", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["plan"],
    },
    handler: args => updatePlan(args.plan, sessionBaseProvider ? sessionBaseProvider() : null),
  });
}

export function createGoalToolSpec(
  setGoalStatus: (status: string) => Promise<Record<string, unknown>>,
): ToolSpec {
  return new ToolSpec({
    name: "update_goal",
    description:
      "Finish the active persistent goal only after verifying the requested end state, or mark it blocked when meaningful progress is impossible.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "The goal terminal status.",
          enum: ["complete", "blocked"],
        },
      },
      required: ["status"],
    },
    handler: async args => {
      try {
        const normalized = normalizeGoalStatus(args.status);
        if (!GOAL_TERMINAL_STATUSES.has(normalized)) {
          throw new Error("update_goal can only set complete or blocked.");
        }
        const goal = await setGoalStatus(normalized);
        return toolOk("update_goal", goal);
      } catch (exc) {
        const err = exc as Error;
        return toolError("update_goal", err.message || String(exc), "ValidationError");
      }
    },
  });
}

export function askUserQuestion(
  _question: string,
  _options: Array<Record<string, string>> | null = null,
): string {
  return toolError(
    "ask_user_question",
    "No user-question responder is available in this execution environment.",
    "UserQuestionUnsupported",
  );
}

export const USER_QUESTION_TOOL_SPECS: readonly ToolSpec[] = [
  new ToolSpec({
    name: "ask_user_question",
    isAsync: false,
    description:
      "Ask the user a question that must be confirmed by them. Use only when a preference, scope decision, blocking choice, or information genuinely absent from the environment needs a human answer; do not ask about things tools can discover, and prefer a conservative engineering assumption over asking.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The single, clearly stated question to ask the user",
        },
        options: {
          type: ["array", "null"],
          default: null,
          description:
            'Optional structured answer list; the first item\'s label must end with " (Recommended)" and no other item may use that suffix. The user can also type free text, so never add an "Other" item.',
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short answer label" },
              description: { type: "string", description: "Brief explanation of the answer" },
            },
            required: ["label", "description"],
            additionalProperties: false,
          },
        },
      },
      required: ["question"],
    },
    handler: args =>
      askUserQuestion(
        args.question as string,
        (args.options as Array<Record<string, string>> | null | undefined) ?? null,
      ),
  }),
];

export interface HostToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParametersSchema;
}

function parseDeclarations(raw: unknown): HostToolDeclaration[] {
  if (!Array.isArray(raw)) {
    throw new Error("External tools must be a list of declarations.");
  }
  const declarations: HostToolDeclaration[] = [];
  for (const item of raw) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as Record<string, unknown>).name !== "string" ||
      typeof (item as Record<string, unknown>).description !== "string"
    ) {
      throw new Error("Each external tool needs a name and a description.");
    }
    const obj = item as Record<string, unknown>;
    const parameters = obj.parameters as Record<string, unknown> | undefined;
    if (
      !parameters ||
      typeof parameters !== "object" ||
      parameters.type !== "object" ||
      !parameters.properties ||
      typeof parameters.properties !== "object"
    ) {
      throw new Error(`External tool ${obj.name as string} needs an object parameter schema.`);
    }
    declarations.push({
      name: obj.name as string,
      description: obj.description as string,
      parameters: {
        ...(parameters as unknown as ToolParametersSchema),
        required: Array.isArray(parameters.required) ? (parameters.required as string[]) : [],
      },
    });
  }
  return declarations;
}

export class ExternalTool {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly tools: readonly HostToolDeclaration[];
  readonly instructions: string;
  readonly lifecycle: Record<string, unknown> | null;
  readonly skill_files: readonly string[];

  constructor(options: {
    command: string;
    args: readonly string[];
    env: Record<string, string>;
    tools: readonly HostToolDeclaration[];
    instructions?: string;
    lifecycle?: Record<string, unknown> | null;
    skillFiles?: readonly string[];
  }) {
    this.command = options.command;
    this.args = [...options.args];
    this.env = { ...options.env };
    this.tools = [...options.tools];
    this.instructions = options.instructions ?? "";
    this.lifecycle = options.lifecycle ?? null;
    this.skill_files = [...(options.skillFiles ?? [])];
  }

  static fromJson(raw: string | null | undefined): ExternalTool | null {
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    const command = value.command;
    if (typeof command !== "string" || !path.isAbsolute(command)) {
      throw new Error("External tool executable must be an absolute path.");
    }
    const args = value.args ?? [];
    const env = value.env ?? {};
    const skillFiles = value.skill_files ?? [];
    if (!Array.isArray(args) || !args.every(a => typeof a === "string")) {
      throw new Error("External tool arguments must be strings.");
    }
    if (
      !env ||
      typeof env !== "object" ||
      Array.isArray(env) ||
      !Object.entries(env).every(([k, v]) => typeof k === "string" && typeof v === "string")
    ) {
      throw new Error("External tool environment must contain strings.");
    }
    if (
      !Array.isArray(skillFiles) ||
      !skillFiles.every(v => typeof v === "string" && path.isAbsolute(v))
    ) {
      throw new Error("External skill references must be absolute file paths.");
    }
    return new ExternalTool({
      command,
      args: args as string[],
      env: env as Record<string, string>,
      tools: parseDeclarations(value.tools ?? []),
      instructions: String(value.instructions ?? ""),
      lifecycle:
        value.lifecycle && typeof value.lifecycle === "object"
          ? (value.lifecycle as Record<string, unknown>)
          : null,
      skillFiles: skillFiles as string[],
    });
  }

  async call(
    sessionId: string,
    method: string,
    parameters: Record<string, unknown>,
    env?: Record<string, string> | null,
    cancellationToken?: CancellationToken | null,
  ): Promise<Record<string, unknown>> {
    if (cancellationToken?.isCancelled) {
      throw new CancelledError(cancellationToken.reason || "User interrupted");
    }
    const mergedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") mergedEnv[k] = v;
    }
    Object.assign(mergedEnv, env ?? this.env);

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const proc = spawn(this.command, [...this.args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: mergedEnv,
        detached: process.platform !== "win32",
        windowsHide: true,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      const killProc = (): void => {
        if (proc.pid) {
          if (process.platform !== "win32") {
            try {
              process.kill(-proc.pid, "SIGKILL");
            } catch {}
          }
          try {
            proc.kill("SIGKILL");
          } catch {}
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killProc();
        reject(new Error("External tool timed out."));
      }, 125_000);

      let deregister = (): void => {};
      if (cancellationToken) {
        deregister = cancellationToken.registerCallback(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          killProc();
          reject(new CancelledError(cancellationToken.reason || "User interrupted"));
        });
      }

      proc.stdout?.on("data", chunk => stdoutChunks.push(Buffer.from(chunk)));
      proc.stderr?.on("data", chunk => stderrChunks.push(Buffer.from(chunk)));

      proc.on("error", err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        deregister();
        reject(err);
      });

      proc.on("close", code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        deregister();
        if (code !== 0) {
          const stderrText = Buffer.concat(stderrChunks).toString("utf8").slice(-2000);
          reject(new Error(stderrText || "External tool failed."));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")) as Record<
            string,
            unknown
          >;
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });

      const payload = JSON.stringify({
        method,
        params: parameters,
        runtimeSessionId: sessionId,
      });
      proc.stdin?.end(payload, "utf8");
    });
  }

  async notify(
    phase: string,
    sessionId: string,
    parameters: Record<string, unknown>,
    cancellationToken?: CancellationToken | null,
  ): Promise<void> {
    if (!this.lifecycle) return;
    if (cancellationToken?.isCancelled) {
      throw new CancelledError(cancellationToken.reason || "User interrupted");
    }
    const method = String(this.lifecycle[phase] ?? "");
    const env =
      this.lifecycle.env && typeof this.lifecycle.env === "object"
        ? (this.lifecycle.env as Record<string, string>)
        : null;
    const result = await this.call(sessionId, method, parameters, env, cancellationToken);
    if (!result.ok) {
      const errObj =
        result.error && typeof result.error === "object"
          ? (result.error as Record<string, unknown>)
          : {};
      throw new Error(String(errObj.message || "Execution host rejected this turn."));
    }
  }

  specs(sessionId: string): ToolSpec[] {
    return this.tools.map(declaration => this.buildSpec(sessionId, declaration));
  }

  private buildSpec(sessionId: string, declaration: HostToolDeclaration): ToolSpec {
    return new ToolSpec({
      name: declaration.name,
      description: declaration.description,
      parameters: declaration.parameters,
      parallel: true,
      handler: async args => {
        const token = args._cancellation_token as CancellationToken | null | undefined;
        if (token?.isCancelled) {
          return toolCancelled(declaration.name, token.reason || "User interrupted");
        }
        const visible: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) {
          if (!k.startsWith("_")) visible[k] = v;
        }
        try {
          const reply = await this.call(sessionId, declaration.name, visible, null, token);
          if (reply.ok) {
            return toolOk(declaration.name, reply.result);
          }
          const failure =
            reply.error && typeof reply.error === "object"
              ? (reply.error as Record<string, unknown>)
              : {};
          return toolError(
            declaration.name,
            String(failure.message || "The execution host refused this call."),
            String(failure.code || ""),
          );
        } catch (exc) {
          if (exc instanceof CancelledError || token?.isCancelled) {
            return toolCancelled(declaration.name, token?.reason || "User interrupted");
          }
          throw exc;
        }
      },
    });
  }
}

export function buildBuiltinToolSpecs(options: {
  shellTools: ShellTools;
  webSessions: WebSessions;
  mutationQueue?: FileMutationQueue | null;
  enableGoal?: boolean;
  enableUserQuestion?: boolean;
  setGoalStatus?: ((status: string) => Promise<Record<string, unknown>>) | null;
  workspaceRoot?: string | null;
  allowedRoots?: readonly string[] | null;
  sharedRoot?: string | null;
  sessionOutputRoot?: string | null;
  sessionBaseProvider?: (() => string | null) | null;
  captureImage?: ((path: string, token?: CancellationToken | null) => [ImageAttachment, string | null]) | null;
  imageInput?: () => boolean | null;
}): ToolSpec[] {
  const specs: ToolSpec[] = [
    ...buildFileToolSpecs({
      workspaceRoot: options.workspaceRoot,
      allowedRoots: options.allowedRoots,
      sharedRoot: options.sharedRoot,
      sessionOutputRoot: options.sessionOutputRoot,
      mutationQueue: options.mutationQueue,
      captureImage: options.captureImage,
      imageInput: options.imageInput,
      sessionBaseProvider: options.sessionBaseProvider,
    }),
  ];
  if (options.enableUserQuestion ?? true) {
    specs.unshift(...USER_QUESTION_TOOL_SPECS);
  }
  specs.push(...buildShellToolSpecs(options.shellTools, options.workspaceRoot));
  specs.push(createPlanToolSpec(options.sessionBaseProvider));
  specs.push(...buildWebToolSpecs(options.webSessions));
  if (options.enableGoal) {
    if (!options.setGoalStatus) {
      throw new Error("Goal tool requires a session goal status setter.");
    }
    specs.push(createGoalToolSpec(options.setGoalStatus));
  }
  return specs;
}
