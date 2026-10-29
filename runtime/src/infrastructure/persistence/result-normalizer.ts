import type { ImageAttachment } from "../../domain/models.js";

const PREFERRED_KEYS = ["ok", "tool", "data", "error", "error_type", "meta", "ts"] as const;
const MAX_PREVIEW_BYTES = 25 * 1024;
const MAX_PREVIEW_LINES = 2_000;
const TRUNCATION_MARKER =
  "\n\nOutput truncated. Full output is available at {output_path}.\nUse read_file or bash to inspect it.\n";
const READ_PAGE_MARKER =
  "\n\nRead output is limited to the requested page. Use the original path and next_offset in meta to continue reading.\n";
const READ_PREVIEW_MARKER =
  "\n\nRead preview is incomplete. Read the original path in smaller ranges.\n";
const EMPTY_SHELL_OUTPUT = "(no tool output)";
const SHELL_WARNINGS: readonly (readonly [string, string])[] = [
  ["output_incomplete", "Output log is incomplete"],
  ["output_error", "Output log error"],
  ["persistence_error", "Task journal write failed"],
];

export interface ToolOutputWriter {
  write(sessionId: string, callId: string, content: string): Promise<string>;
}

export interface NormalizedToolResult {
  terminal_content: string;
  model_content: string;
  model_content_format: string;
  model_content_policy: Record<string, unknown>;
  attachments: ImageAttachment[];
}

