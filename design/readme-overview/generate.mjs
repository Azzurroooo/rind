// Render the bilingual README hero artwork using Rind's visual identity.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const COLORS = {
  paper: "#f4f3eb",
  ink: "#22271f",
  muted: "#64685e",
  line: "#d5d7ca",
  green: "#334c37",
  lime: "#d6df9a",
  dark: "#19241e",
  light: "#ebeee4",
  dim: "#a5b0a4",
  dark_line: "#3d4a3f",
};

const COPY = {
  en: {
    title: "Rind — Light by design. Folders are agents.",
    description:
      "Rind is a lightweight, open-source local coding agent. Every folder is a teammate: add folders to a team, brief the lead, let members delegate and report with evidence, and follow every team in Agents Management. One lean worker loads sessions on demand and keeps history on disk; the team control plane, runtime protocol, tools and skills are open to reuse.",
    headline: "Light by design.",
    serif: "Folders are agents.",
    subhead: "A lightweight, open-source local coding agent. Every folder is a teammate.",
    folders_tag: "FOLDERS ARE AGENTS",
    folders_title: "Every folder is a teammate.",
    roles: ["Lead", "Frontend", "Backend", "QA"],
    folders_note: "Its files, RIND.md, skills and model make the agent.",
    team_tag: "TEAM AGENTS",
    team_title: "Delegate. Report. Deliver.",
    steps: ["Brief", "Delegate", "Report", "Deliver"],
    step_notes: [
      "Give the lead one goal.",
      "Members work in their own folders.",
      "Evidence and files come back.",
      "The lead wakes, reviews and delivers.",
    ],
    team_note: "Work returns and wakes the lead. Nobody polls.",
    columns: [
      [
        "LIGHT BY DESIGN",
        "One lean worker.",
        "",
        [
          "Loads on demand, releases when idle.",
          "History stays on disk as JSONL.",
          "No database. No cloud service.",
        ],
      ],
      [
        "AGENTS MANAGEMENT",
        "Every team, one page.",
        "← on an empty prompt",
        [
          "Inbox · Manager · Tasks · Reports",
          "You approve anything destructive.",
        ],
      ],
      [
        "BUILD ON IT",
        "Small parts, open seams.",
        "",
        [
          "An agent-neutral team control plane.",
          "A JSONL runtime protocol.",
          "Pluggable tools, providers, skills.",
        ],
      ],
    ],
    footer: "ALSO · rind tour · rind run · rind send · Desktop · Web · Gateway",
  },
  "zh-CN": {
    title: "Rind — 轻装上阵。目录即智能体。",
    description:
      "Rind 是轻量、开源的本地编码 Agent。每个目录都是队友：把目录加入团队，给主 Agent 布置目标，成员逐级委派并附证据汇报，在 Agents Management 中跟进所有团队。一个精简的 worker 按需加载会话、历史保存在磁盘；团队控制平面、Runtime 协议、工具与技能均可复用和扩展。",
    headline: "轻装上阵。",
    serif: "目录即智能体。",
    subhead: "轻量、开源的本地编码 Agent。每个目录，都是队友。",
    folders_tag: "目录即智能体",
    folders_title: "每个目录，都是队友。",
    roles: ["主 Agent", "前端", "后端", "测试"],
    folders_note: "目录里的文件、RIND.md、技能与模型，就是这个 Agent。",
    team_tag: "多 AGENT 协同",
    team_title: "委派、汇报、交付。",
    steps: ["布置", "委派", "汇报", "交付"],
    step_notes: [
      "你只需给主 Agent 一个目标。",
      "成员在各自的目录里工作。",
      "证据与文件随报告交回。",
      "主 Agent 被唤醒，审阅后交付。",
    ],
    team_note: "工作交回即唤醒主 Agent，无需轮询。",
    columns: [
      [
        "轻量是初衷",
        "一个精简的 worker。",
        "",
        [
          "按需加载，空闲释放。",
          "会话以 JSONL 保存在磁盘。",
          "无需数据库，不依赖云服务。",
        ],
      ],
      [
        "AGENTS MANAGEMENT",
        "所有团队，一页看清。",
        "← 空输入时按左键",
        [
          "Inbox · Manager · 任务 · 报告",
          "破坏性操作，先经你批准。",
        ],
      ],
      [
        "可复用 · 可扩展",
        "小模块，开放接口。",
        "",
        [
          "与具体 Agent 无关的团队控制平面。",
          "JSONL Runtime 协议。",
          "工具、服务商与技能均可扩展。",
        ],
      ],
    ],
    footer: "更多 · rind tour · rind run · rind send · 桌面端 · Web · 消息网关",
  },
};

