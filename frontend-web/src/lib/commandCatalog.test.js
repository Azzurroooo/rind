import { describe, expect, it, vi } from "vitest";
import { mergeCommandCatalog, normalizeCatalog } from "./commandCatalog.js";
import { buildCommands, findCommandBySlash, matchingSlashCommands } from "./commands.js";

const local = [
  { id: "context.goal", title: "Goal", category: "Context", slash: "goal", run: vi.fn() },
  { id: "session.fork", title: "Fork", category: "Session", slash: "fork", description: "Local fork", run: vi.fn() },
];

describe("commandCatalog — normalize", () => {
  it("drops blanks, duplicates, leading slashes and terminal-only commands", () => {
    const out = normalizeCatalog([
      { name: "/Status", description: " Show ", aliases: ["/st", "status"] },
      { name: "status" },
      { name: "" },
      { name: "exit" },
      null,
    ]);
    expect(out).toEqual([{ name: "status", description: "Show", usage: "", aliases: ["st"] }]);
    expect(normalizeCatalog(undefined)).toEqual([]);
  });
});

describe("commandCatalog — merge", () => {
  const catalog = [
    { name: "goal", description: "Set a goal", usage: "/goal [objective]", aliases: ["g"] },
    { name: "fork", description: "Runtime fork" },
    { name: "team", description: "Team roster", usage: "/team", aliases: ["t"] },
  ];

  it("keeps the local command for shared names and inherits runtime metadata", () => {
    const merged = mergeCommandCatalog(local, catalog);
    const goal = merged.find((command) => command.slash === "goal");
    expect(goal.id).toBe("context.goal");
    expect(goal).toMatchObject({ description: "Set a goal", usage: "/goal [objective]", aliases: ["g"], runtime: true });
    expect(merged.find((command) => command.slash === "fork").description).toBe("Local fork");
  });

  it("adds runtime-only commands that run through runServerSlash", () => {
    const runServerSlash = vi.fn();
    const merged = mergeCommandCatalog(local, catalog, runServerSlash);
    const team = merged.find((command) => command.slash === "team");
    expect(team).toMatchObject({ id: "server.team", title: "Team", category: "Server commands", description: "Team roster" });
    team.run({}, "list");
    expect(runServerSlash).toHaveBeenCalledWith("team", "list");
    const ctxRunner = vi.fn();
    team.run({ runServerSlash: ctxRunner }, "");
    expect(ctxRunner).toHaveBeenCalledWith("team", "");
  });

  it("never duplicates a name and never mutates its inputs", () => {
    const frozen = Object.freeze([...local]);
    const merged = mergeCommandCatalog(frozen, catalog);
    const slashes = merged.map((command) => command.slash);
    expect(new Set(slashes).size).toBe(slashes.length);
    expect(local[0].aliases).toBeUndefined();
  });
});

describe("commands — registry with the runtime catalog", () => {
  const catalog = [{ name: "skill", description: "Skills", aliases: ["skills"] }];

  it("keeps GUI actions in the palette without slash forms", () => {
    const ctx = { openContext: vi.fn(), forkSession: vi.fn(), toggleTheme: vi.fn() };
    const commands = buildCommands(ctx, catalog);
    for (const name of ["config", "context", "doctor", "login", "logout", "model", "effort", "session", "sessions", "theme"]) {
      expect(findCommandBySlash(commands, name)).toBeNull();
    }
    commands.find((command) => command.id === "context.inspect").run(ctx);
    commands.find((command) => command.id === "view.theme").run(ctx);
    findCommandBySlash(commands, "fork").run(ctx);
    expect(ctx.openContext).toHaveBeenCalled();
    expect(ctx.toggleTheme).toHaveBeenCalled();
    expect(ctx.forkSession).toHaveBeenCalled();
  });

  it("matches aliases in the slash menu", () => {
    const commands = buildCommands({}, catalog);
    expect(matchingSlashCommands(commands, "skills").map((command) => command.slash)).toEqual(["skill"]);
  });

  it("lists no server commands until the catalog arrives", () => {
    expect(buildCommands({}).some((command) => command.id.startsWith("server."))).toBe(false);
  });
});
