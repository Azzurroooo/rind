import { demoInfo, DELEGATES } from "./demo.js";
import {
  assistant,
  exitRind,
  menu,
  note,
  result,
  shell,
  shellOut,
  slashResult,
  startup,
  submit,
  tool,
  turnDone,
  type,
} from "./steps.js";

const PROJECT = demoInfo({ session: "20260917_101530_ab12cd34" });
const MAIN = demoInfo({ cwd: "~/demo/.aiteam/agents/main-agent", session: "20260917_103001_eff01a23" });

function enterMainAgent() {
  return [
    shell("cd .aiteam/agents/main-agent"),
    shell("rind"),
    startup(MAIN, [
      "Starting rind inside an agent directory makes this session that agent:",
      "delegation and /team commands operate on the team project.",
    ]),
  ];
}

export const teamPages = [
  {
    id: "team.create",
    title: "Create a Team",
    steps: [
      note([
        "A Rind Team is filesystem-native: every specialist is a directory with",
        "its own workspace, tools and persistent history under .aiteam/.",
      ]),
      shell("rind"),
      startup(PROJECT, [
        "Teams start in the project root — a regular session does the creating.",
      ]),
      type("/team create"),
      submit(),
      tool("edit_file", ".aiteam/project.json", { status: "ok", output: "created team project", durationMs: 240 }),
      result("Team created", ".aiteam ready — main agent: main-agent"),
      type("/exit"),
      exitRind(),
      shell("ls .aiteam/agents"),
      shellOut(["main-agent"]),
      ...enterMainAgent(),
      note([
        "That is the whole loop: create once, then work from the main agent.",
        "Next pages add specialists, blueprints and delegation.",
      ]),
    ],
  },
  {
    id: "team.add",
    title: "Add a specialist",
    steps: [
      note([
        "Specialists are one command away. Each gets a stable id, its own",
        "workspace, and a capsule that survives across sessions.",
      ]),
      ...enterMainAgent(),
      type('/team add "Owns the test suite and CI wiring"'),
      submit(),
      tool("agent_create", "test-specialist", { status: "ok", output: "capsule created", durationMs: 900 }),
      result("Team Agent created", "test-specialist · .aiteam/agents/test-specialist"),
      type("/team list"),
      submit(),
      slashResult({
        text: [
          "Team Agents:",
          "- main-agent | Main | Coordinates the project",
          "- test-specialist | Test Specialist | Owns the test suite and CI wiring",
        ].join("\n"),
      }),
      note([
        "The capsule directory keeps the agent's history and files, so next",
        "week's task starts from everything it already knows.",
      ]),
    ],
  },
  {
    id: "team.blueprint",
    title: "Create from blueprint",
    steps: [
      note([
        "Blueprints are curated specialist templates — faster than describing",
        "a role from scratch, and consistent across projects.",
      ]),
      ...enterMainAgent(),
      type("/team blueprint"),
      submit(),
      slashResult({
        text: [
          "Available blueprints:",
          "- reviewer | Code Reviewer | Reviews diffs against the project rules",
          "- documenter | Documenter | Keeps README and RIND.md current",
        ].join("\n"),
      }),
      menu({
        kind: "choice",
        input: "/team blueprint",
        items: [
          "reviewer · Code Reviewer · Reviews diffs against the project rules",
          "documenter · Documenter · Keeps README and RIND.md current",
        ],
        selected: 0,
        target: 1,
      }, [
        "↑↓ select, enter confirm — the interactive menu you just saw is the",
        "real one.",
      ]),
      result("Blueprint applied", "documenter · .aiteam/agents/documenter"),
      note([
        "The new agent is ready for delegation immediately, with the",
        "blueprint's tool policy and prompt baked into its capsule.",
      ]),
    ],
  },
  {
    id: "team.work",
    title: "Work inside the team",
    steps: [
      note([
        "Delegation is just a prompt: the main agent picks the specialist from",
        "the team catalog and hands over a task.",
      ]),
      ...enterMainAgent(),
      type("Have the test specialist cover the unicode parser cases"),
      submit(),
      menu({
        kind: "delegates",
        delegates: DELEGATES,
        delegate: DELEGATES[0],
      }, [
        "ctrl+b shows running delegates too — watch progress without",
        "interrupting anyone.",
      ]),
      tool("delegate", "test-specialist", { status: "ok", output: "6 cases added to test/tokenizer.test.js", durationMs: 12400 }),
      assistant([
        "test-specialist finished: the unicode cases live in",
        "`test/tokenizer.test.js`, and the handoff summary is published at",
        "`.aiteam/agents/test-specialist/handoffs/unicode.md`.",
      ]),
      turnDone(24800, 2, 0),
      note([
        "Results come back as real files in the team directories — nothing",
        "lives only in a chat transcript.",
      ]),
    ],
  },
];
