import { describe, expect, it, vi } from "vitest";
import { buildCommands, COMMAND_CATEGORIES, filterCommands, findCommandBySlash, keybindHint, matchingSlashCommands } from "./commands.js";

function stubCtx() {
  return {
    newSession: vi.fn(),
    focusSessions: vi.fn(),
    focusModel: vi.fn(),
    focusEffort: vi.fn(),
    focusGoal: vi.fn(),
    compact: vi.fn(),
    stopTurn: vi.fn(),
    scrollToLatest: vi.fn(),
    toggleTheme: vi.fn(),
    clearInput: vi.fn(),
    focusComposer: vi.fn(),
    showHelp: vi.fn(),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    runGoal: vi.fn(),
    runServerSlash: vi.fn(),
  };
}

describe("commands — single registry (audit #9)", () => {
  const commands = buildCommands(stubCtx());

  it("contains the twelve required commands", () => {
    const ids = commands.map((command) => command.id);
    for (const id of ["session.new", "session.switch", "model.select", "model.effort", "context.compact", "context.goal", "turn.stop", "transcript.latest", "view.theme", "transcript.clearInput", "view.focusComposer", "view.help"]) {
      expect(ids).toContain(id);
    }
  });

  it("every command carries id/title/category/keywords and a run function", () => {
    for (const command of commands) {
      expect(command.id).toBeTruthy();
      expect(command.title).toBeTruthy();
      expect(command.category).toBeTruthy();
      expect(typeof command.run).toBe("function");
      expect(Object.values(COMMAND_CATEGORIES)).toContain(command.category);
    }
  });

  it("keybind hints come from the registry only (stop declares Esc ×2)", () => {
    const stop = commands.find((command) => command.id === "turn.stop");
    expect(keybindHint(stop)).toBe("Esc ×2");
    expect(keybindHint(commands.find((command) => command.id === "session.new"))).toBe("");
  });

  it("run(ctx) dispatches into the provided context", () => {
    const ctx = stubCtx();
    const built = buildCommands(ctx);
    built.find((command) => command.id === "session.new").run(ctx, "");
    built.find((command) => command.id === "turn.stop").run(ctx, "");
    built.find((command) => command.id === "view.theme").run(ctx, "");
    built.find((command) => command.id === "transcript.clearInput").run(ctx, "");
    built.find((command) => command.id === "view.focusComposer").run(ctx, "");
    built.find((command) => command.id === "view.help").run(ctx, "");
    built.find((command) => command.id === "context.compact").run(ctx, "");
    built.find((command) => command.id === "transcript.latest").run(ctx, "");
    expect(ctx.newSession).toHaveBeenCalledTimes(1);
    expect(ctx.stopTurn).toHaveBeenCalledTimes(1);
    expect(ctx.toggleTheme).toHaveBeenCalledTimes(1);
    expect(ctx.clearInput).toHaveBeenCalledTimes(1);
    expect(ctx.focusComposer).toHaveBeenCalledTimes(1);
    expect(ctx.showHelp).toHaveBeenCalledTimes(1);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(ctx.scrollToLatest).toHaveBeenCalledTimes(1);
  });

  it("model/effort/goal focus without an argument and act with one", () => {
    const ctx = stubCtx();
    const built = buildCommands(ctx);
    built.find((command) => command.id === "model.select").run(ctx, "");
    expect(ctx.focusModel).toHaveBeenCalledTimes(1);
    built.find((command) => command.id === "model.select").run(ctx, "gpt-x");
    expect(ctx.setModel).toHaveBeenCalledWith("gpt-x");
    built.find((command) => command.id === "model.effort").run(ctx, "high");
    expect(ctx.setEffort).toHaveBeenCalledWith("high");
    built.find((command) => command.id === "context.goal").run(ctx, "clear");
    expect(ctx.runGoal).toHaveBeenCalledWith("clear");
  });

  it("server slash commands route through runServerSlash", () => {
    const ctx = stubCtx();
    const built = buildCommands(ctx);
    built.find((command) => command.id === "server.doctor").run(ctx, "verbose");
    expect(ctx.runServerSlash).toHaveBeenCalledWith("doctor", "verbose");
  });
});

describe("commands — palette fuzzy filter", () => {
  const commands = buildCommands(stubCtx());

  it("empty query returns everything in registry order", () => {
    expect(filterCommands(commands, "")).toEqual(commands);
    expect(filterCommands(commands, "   ")).toEqual(commands);
  });

  it("matches titles, keywords and slash names; prefix beats subsequence", () => {
    const theme = filterCommands(commands, "主题");
    expect(theme[0].id).toBe("view.theme");
    expect(filterCommands(commands, "stop")[0].id).toBe("turn.stop");
    expect(filterCommands(commands, "new")[0].id).toBe("session.new");
  });

  it("returns no nonsense matches for gibberish", () => {
    expect(filterCommands(commands, "zzzzqqqq")).toEqual([]);
  });
});

describe("commands — slash sourcing for the Composer", () => {
  const commands = buildCommands(stubCtx());

  it("prefix match on slash names only", () => {
    const names = matchingSlashCommands(commands, "m").map((command) => command.slash);
    expect(names).toContain("model");
    expect(names).not.toContain("new");
  });

  it("exact resolution finds the command behind a submitted slash", () => {
    expect(findCommandBySlash(commands, "theme").id).toBe("view.theme");
    expect(findCommandBySlash(commands, "doctor").id).toBe("server.doctor");
    expect(findCommandBySlash(commands, "nope")).toBeNull();
  });
});