export function jsonDumpsColonSpace(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => jsonDumpsColonSpace(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${jsonDumpsColonSpace(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export class ToolResultNormalizer {
  readonly terminalMaxBytes: number;
  readonly maxPreviewBytes: number;
  readonly maxPreviewLines: number;

  constructor(
    terminalMaxBytes: number = 8 * 1024,
    maxPreviewBytes: number = MAX_PREVIEW_BYTES,
    maxPreviewLines: number = MAX_PREVIEW_LINES,
  ) {
    this.terminalMaxBytes = Math.max(1, Math.trunc(terminalMaxBytes));
    this.maxPreviewBytes = Math.max(1, Math.trunc(maxPreviewBytes));
    this.maxPreviewLines = Math.max(1, Math.trunc(maxPreviewLines));
  }

  async normalize(
    resultPayload: unknown,
    options: {
      toolName?: string;
      status?: string;
      errorType?: string;
      outputStore?: ToolOutputWriter | null;
      sessionId?: string;
      callId?: string;
    } = {},
  ): Promise<NormalizedToolResult> {
    const toolName = options.toolName ?? "";
    const status = options.status ?? "completed";
    const errorType = options.errorType ?? "";
    const outputStore = options.outputStore ?? null;
    const sessionId = options.sessionId ?? "";
    const callId = options.callId ?? "";

    const [payload, rendered, attachments] = this.preparePayload(resultPayload);
    const [totalBytes, totalLines] = this.textMetrics(rendered);
    const identity = this.projectionIdentity(payload, toolName, status, errorType);
    const [existingPath, existingTruncated] = this.existingOutputReference(payload);
    const isRead = identity[1] === "read_file";
    const isMutation = identity[0] && (identity[1] === "edit_file" || identity[1] === "write_file");
    let previewRequired = totalBytes > this.maxPreviewBytes || totalLines > this.maxPreviewLines;
    const payloadObj = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
    const dataObj = payloadObj && payloadObj.data && typeof payloadObj.data === "object" && !Array.isArray(payloadObj.data)
      ? (payloadObj.data as Record<string, unknown>)
      : null;
    const isTask = Boolean(dataObj && dataObj.task_id);
    let shellOutput = "";
    if (isTask && dataObj) {
      const parts: string[] = [];
      if (typeof dataObj.stdout === "string" && dataObj.stdout) {
        parts.push(dataObj.stdout.replace(/\n+$/, ""));
      }
      if (typeof dataObj.stderr === "string" && dataObj.stderr) {
        parts.push(dataObj.stderr.replace(/\n+$/, ""));
      }
      shellOutput = parts.join("\n");
      const [shellBytes, shellLines] = this.textMetrics(shellOutput);
      previewRequired = previewRequired || shellBytes > this.maxPreviewBytes || shellLines > this.maxPreviewLines;
    }
    const needsPreview = previewRequired || existingTruncated;
    let outputPath = existingPath;
    if (needsPreview && !isRead && !isMutation && !outputPath && outputStore && sessionId && callId) {
      outputPath = await outputStore.write(sessionId, callId, rendered);
    }
    const readPayload = isRead ? this.readPayload(payload) : null;
    const readContent = readPayload ? this.projectReadForModel(readPayload) : null;

    let modelContent: string;
    if (isTask && payloadObj) {
      modelContent = this.projectShellForModel(payloadObj, shellOutput, outputPath);
    } else if (readContent !== null) {
      modelContent = readContent;
    } else if (isMutation && payloadObj) {
      modelContent = this.projectMutationForModel(payloadObj);
    } else if (needsPreview) {
      modelContent = this.projectForModel(
        this.outputText(payload, identity[0], rendered),
        totalBytes,
        totalLines,
        identity,
        outputPath,
        isRead ? READ_PREVIEW_MARKER : TRUNCATION_MARKER,
      );
    } else {
      modelContent = rendered;
    }

    return {
      terminal_content: this.projectTerminal(payload, rendered, identity, outputPath, readContent),
      model_content: modelContent,
      model_content_format: "tool_result_v2",
      model_content_policy: { truncated: modelContent !== rendered },
      attachments,
    };
  }

  projectForTerminal(
    resultPayload: unknown,
    options: {
      toolName?: string;
      status?: string;
      errorType?: string;
    } = {},
  ): string {
    const toolName = options.toolName ?? "";
    const status = options.status ?? "completed";
    const errorType = options.errorType ?? "";
    const [payload, rendered] = this.preparePayload(resultPayload);
    const identity = this.projectionIdentity(payload, toolName, status, errorType);
    const [outputPath] = this.existingOutputReference(payload);
    const readPayload = this.readPayload(payload);
    const readContent = readPayload ? this.projectReadForModel(readPayload) : null;
    return this.projectTerminal(payload, rendered, identity, outputPath, readContent);
  }

  private preparePayload(resultPayload: unknown): [unknown, string, ImageAttachment[]] {
    let payload = this.canonicalize(this.parseJson(resultPayload));
    let attachments: ImageAttachment[] = [];
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const obj = { ...(payload as Record<string, unknown>) };
      if (Array.isArray(obj.attachments)) {
        attachments = obj.attachments as ImageAttachment[];
      }
      delete obj.attachments;
      payload = obj;
    }
    const rendered = typeof payload === "string" ? payload : jsonDumpsColonSpace(payload);
    if (typeof payload === "string") {
      payload = this.parseJson(payload);
    }
    return [payload, rendered, attachments];
  }

  private projectTerminal(
    payload: unknown,
    rendered: string,
    identity: [boolean, string, string],
    outputPath: string | null,
    readContent: string | null,
  ): string {
    if (
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      (payload as Record<string, unknown>).data &&
      typeof (payload as Record<string, unknown>).data === "object" &&
      !Array.isArray((payload as Record<string, unknown>).data) &&
      ((payload as Record<string, unknown>).data as Record<string, unknown>).task_id
    ) {
      return this.projectTask(payload as Record<string, unknown>, this.terminalMaxBytes, outputPath);
    }
    if (readContent !== null) {
      try {
        const parsedRead = JSON.parse(readContent) as Record<string, unknown>;
        if (parsedRead.ok === false) {
          return readContent;
        }
      } catch {
        // ignore
      }
    }
    const [totalBytes, totalLines] = this.textMetrics(rendered);
    if (totalBytes <= this.terminalMaxBytes) {
      return rendered;
    }
    const readPayload = this.readPayload(payload);
    return this.projectByBytes(
      this.outputText(payload, identity[0], rendered),
      this.terminalMaxBytes,
      totalBytes,
      totalLines,
      identity,
      readPayload ? { ...(readPayload.meta as Record<string, unknown>) } : null,
    );
  }

  private projectTask(payload: Record<string, unknown>, limit: number, outputPath: string | null): string {
    const rawData = payload.data as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawData)) {
      if (k !== "records") {
        data[k] = v;
      }
    }
    const meta: Record<string, unknown> =
      payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta)
        ? { ...(payload.meta as Record<string, unknown>) }
        : {};
    const projected: Record<string, unknown> = { ...payload, data, meta };
    const render = () => JSON.stringify(projected);
    let text = render();
    while (
      (Buffer.byteLength(text, "utf8") > limit || (text.match(/\\n/g)?.length ?? 0) > this.maxPreviewLines) &&
      (data.stdout || data.stderr)
    ) {
      const stdoutStr = typeof data.stdout === "string" ? data.stdout : "";
      const stderrStr = typeof data.stderr === "string" ? data.stderr : "";
      const key = stderrStr.length > stdoutStr.length ? "stderr" : "stdout";
      const cur = typeof data[key] === "string" ? (data[key] as string) : "";
      data[key] = cur.slice(0, Math.floor(cur.length / 2));
      delete data.next_cursor;
      meta.truncated = true;
      if (outputPath) {
        meta.output_path = outputPath;
      }
      meta.paging_notice =
        "Preview was shortened. Read the output_path with file paging, or restart task_control read from start_cursor with a smaller max_output_chars.";
      text = render();
    }
    const shrinkableKeys = new Set([
      "command",
      "cwd",
      "reason",
      "shell_executable",
      "output_path",
      "output_error",
      "persistence_error",
      "paging_notice",
    ]);
    while (Buffer.byteLength(text, "utf8") > limit) {
      const candidates: [Record<string, unknown>, string, number][] = [];
      for (const mapping of [data, meta]) {
        for (const key of Object.keys(mapping)) {
          const val = mapping[key];
          if (shrinkableKeys.has(key) && typeof val === "string" && val.length > 32) {
            candidates.push([mapping, key, Buffer.byteLength(val, "utf8")]);
          }
        }
      }
      if (candidates.length === 0) {
        break;
      }
      candidates.sort((a, b) => b[2] - a[2]);
      const [mapping, key] = candidates[0];
      const cur = mapping[key] as string;
      mapping[key] = `${cur.slice(0, Math.floor(cur.length / 2))}…`;
      meta.truncated = true;
      text = render();
    }
    return text;
  }

  private projectShellForModel(
    payload: Record<string, unknown>,
    output: string,
    outputPath: string | null,
  ): string {
    const data = payload.data as Record<string, unknown>;
    const meta = (payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta))
      ? (payload.meta as Record<string, unknown>)
      : {};
    const notes: string[] = [];
    const status = data.status;
    if (status === "timed_out" || status === "cancelled" || status === "lost" || status === "failed") {
      notes.push(`Command status: ${status}.${data.reason ? ` ${String(data.reason)}` : ""}`);
    }
    const exitCode = data.exit_code;
    if (typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode !== 0) {
      notes.push(`Command exited with code ${exitCode}.`);
    }
    if (status === "running") {
      notes.push(
        `Command is still running as task ${String(data.task_id)}. Continue it with ` +
          `task_control (action read, task_id ${String(data.task_id)}, cursor ${String(data.next_cursor)}), or end your turn and rely on ` +
          "notify=on_exit to deliver completion.",
      );
    }
    if (meta.truncated) {
      notes.push(TRUNCATION_MARKER.replace("{output_path}", outputPath || "the output file").trim());
      const cursor = "records" in data ? data.next_cursor : data.start_cursor;
      if (cursor) {
        notes.push(`Read more output with task_control (action read, task_id ${String(data.task_id)}, cursor ${String(cursor)}).`);
      }
    }
    for (const [key, label] of SHELL_WARNINGS) {
      if (meta[key]) {
        notes.push(`${label}: ${String(meta[key])}`);
      }
    }

    const render = (preview: string): string => {
      const parts = [preview, ...notes].filter(Boolean);
      return parts.join("\n\n") || EMPTY_SHELL_OUTPUT;
    };
    const fits = (t: string): boolean =>
      Buffer.byteLength(t, "utf8") <= this.maxPreviewBytes && this.lineCount(t) <= this.maxPreviewLines;

    const text = render(output);
    if (fits(text)) {
      return text;
    }
    if (!meta.truncated) {
      notes.push(TRUNCATION_MARKER.replace("{output_path}", outputPath || "the output file").trim());
    }
    notes.push("Preview was shortened. Inspect the full output file for omitted content before advancing a task cursor.");
    let low = 0;
    let high = Math.min(output.length, this.maxPreviewBytes);
    let best = render("");
    if (!fits(best)) {
      const fullText = render(output);
      const [tb, tl] = this.textMetrics(fullText);
      return this.projectForModel(
        fullText,
        tb,
        tl,
        this.projectionIdentity(payload, "", "completed", ""),
        outputPath,
      );
    }
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const candidate = render(this.preview(output, count));
      if (fits(candidate)) {
        best = candidate;
        low = count + 1;
      } else {
        high = count - 1;
      }
    }
    return best;
  }

  private projectByBytes(
    text: string,
    limit: number,
    totalBytes: number,
    totalLines: number,
    identity: [boolean, string, string],
    metadata: Record<string, unknown> | null,
  ): string {
    return this.boundedProjection(
      text,
      totalBytes,
      totalLines,
      identity,
      Math.min(text.length, limit),
      candidate => Buffer.byteLength(candidate, "utf8") <= limit,
      {
        outputPath: null,
        includeNotice: false,
        metadata,
      },
    );
  }

  private projectForModel(
    text: string,
    totalBytes: number,
    totalLines: number,
    identity: [boolean, string, string],
    outputPath: string | null,
    truncationMarker: string = TRUNCATION_MARKER,
  ): string {
    return this.boundedProjection(
      text,
      totalBytes,
      totalLines,
      identity,
      Math.min(text.length, this.maxPreviewBytes),
      candidate =>
        Buffer.byteLength(candidate, "utf8") <= this.maxPreviewBytes &&
        this.lineCount(candidate) <= this.maxPreviewLines,
      {
        outputPath,
        includeNotice: true,
        truncationMarker,
      },
    );
  }

  private projectReadForModel(payload: Record<string, unknown>): string {
    const rawMeta = (payload.meta as Record<string, unknown>) || {};
    const meta: Record<string, unknown> = { ...rawMeta };
    delete meta.output_path;
    const offset = Number.isInteger(Number(meta.offset)) ? Number(meta.offset) : 1;
    const dataStr = String(payload.data || "");
    const [header, ...body] = dataStr.split("\n");
    const headerRegex = new RegExp(`^Showing lines ${offset} to (\\d+):$`);
    const matched = headerRegex.exec(header || "");
    if (!matched) {
      return jsonDumpsColonSpace({
        ok: false,
        tool: "read_file",
        error_type: "InvalidReadResult",
        error: "Read result has no valid consecutive line range. Read the original path again.",
        meta: { path: meta.path, offset },
      });
    }
    const lines: string[] = [];
    for (const line of body) {
      if (!line.trimStart().startsWith(`${offset + lines.length} |`)) {
        break;
      }
      lines.push(line);
    }
    const incomplete = offset + lines.length - 1 < Number.parseInt(matched[1], 10);
    if (meta.line_truncated) {
      const truncIdx = lines.findIndex(line => /\.\.\.\(truncated:\d+\)$/.test(line));
      lines.splice(truncIdx >= 0 ? truncIdx : 0);
    }

    const serialize = (count: number): string => {
      const projected: Record<string, unknown> = { ...payload };
      const nextOffset =
        count < lines.length || incomplete || Boolean(meta.line_truncated)
          ? offset + count
          : (meta.next_offset ?? null);
      let dataOut = [
        `Showing lines ${offset} to ${count ? offset + count - 1 : 0}:`,
        ...lines.slice(0, count),
      ].join("\n");
      if (nextOffset !== null && nextOffset !== undefined) {
        dataOut += READ_PAGE_MARKER;
      }
      projected.data = dataOut;
      projected.meta = {
        ...meta,
        limit: count,
        next_offset: nextOffset,
        truncated: nextOffset !== null && nextOffset !== undefined,
        line_truncated: false,
      };
      return jsonDumpsColonSpace(projected);
    };

    if (lines.length > 0 && lines.length + 1 <= this.maxPreviewLines) {
      const full = serialize(lines.length);
      if (Buffer.byteLength(full, "utf8") <= this.maxPreviewBytes) {
        return full;
      }
    }

    let low = 0;
    let high = lines.length;
    let bestCount = 0;
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const candidate = serialize(count);
      if (Buffer.byteLength(candidate, "utf8") <= this.maxPreviewBytes && count + 1 <= this.maxPreviewLines) {
        bestCount = count;
        low = count + 1;
      } else {
        high = count - 1;
      }
    }
    if (bestCount === 0 && (lines.length > 0 || incomplete || Boolean(meta.line_truncated))) {
      return jsonDumpsColonSpace({
        ok: false,
        tool: "read_file",
        error_type: "LineTooLong",
        error: `Line ${offset} was not displayed in full. Use bash/Python to read it in character slices (splitlines()[${offset - 1}][start:end]), then resume at offset ${offset + 1}.`,
        meta: { path: meta.path, offset },
      });
    }
    return serialize(bestCount);
  }

  private projectMutationForModel(payload: Record<string, unknown>): string {
    const projected: Record<string, unknown> = { ...payload };
    const meta: Record<string, unknown> =
      payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta)
        ? { ...(payload.meta as Record<string, unknown>) }
        : {};
    const rawFiles = Array.isArray(meta.files) ? meta.files : [];
    const files: Record<string, unknown>[] = [];
    for (const item of rawFiles) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const itemObj = item as Record<string, unknown>;
      const entry: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(itemObj)) {
        if (k !== "diff") {
          entry[k] = v;
        }
      }
      if (payload.tool === "edit_file" && typeof itemObj.diff === "string" && itemObj.diff) {
        const diff = itemObj.diff;
        const preview = diff.split(/\r?\n/).slice(0, 12).join("\n").slice(0, 1200);
        entry.diff = preview + (preview !== diff ? "\n... diff preview truncated ..." : "");
      }
      files.push(entry);
    }
    projected.meta = { ...meta, files };
    return jsonDumpsColonSpace(projected);
  }

  private boundedProjection(
    text: string,
    totalBytes: number,
    totalLines: number,
    identity: [boolean, string, string],
    maxPreviewChars: number,
    fits: (candidate: string) => boolean,
    options: {
      outputPath: string | null;
      includeNotice: boolean;
      metadata?: Record<string, unknown> | null;
      truncationMarker?: string;
    },
  ): string {
    let low = 0;
    let high = maxPreviewChars;
    let best = this.serializeProjection("", totalBytes, totalLines, identity, options);
    while (low <= high) {
      const previewChars = Math.floor((low + high) / 2);
      const candidate = this.serializeProjection(
        this.preview(text, previewChars),
        totalBytes,
        totalLines,
        identity,
        options,
      );
      if (fits(candidate)) {
        best = candidate;
        low = previewChars + 1;
      } else {
        high = previewChars - 1;
      }
    }
    return best;
  }

  private serializeProjection(
    previewText: string,
    totalBytes: number,
    totalLines: number,
    identity: [boolean, string, string],
    options: {
      outputPath: string | null;
      includeNotice: boolean;
      metadata?: Record<string, unknown> | null;
      truncationMarker?: string;
    },
  ): string {
    const [ok, toolName, errorType] = identity;
    const payload: Record<string, unknown> = { ok, tool: toolName };
    let value = previewText;
    if (options.includeNotice) {
      const marker = options.truncationMarker ?? TRUNCATION_MARKER;
      value += marker.replace("{output_path}", options.outputPath || "the output file");
    }
    if (ok) {
      payload.data = value;
    } else {
      payload.error = value;
      if (errorType) {
        payload.error_type = errorType;
      }
    }
    const meta: Record<string, unknown> = {
      ...(options.metadata ?? {}),
      truncated: true,
      total_bytes: totalBytes,
      total_lines: totalLines,
    };
    if (options.outputPath) {
      meta.output_path = options.outputPath;
    }
    payload.meta = meta;
    return jsonDumpsColonSpace(payload);
  }

  private existingOutputReference(parsed: unknown): [string | null, boolean] {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [null, false];
    }
    const meta = (parsed as Record<string, unknown>).meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      return [null, false];
    }
    const metaObj = meta as Record<string, unknown>;
    const outputPath = typeof metaObj.output_path === "string" && metaObj.output_path ? metaObj.output_path : null;
    return [outputPath, Boolean(metaObj.truncated)];
  }

  private outputText(payload: unknown, ok: boolean, rendered: string): string {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return rendered;
    }
    const obj = payload as Record<string, unknown>;
    const output = ok ? obj.data : obj.error;
    return typeof output === "string" ? output : jsonDumpsColonSpace(output);
  }

  private readPayload(parsed: unknown): Record<string, unknown> | null {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.tool !== "read_file" || typeof obj.data !== "string" || !obj.meta || typeof obj.meta !== "object" || Array.isArray(obj.meta)) {
      return null;
    }
    return obj;
  }

  private projectionIdentity(
    parsed: unknown,
    toolName: string,
    status: string,
    errorType: string,
  ): [boolean, string, string] {
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const ok = typeof obj.ok === "boolean" ? obj.ok : status === "completed";
      const name = typeof obj.tool === "string" && obj.tool ? obj.tool : toolName;
      const resolvedErrorType = typeof obj.error_type === "string" ? obj.error_type : errorType;
      return [ok, name, resolvedErrorType];
    }
    return [status === "completed", toolName, errorType];
  }

  private preview(text: string, limit: number): string {
    if (limit <= 0) {
      return "";
    }
    const marker = "\n\n... preview truncated ...\n\n";
    const available = Math.max(1, limit - marker.length);
    const headChars = Math.floor(available / 2);
    const tailChars = available - headChars;
    return (
      text.slice(0, headChars).replace(/\s+$/, "") +
      marker +
      text.slice(text.length - tailChars).replace(/^\s+/, "")
    );
  }

  private textMetrics(text: string): [number, number] {
    return [Buffer.byteLength(text, "utf8"), this.lineCount(text)];
  }

  private lineCount(text: string): number {
    if (!text) return 0;
    let count = 0;
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) count += 1;
    }
    if (!text.endsWith("\n")) count += 1;
    return count;
  }

  private parseJson(payload: unknown): unknown {
    if (typeof payload !== "string") {
      return payload;
    }
    const text = payload.trim();
    if (!text) {
      return "";
    }
    try {
      return JSON.parse(text);
    } catch {
      return payload;
    }
  }

  private canonicalize(value: unknown): unknown {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const ordered: Record<string, unknown> = {};
      for (const key of PREFERRED_KEYS) {
        if (key in obj) {
          ordered[key] = this.canonicalize(obj[key]);
        }
      }
      const remaining = Object.keys(obj).filter(k => !(k in ordered)).sort();
      for (const key of remaining) {
        ordered[key] = this.canonicalize(obj[key]);
      }
      return ordered;
    }
    if (Array.isArray(value)) {
      return value.map(item => this.canonicalize(item));
    }
    return value;
  }
}
