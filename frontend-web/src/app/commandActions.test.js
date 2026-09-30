import { describe, expect, it, vi } from "vitest";
import { createCommandActions } from "./commandActions.js";
import { buildCommands } from "../lib/commands.js";

const removed = ["config", "context", "doctor", "login", "logout", "model", "effort", "session", "sessions", "theme"];
function setup() {
  const request = vi.fn(async () => ({ text: "Status", display: { type: "status", entries: [], usage: [] } }));
  const dispatchMessage = vi.fn();
  const dispatchConversation = vi.fn();
  const commandList = buildCommands({}, [
    ...removed.map((name) => ({ name, aliases: [`alias_${name}`] })),
    { name: "status", aliases: ["st", "model"] },
  ]);
  const ctx = { commandList, dispatchConversation, call: { current: { dispatchMessage } }, refs: { client: { current: { request } }, info: { current: { session_id: "s" } } } };
  return { ...createCommandActions(ctx), request, dispatchMessage, dispatchConversation, commandList, refs: ctx.refs };
}

describe("surface slash policy", () => {
  it("does not append a late status result to a different session", async () => {
    const actions = setup();
    let finish;
    actions.request.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = actions.runSlashCommand("/status");
    actions.refs.info.current.session_id = "other";
    finish({ text: "Old session", display: { type: "status", entries: [], usage: [] } });
    await pending;
    expect(actions.dispatchConversation).not.toHaveBeenCalled();
  });
  it("cannot execute removed commands or their aliases through the runtime fallback", async () => {
    const actions = setup();
    for (const name of removed.flatMap((name) => [name, `alias_${name}`])) {
      await actions.runSlashCommand(`/${name} value`);
    }
    await actions.runSlashCommand("/unknown");
    await actions.runServerSlash("model", "x");
    expect(actions.request).not.toHaveBeenCalled();
    expect(actions.dispatchMessage).toHaveBeenCalledWith("system", expect.stringContaining("Command unavailable"));
  });

  it("preserves structured status data and uses the canonical command for aliases", async () => {
    const actions = setup();
    await actions.runSlashCommand("/st");
    expect(actions.request).toHaveBeenCalledWith("rind/command/execute", { session_id: "s", input: "/status" });
    expect(actions.dispatchConversation).toHaveBeenCalledWith(expect.objectContaining({ display: { type: "status", entries: [], usage: [] } }));
  });

  it("help only describes real slash commands; GUI actions remain in the palette", () => {
    const actions = setup();
    actions.showHelp();
    const text = actions.dispatchMessage.mock.calls[0][1];
    for (const name of removed) expect(text).not.toMatch(new RegExp(`/${name}(?:[ .]|$)`));
    expect(text).toContain("/status");
    expect(actions.commandList.find((command) => command.id === "model.select")).toBeTruthy();
  });
});
