import { demoInfo } from "./demo.js";
import { assistant, note, shell, shellOut, startup, submit, tool, turnDone, type } from "./steps.js";

export const teamPages = [
  {
    id: "team.create", feature: "← Agents", title: "Create a Team",
    steps: [
      note(["Teams connect existing folders. No prescribed directory layout or agent manifest is needed.", "Press Left from an empty prompt for the interactive page, or use the commands below."]),
      shell("rind agents team create product"),
      shellOut(["Team product created. Add folders and select a leader."]),
      shell("rind agents team add product ~/demo"),
      shellOut(["demo joined product. The first member becomes leader."]),
      note(["The team registry lives in your RIND_HOME. Adding a folder does not move its files."]),
      shell("rind", null, "~/demo"),
      startup({ ...demoInfo({ session: "demo-team" }), management_label: "Team: product" }),
      note(["Enter on a member lists its sessions; choose one to open chat. Esc returns to your current conversation.", "Manager is available in the Agents navigation."]),
    ],
  },
  {
    id: "team.add", feature: "Any folder", title: "Add a specialist",
    steps: [
      note(["A specialist keeps its own workspace, project skills and files. Position and responsibility are optional."]),
      shell("rind agents team add product ~/finance --position Finance --responsibility 'Reconcile invoices'"),
      shellOut(["finance joined product. Workspace: ~/finance"]),
      note(["If this folder already belongs to another team, choose an independent copy (recommended) or explicitly share it.", "Shared folders run one task at a time; each team's conversations and reports remain separate."]),
      shell("rind agents open product/finance"),
      startup({ ...demoInfo({ cwd: "~/finance", session: "demo-finance" }), management_label: "Team: product" }),
      note(["You can talk to any member directly. The team observes activity without broadcasting this private conversation."]),
    ],
  },
  {
    id: "team.worktree", feature: "Worktrees", title: "Parallel features",
    steps: [
      note(["Different feature worktrees have different directories, so they can run in parallel."]),
      shell("rind agents team worktree product search ~/demo feature/search"),
      shellOut(["Created search and registered it in product. Branch: feature/search"]),
      shell("rind agents team worktree product export ~/demo feature/export"),
      shellOut(["Created export and registered it in product. Branch: feature/export"]),
      note(["The leader can create workspaces and worktrees within the team's creation root too.", "Only members registered in the current team can receive team tasks."]),
    ],
  },
  {
    id: "team.work", feature: "Team tasks", title: "Team delivery",
    steps: [
      note(["Give the leader the outcome you want. It assigns tasks, receives child reports, and integrates delivery.", "Humans handle decisions and blockers, rather than polling each parallel agent."]),
      shell("rind", null, "~/demo"),
      startup({ ...demoInfo({ session: "demo-team" }), management_label: "Team: product" }),
      type("Ask the registered reviewer to check the parser and deliver a short findings report."), submit(),
      tool("agent_management", "assignTask", { status: "ok", output: "Reviewer task queued; delivery will wake the leader.", durationMs: 120 }),
      assistant("The review is assigned. Press Left from an empty prompt to see its status and delivery. A blocker names who must respond and what is needed."),
      turnDone(2500, 1, 0),
      note(["A completed process is not a completed task: delivery also requires a report with summary and evidence.", "If a host disappears, its status becomes Unconfirmed. Confirm the old process stopped before retrying."]),
    ],
  },
];
