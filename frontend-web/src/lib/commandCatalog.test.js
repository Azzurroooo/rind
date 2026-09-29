import { describe, expect, it, vi } from "vitest";
import { mergeCommandCatalog, normalizeCatalog } from "./commandCatalog.js";
import { buildCommands, findCommandBySlash, matchingSlashCommands } from "./commands.js";

const local = [
  { id: "model.select", title: "Model", category: "Model", slash: "model", run: vi.fn() },
  { id: "view.theme", title: "Theme", category: "View", slash: "theme", description: "Local theme", run: vi.fn() },
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
    { name: "model", description: "Switch model", usage: "/model [name]", aliases: ["m"] },
    { name: "theme", description: "Runtime theme" },
    { name: "team", description: "Team roster", usage: "/team", aliases: ["t"] },
  ];

  it("keeps the local command for shared names and inherits runtime metadata", () => {
    const merged = mergeCommandCatalog(local, catalog);
    const model = merged.find((command) => command.slash === "model");
    expect(model.id).toBe("model.select");
    expect(model).toMatchObject({ description: "Switch model", usage: "/model [name]", aliases: ["m"], runtime: true });
    expect(merged.find((command) => command.slash === "theme").description).toBe("Local theme");
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

  it("adds /context, /fork and /theme locally", () => {
    const commands = buildCommands({}, catalog);
    for (const slash of ["context", "fork", "theme"]) expect(findCommandBySlash(commands, slash)).not.toBeNull();
  });

  it("routes /context and /fork into the ctx and /theme with an argument to setTheme", () => {
    const ctx = { openContext: vi.fn(), forkSession: vi.fn(), setTheme: vi.fn(), toggleTheme: vi.fn() };
    const commands = buildCommands(ctx, catalog);
    findCommandBySlash(commands, "context").run(ctx, "");
    findCommandBySlash(commands, "fork").run(ctx, "");
    findCommandBySlash(commands, "theme").run(ctx, "dark");
    findCommandBySlash(commands, "theme").run(ctx, "");
    expect(ctx.openContext).toHaveBeenCalled();
    expect(ctx.forkSession).toHaveBeenCalled();
    expect(ctx.setTheme).toHaveBeenCalledWith("dark");
    expect(ctx.toggleTheme).toHaveBeenCalledTimes(1);
  });

  it("matches aliases in the slash menu", () => {
    const commands = buildCommands({}, catalog);
    expect(matchingSlashCommands(commands, "skills").map((command) => command.slash)).toEqual(["skill"]);
  });

  it("lists no server commands until the catalog arrives", () => {
    expect(buildCommands({}).some((command) => command.id.startsWith("server."))).toBe(false);
  });
});
