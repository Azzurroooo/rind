import type { RuntimeEventEnvelope } from "../preload/types.ts"

/** Attach accepted prompt text to the existing turn boundary, for every surface.
 * No new event/sequence is invented and no worker protocol changes are needed.
 * A prompt response arrives at turn completion, so it cannot drive live input UI. */
export class RuntimeInputs {
  private prompts = new Map<string, { sessionId: string; input: string; inputId: string }>()

  begin(requestId: string, method: string, params: Record<string, unknown>) {
    if (method !== "session/prompt" || typeof params.input !== "string" || !params.input.trim() || params.resume) return
    this.prompts.set(requestId, {
      sessionId: String(params.session_id || ""), input: params.input,
      inputId: typeof params.client_input_id === "string" ? params.client_input_id : requestId,
    })
  }

  finish(requestId: string) { this.prompts.delete(requestId) }
  clear() { this.prompts.clear() }

  enrich(envelope: RuntimeEventEnvelope): RuntimeEventEnvelope {
    if (envelope.event.type !== "turn_started" || !Number(envelope.event.user_message_chars)) return envelope
    for (const [id, prompt] of this.prompts) {
      if (prompt.sessionId !== envelope.session_id) continue
      this.prompts.delete(id)
      return { ...envelope, event: { ...envelope.event, input: prompt.input, client_input_id: prompt.inputId } }
    }
    return envelope
  }
}