const TREE = ["~/lead", "├─ ~/web", "├─ ~/api", "└─ ~/qa"];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function roundHalfToEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function sculpture() {
  const rings = [];
  for (let index = 0; index < 64; index += 1) {
    const angle = (index / 64) * Math.PI * 2;
    const segments = [];
    for (let segment = 0; segment < 48; segment += 1) {
      const v = (segment / 48) * Math.PI * 2;
      const radius = 148 + 64 * Math.cos(v);
      const x = radius * Math.cos(angle);
      const y = radius * Math.sin(angle);
      const z = 64 * Math.sin(v);
      const tilted = y * 0.59 - z * 0.81;
      const px = (300 + x * 0.87 - tilted * 0.5).toFixed(1);
      const py = (282 + x * 0.5 + tilted * 0.87).toFixed(1);
      segments.push(`${segment === 0 ? "M" : "L"}${px},${py}`);
    }
    const d = `${segments.join(" ")}Z`;
    const shade = roundHalfToEven(47 + 14 * (Math.sin(angle - 0.8) + 1));
    rings.push([Math.sin(angle), `<path d="${d}" fill="hsl(72,29%,${shade}%)" stroke="#4f6136" stroke-width=".8"/>`]);
  }
  rings.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return `<g transform="translate(1100 30) scale(.42)">${rings.map(([, p]) => p).join("")}</g>`;
}

export function render(language) {
  const copy = COPY[language];
  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 1110" role="img" aria-labelledby="title desc">',
    `<title id="title">${escapeHtml(copy.title)}</title>`,
    `<desc id="desc">${escapeHtml(copy.description)}</desc>`,
    '<style>text { font-family: "Manrope", "Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; } .mono { font-family: "DM Mono", Consolas, "Microsoft YaHei", monospace; } .serif { font-family: "Instrument Serif", Georgia, "Noto Serif CJK SC", SimSun, serif; font-style: italic; }</style>',
  ];

  const rect = (x, y, width, height, color, radius = 0) => {
    parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${COLORS[color]}"/>`);
  };

  const text = (x, y, value, size = 24, color = "ink", weight = 400, family = "", anchor = "start") => {
    parts.push(
      `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${COLORS[color]}" class="${family}" text-anchor="${anchor}">${escapeHtml(value)}</text>`,
    );
  };

  const line = (data, color = "line") => {
    parts.push(`<path d="${data}" fill="none" stroke="${COLORS[color]}" stroke-width="1.5"/>`);
  };

  rect(0, 0, 1440, 1110, "paper", 8);
  text(64, 64, "RIND", 20, "green", 400, "mono");
  text(64, 150, copy.headline, 64, "ink", 500);
  text(64, 226, copy.serif, 60, "green", 400, "serif");
  text(64, 280, copy.subhead, 24, "muted");
  parts.push(sculpture());

  rect(48, 320, 1344, 420, "dark", 8);
  text(80, 364, copy.folders_tag, 18, "dim", 400, "mono");
  text(80, 418, copy.folders_title, 34, "light", 500);
  for (let i = 0; i < TREE.length; i += 1) {
    const y = 484 + i * 46;
    text(80, y, TREE[i], 24, "lime", 400, "mono");
    text(340, y, copy.roles[i], 24, "light");
  }
  line("M720 352V640", "dark_line");
  text(760, 364, copy.team_tag, 18, "dim", 400, "mono");
  text(760, 418, copy.team_title, 34, "light", 500);
  for (let i = 0; i < copy.steps.length; i += 1) {
    const y = 484 + i * 46;
    text(760, y, `0${i + 1}`, 18, "dim", 400, "mono");
    text(806, y, copy.steps[i], 25, "lime", 500);
    text(946, y, copy.step_notes[i], 22, "dim");
  }
  line("M80 662H1352", "dark_line");
  text(80, 708, copy.folders_note, 22, "light");
  text(760, 708, copy.team_note, 22, "light");

  line("M505 780V1000");
  line("M961 780V1000");
  const columnXs = [64, 542, 998];
  for (let idx = 0; idx < columnXs.length; idx += 1) {
    const x = columnXs[idx];
    const [tag, title, command, lines] = copy.columns[idx];
    text(x, 800, tag, 18, "muted", 400, "mono");
    text(x, 850, title, 33, "green", 500);
    let y = 900;
    if (command) {
      text(x, y, command, 24, "green", 400, "mono");
      y += 46;
    }
    for (const value of lines) {
      text(x, y, value, 21, "muted");
      y += 36;
    }
  }
  line("M64 1030H1376");
  text(64, 1072, copy.footer, 18, "muted", 400, "mono");
  text(1376, 1072, "rindai.dev ↗", 20, "green", 400, "mono", "end");
  parts.push("</svg>");
  return `${parts.join("\n")}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const language of Object.keys(COPY)) {
    const suffix = language === "en" ? "" : `.${language}`;
    const target = path.join(ROOT, "assets", `rind-overview${suffix}.svg`);
    writeFileSync(target, render(language), "utf8");
    console.log(path.relative(ROOT, target));
  }
}
