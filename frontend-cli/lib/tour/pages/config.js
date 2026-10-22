import { demoInfo, SKILL_SOURCES } from "./demo.js";
import { assistant, note, shell, shellOut, slashResult, startup, submit, tool, turnDone, turnStart, type } from "./steps.js";

export const configPages = [
  {
    id: "config.init",
    feature: "/init /skill",
    title: "Project docs & skills",
    steps: [
      note([
        "RIND.md is the project's standing instructions — Rind drafts it from",
        "your codebase and injects it into context every turn.",
      ]),
      shell("rind"),
      startup(demoInfo({ session: "20260917_101530_ab12cd34" })),
      type("/init", [
        "Run /init in a project folder to have Rind inspect your repo and draft RIND.md.",
      ]),
      submit(),
      slashResult({ text: "Initializing project RIND.md: ~/demo/RIND.md" }),
      turnStart("Initialize project RIND.md at ~/demo/RIND.md"),
      tool("read_file", "README.md", { status: "ok", output: "Parser demo. Run npm test to check changes.", durationMs: 120 }, null, [
        "Rind reads README.md and package scripts to learn how the project is built and tested.",
      ]),
      tool("edit_file", "RIND.md", { status: "ok", output: "drafted project doc", durationMs: 600 }, null, [
        "It writes a concise RIND.md that future conversations load automatically.",
      ]),
      assistant("Drafted RIND.md with the project overview and test command. Please review it before your next task."),
      turnDone(3800, 2, 0),
      type("/skill", [
        "Run /skill to see active and importable skills grouped by source.",
      ]),
      submit(),
      slashResult({
        text: "Skills",
        display: {
          type: "skills",
          sources: SKILL_SOURCES,
          problems: [],
        },
      }),
      note([
        "Skills come from .rind/skills, ~/.rind/skills and your Claude and Codex skills (/settings import).",
        "A matching task reads its SKILL.md; $name uses one now. Review the RIND.md from /init.",
      ]),
    ],
  },
  {
    id: "config.folder", feature: "Folder defaults", title: "Per-project selection",
    steps: [
      note(["Give each project its own connection, model and effort defaults.", "New conversations and managed agent tasks use them; existing sessions keep their saved selection."]),
      shell("rind config set model GPT-6-Astra --connection zai --folder", [
        "Pin the folder's default model and connection from the shell (or press f inside /model).",
      ]),
      shellOut(["New conversations in ~/demo start with:", "  model   zai / GPT-6-Astra  (this folder)", "  effort  xhigh  (settings.json)"]),
      shell("rind config set effort xhigh --folder", [
        "Pin the folder's default reasoning effort to xhigh (or press f inside /effort).",
      ]),
      shellOut(["New conversations in ~/demo start with:", "  model   zai / GPT-6-Astra  (this folder)", "  effort  xhigh  (this folder)"]),
      note(["Folder defaults live in RIND_HOME/workspaces.json, not project settings. Worktrees inherit the main repository unless overridden.", "Keys stay in auth.json. --folder alone means the current directory."]),
      shell("rind config unset model --folder", [
        "Use rind config unset to remove a folder override and fall back to global settings.json.",
      ]),
      shellOut(["New conversations in ~/demo start with:", "  model   zai / GPT-6-Astra  (settings.json)", "  effort  xhigh  (this folder)"]),
      shell("rind config unset effort --folder"),
      shellOut(["New conversations in ~/demo start with:", "  model   zai / GPT-6-Astra  (settings.json)", "  effort  xhigh  (settings.json)"]),
      note(["Unset removes the folder override so the normal fallback applies again. This tour does not write any settings."]),
    ],
  },
];
