import { toolError } from "../../domain/models.js";

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export interface ToolParametersSchema {
  readonly type: "object";
  readonly properties: Record<string, Record<string, unknown>>;
  readonly required: readonly string[];
  readonly [key: string]: unknown;
}

export interface ToolFunctionSchema {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: ToolParametersSchema;
  };
}

export class ToolSpec {
  readonly name: string;
  readonly handler: ToolHandler;
  readonly schema: ToolFunctionSchema;
  readonly is_async: boolean;
  readonly accepted_arguments: ReadonlySet<string> | null;
  readonly normalize_arguments: ((args: Record<string, unknown>) => Record<string, unknown>) | null;
  readonly advertised: boolean;
  readonly parallel: boolean;

  constructor(options: {
    name: string;
    handler: ToolHandler;
    description: string;
    parameters: ToolParametersSchema;
    isAsync?: boolean;
    acceptedArguments?: Iterable<string> | null;
    normalizeArguments?: ((args: Record<string, unknown>) => Record<string, unknown>) | null;
    advertised?: boolean;
    parallel?: boolean;
  }) {
    if (typeof options.name !== "string" || !TOOL_NAME_PATTERN.test(options.name)) {
      throw new Error(`Invalid tool name: ${JSON.stringify(options.name)}`);
    }
    if (typeof options.handler !== "function") {
      throw new TypeError("Tool handler must be callable.");
    }
    this.name = options.name;
    this.handler = options.handler;
    this.schema = {
      type: "function",
      function: {
        name: options.name,
        description: options.description,
        parameters: options.parameters,
      },
    };
    this.is_async = options.isAsync ?? true;
    this.accepted_arguments =
      options.acceptedArguments === null
        ? null
        : options.acceptedArguments !== undefined
          ? new Set(options.acceptedArguments)
          : new Set([
              ...Object.keys(options.parameters.properties),
              "_cancellation_token",
              "_session_id",
              "_idempotency_key",
              "_output_store",
              "_origin_turn_id",
              "_request_id",
            ]);
    this.normalize_arguments = options.normalizeArguments ?? null;
    this.advertised = options.advertised ?? true;
    this.parallel = options.parallel ?? false;
  }
}

export class DefaultToolRegistry {
  private readonly specsByName = new Map<string, ToolSpec>();
  private readonly _schemas: ToolFunctionSchema[] = [];

  constructor(specs: Iterable<ToolSpec>) {
    const catalog = Array.from(specs);
    for (const spec of catalog) {
      if (!(spec instanceof ToolSpec)) {
        throw new TypeError("Tool catalog entries must be ToolSpec instances.");
      }
      if (this.specsByName.has(spec.name)) {
        throw new Error(`Duplicate tool name: ${spec.name}`);
      }
      this.specsByName.set(spec.name, spec);
      if (spec.advertised) {
        this._schemas.push(spec.schema);
      }
    }
  }

  replaceExternalSpecs(previousNames: Iterable<string>, specs: Iterable<ToolSpec>): void {
    for (const name of previousNames) {
      this.specsByName.delete(name);
    }
    for (const spec of specs) {
      if (!(spec instanceof ToolSpec)) {
        throw new TypeError("Tool catalog entries must be ToolSpec instances.");
      }
      if (this.specsByName.has(spec.name)) {
        throw new Error(`Duplicate tool name: ${spec.name}`);
      }
      this.specsByName.set(spec.name, spec);
    }
    this._schemas.length = 0;
    for (const spec of this.specsByName.values()) {
      if (spec.advertised) {
        this._schemas.push(spec.schema);
      }
    }
  }

  get schemas(): ToolFunctionSchema[] {
    return this._schemas;
  }

  has(name: string): boolean {
    return this.specsByName.has(name);
  }

  isAsync(name: string): boolean {
    const spec = this.specsByName.get(name);
    return spec !== undefined && spec.is_async;
  }

  isParallel(name: string): boolean {
    const spec = this.specsByName.get(name);
    return spec !== undefined && spec.parallel;
  }

  call(name: string, args: Record<string, unknown>): unknown {
    const spec = this.specsByName.get(name);
    if (!spec) {
      throw new Error(`Unknown tool: ${name}`);
    }
    const prepared = this.prepareCallArgs(spec, args);
    return typeof prepared === "string" ? prepared : spec.handler(prepared);
  }

  async callAsync(name: string, args: Record<string, unknown>): Promise<unknown> {
    const spec = this.specsByName.get(name);
    if (!spec) {
      throw new Error(`Unknown tool: ${name}`);
    }
    const prepared = this.prepareCallArgs(spec, args);
    return typeof prepared === "string" ? prepared : await spec.handler(prepared);
  }

  private prepareCallArgs(spec: ToolSpec, rawArgs: Record<string, unknown>): Record<string, unknown> | string {
    const parameters = spec.schema.function.parameters;
    const allowed = Object.keys(parameters.properties).sort();
    let args = { ...rawArgs };
    try {
      if (spec.normalize_arguments) {
        args = spec.normalize_arguments(args);
      }
    } catch (exc) {
      return toolError(spec.name, (exc as Error).message, "InvalidArguments", { allowed });
    }
    const missing = parameters.required.filter(k => !(k in args)).sort();
    const unknown =
      spec.accepted_arguments !== null
        ? Object.keys(args)
            .filter(k => !k.startsWith("_") && !allowed.includes(k))
            .sort()
        : [];
    if (missing.length > 0 || unknown.length > 0) {
      return toolError(
        spec.name,
        `Missing arguments: ${missing.join(", ") || "none"}. Unknown arguments: ${unknown.join(", ") || "none"}. Allowed: ${allowed.join(", ")}.`,
        "InvalidArguments",
        { missing, unknown, allowed },
      );
    }
    if (spec.accepted_arguments === null) {
      return args;
    }
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (spec.accepted_arguments.has(k)) {
        filtered[k] = v;
      }
    }
    return filtered;
  }
}
