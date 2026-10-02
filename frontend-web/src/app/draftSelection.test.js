import { describe, expect, it, vi } from "vitest";
import { createTurnActions } from "./turnActions.js";
import { createSessionActions } from "./sessionActions.js";
import { methods } from "../methods.js";

function context() {
  const ref = (current) => ({ current });
  const ctx = {
    input: "", selectedWorkspace: "/work", endpoint: "local", info: {},
    setInput: vi.fn(), setInfo: vi.fn(), setCurrentModel: vi.fn(), setCurrentProvider: vi.fn(), setSelectedWorkspace: vi.fn(), dispatchConversation: vi.fn(),
    refs: { info: ref({ session_id: "", workspace_root: "/work", model: "shared", reasoning_effort: "medium" }), currentModel: ref("shared"), currentProvider: ref("first"), client: ref(null), sessionLoad: ref(0), connectionRun: ref(0), input: ref(""), drafts: ref({}), promptStarts: ref(new Map()), compactions: ref(new Map()), conv: ref({}), switching: ref(false) },
  };
  const request = vi.fn(async (method) => method === methods.sessionNew ? { session_id: "created", model: "shared", provider: "first", reasoning_effort: "medium" } : {});
  ctx.refs.client.current = { request };
  ctx.call = ref({ dispatchMessage: vi.fn(), refreshSessions: vi.fn(), loadSession: vi.fn(async (id) => { ctx.refs.info.current.session_id = id; }) });
  return ctx;
}

describe("new-session selection", () => {
  it("keeps provider and effort locally, then applies both before the first prompt", async () => {
    const ctx = context();
    const actions = createTurnActions(ctx);
    await actions.setModel({ modelId: "shared", providerId: "second" });
    await actions.setEffort("high");
    expect(ctx.refs.client.current.request).not.toHaveBeenCalled();
    await actions.submit("hello");
    const calls = ctx.refs.client.current.request.mock.calls;
    expect(calls.map(([method]) => method)).toEqual([methods.sessionNew, methods.modelSet, methods.modelEffort, methods.sessionPrompt]);
    expect(calls[1][1]).toEqual({ session_id: "created", model: "shared", provider_id: "second" });
    expect(calls[2][1]).toEqual({ session_id: "created", reasoning_effort: "high" });
  });

  it("does not send using the wrong selection when applying the draft fails", async () => {
    const ctx = context();
    const actions = createTurnActions(ctx);
    await actions.setEffort("max");
    const base = ctx.refs.client.current.request.getMockImplementation();
    ctx.refs.client.current.request.mockImplementation(async (method, params) => {
      if (method === methods.modelEffort) throw new Error("unavailable");
      return base(method, params);
    });
    await actions.submit("keep this message");
    expect(ctx.refs.client.current.request.mock.calls.some(([method]) => method === methods.sessionPrompt)).toBe(false);
    expect(ctx.setInput).toHaveBeenLastCalledWith("keep this message");
  });

  it("requests the full catalog without an empty session id and preserves a draft selected during loading", async () => {
    const ctx = context();
    let finish;
    ctx.refs.client.current.request.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const loading = createSessionActions(ctx).refreshModels("");
    expect(ctx.refs.client.current.request).toHaveBeenCalledWith(methods.modelList, {});
    ctx.refs.currentModel.current = "chosen";
    finish({ models: [{ id: "a", provider_id: "first" }, { id: "b", provider_id: "second" }], current: { model_id: "default", provider_id: "first" } });
    await loading;
    expect(ctx.setCurrentModel).not.toHaveBeenCalled();
    expect(ctx.setInfo.mock.calls[0][0]({ model: "chosen" })).toMatchObject({ model: "chosen", models: expect.arrayContaining([expect.objectContaining({ id: "b", providerId: "second" })]) });
  });
});
