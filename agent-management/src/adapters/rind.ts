import { createSharedRuntimeClient } from "../../../rind-runtime-client/shared-runtime.js";
import { ManagementError, type Adapter } from "../model.js";
export function createRindAdapter(options: { home?: string; python?: string; repoRoot: string; runtimePath?: string }): Adapter {
  return {
    async start(input, emit) {
      let sequence = 0;
      const client = createSharedRuntimeClient({
        ...options, rindHome: options.home, cwd: input.agent.canonicalWorkspace,
        cliArgs: ["--cwd", input.agent.canonicalWorkspace, "--no-user-question", ...(input.session.runtimeSessionId ? ["--session", input.session.runtimeSessionId] : [])],
        externalTools: input.externalTools,
        onMessage: (message: any) => {
          if (message.event?.type === "turn_started") emit({ type: "working", sequence: ++sequence });
        },
      });
      client.start();
      try {
        const opened = await client.request("initialize");
        // A task's first run creates its conversation, with the member's current
        // folder defaults; later runs reopen it (--session) and are brought to
        // them, so a model the user or Manager chose since applies from this run.
        const info = opened.session_id ? opened : await client.request("session/create", {});
        const runtimeSessionId = info.session_id || info.session?.session_id;
        if (!runtimeSessionId) throw new Error("Rind did not return a runtime session ID.");
        if (opened.session_id) await client.request("rind/folder_defaults/apply", { session_id: runtimeSessionId });
        await client.request("session/subscribe", { session_id: runtimeSessionId });
        let cancelled = false;
        const completion = client.request("session/prompt", {
          session_id: runtimeSessionId, input: input.input, completion_scope: "request",
          transient_system_messages: [{ role: "system", content: input.instructions, _context_kind: "external_tools" }],
        }).then(result => {
          if (cancelled) return { content: "" };
          return { content: result.answer || "" };
        }).catch(error => { if (cancelled) return { content: "" }; throw new ManagementError((error as { code?: string }).code === "EXECUTION_UNCONFIRMED" ? "EXECUTION_UNCONFIRMED" : "EXECUTION_FAILED", String(error)); }).finally(() => client.shutdown());
        return {
          runtimeSessionId, completion,
          async cancel() { cancelled = true; await client.request("session/cancel", { session_id: runtimeSessionId }); await client.shutdown(); },
        };
      } catch (error) { await client.shutdown(); throw new ManagementError((error as { code?: string }).code === "EXECUTION_UNCONFIRMED" ? "EXECUTION_UNCONFIRMED" : "EXECUTION_FAILED", String(error)); }
    },
  };
}
