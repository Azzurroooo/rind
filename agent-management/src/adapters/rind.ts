import { createRuntimeClient } from "../../../rind-runtime-client/runtime-client.js";
import { ManagementError, type Adapter } from "../model.js";
export function createRindAdapter(options: { home?: string; python?: string; repoRoot: string; runtimePath?: string }): Adapter {
  return {
    async start(input, emit) {
      let sequence = 0;
      const client = createRuntimeClient({
        ...options, rindHome: options.home, cwd: input.agent.canonicalWorkspace,
        cliArgs: ["--cwd", input.agent.canonicalWorkspace, "--no-user-question", ...(input.session.runtimeSessionId ? ["--session", input.session.runtimeSessionId] : [])],
        externalTools: input.externalTools,
        onMessage: (message: any) => {
          if (message.event?.type === "turn_started") emit({ type: "working", sequence: ++sequence });
          if (message.event?.type === "user_question_requested") emit({ type: "needs_input", sequence: ++sequence });
        },
      });
      client.start();
      try {
        const info = await client.request("initialize");
        const runtimeSessionId = info.session_id || info.session?.session_id;
        if (!runtimeSessionId) throw new Error("Rind did not return a runtime session ID.");
        await client.request("session/subscribe", { session_id: runtimeSessionId });
        let cancelled = false;
        const completion = client.request("session/prompt", {
          session_id: runtimeSessionId, input: input.task.brief, completion_scope: "request",
          transient_system_messages: [{ role: "system", content: input.instructions, _context_kind: "external_tools" }],
        }).then(result => {
          if (cancelled) return { content: "" };
          return { content: result.answer || "" };
        }).catch(error => { if (cancelled) return { content: "" }; throw new ManagementError("EXECUTION_FAILED", String(error)); }).finally(() => client.shutdown());
        return {
          runtimeSessionId, completion,
          async cancel() { cancelled = true; await client.request("session/cancel", { session_id: runtimeSessionId }); await client.shutdown(); },
        };
      } catch (error) { await client.shutdown(); throw new ManagementError("EXECUTION_FAILED", String(error)); }
    },
  };
}
