"""Render the bilingual README hero artwork using the website's visual language."""

from html import escape
from math import cos, pi, sin
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
COLORS = {
    "paper": "#f4f3eb", "ink": "#22271f", "muted": "#64685e",
    "line": "#d5d7ca", "green": "#334c37", "lime": "#d6df9a",
    "dark": "#19241e", "light": "#ebeee4", "dim": "#a5b0a4",
    "dark_line": "#3d4a3f",
}
COPY = {
    "en": {
        "title": "Rind — Light by design. Folders are agents.",
        "description": "Rind is a lightweight, open-source local coding agent. Every folder is a teammate: add folders to a team, brief the lead, let members delegate and report with evidence, and follow every team in Agents Management. One lean worker loads sessions on demand and keeps history on disk; the team control plane, runtime protocol, tools and skills are open to reuse.",
        "headline": "Light by design.",
        "serif": "Folders are agents.",
        "subhead": "A lightweight, open-source local coding agent. Every folder is a teammate.",
        "folders_tag": "FOLDERS ARE AGENTS",
        "folders_title": "Every folder is a teammate.",
        "roles": ["Lead", "Frontend", "Backend", "QA"],
        "folders_note": "Its files, RIND.md, skills and model make the agent.",
        "team_tag": "TEAM AGENTS",
        "team_title": "Delegate. Report. Deliver.",
        "steps": ["Brief", "Delegate", "Report", "Deliver"],
        "step_notes": [
            "Give the lead one goal.",
            "Members work in their own folders.",
            "Evidence and files come back.",
            "The lead wakes, reviews and delivers.",
        ],
        "team_note": "Work returns and wakes the lead. Nobody polls.",
        "columns": [
            ("LIGHT BY DESIGN", "One lean worker.", "", [
                "Loads on demand, releases when idle.",
                "History stays on disk as JSONL.",
                "No database. No cloud service.",
            ]),
            ("AGENTS MANAGEMENT", "Every team, one page.", "← on an empty prompt", [
                "Inbox · Manager · Tasks · Reports",
                "You approve anything destructive.",
            ]),
            ("BUILD ON IT", "Small parts, open seams.", "", [
                "An agent-neutral team control plane.",
                "A JSONL runtime protocol.",
                "Pluggable tools, providers, skills.",
            ]),
        ],
        "footer": "ALSO · rind tour · rind run · rind send · Desktop · Web · Gateway",
    },
    "zh-CN": {
        "title": "Rind — 轻装上阵。目录即智能体。",
        "description": "Rind 是轻量、开源的本地编码 Agent。每个目录都是队友：把目录加入团队，给主 Agent 布置目标，成员逐级委派并附证据汇报，在 Agents Management 中跟进所有团队。一个精简的 worker 按需加载会话、历史保存在磁盘；团队控制平面、Runtime 协议、工具与技能均可复用和扩展。",
        "headline": "轻装上阵。",
        "serif": "目录即智能体。",
        "subhead": "轻量、开源的本地编码 Agent。每个目录，都是队友。",
        "folders_tag": "目录即智能体",
        "folders_title": "每个目录，都是队友。",
        "roles": ["主 Agent", "前端", "后端", "测试"],
        "folders_note": "目录里的文件、RIND.md、技能与模型，就是这个 Agent。",
        "team_tag": "多 AGENT 协同",
        "team_title": "委派、汇报、交付。",
        "steps": ["布置", "委派", "汇报", "交付"],
        "step_notes": [
            "你只需给主 Agent 一个目标。",
            "成员在各自的目录里工作。",
            "证据与文件随报告交回。",
            "主 Agent 被唤醒，审阅后交付。",
        ],
        "team_note": "工作交回即唤醒主 Agent，无需轮询。",
        "columns": [
            ("轻量是初衷", "一个精简的 worker。", "", [
                "按需加载，空闲释放。",
                "会话以 JSONL 保存在磁盘。",
                "无需数据库，不依赖云服务。",
            ]),
            ("AGENTS MANAGEMENT", "所有团队，一页看清。", "← 空输入时按左键", [
                "Inbox · Manager · 任务 · 报告",
                "破坏性操作，先经你批准。",
            ]),
            ("可复用 · 可扩展", "小模块，开放接口。", "", [
                "与具体 Agent 无关的团队控制平面。",
                "JSONL Runtime 协议。",
                "工具、服务商与技能均可扩展。",
            ]),
        ],
        "footer": "更多 · rind tour · rind run · rind send · 桌面端 · Web · 消息网关",
    },
}
TREE = ["~/lead", "├─ ~/web", "├─ ~/api", "└─ ~/qa"]


def sculpture() -> str:
    rings = []
    for index in range(64):
        angle = index / 64 * pi * 2
        points = []
        for segment in range(48):
            v = segment / 48 * pi * 2
            radius = 148 + 64 * cos(v)
            x, y, z = radius * cos(angle), radius * sin(angle), 64 * sin(v)
            tilted = y * 0.59 - z * 0.81
            points.append((300 + x * 0.87 - tilted * 0.5, 282 + x * 0.5 + tilted * 0.87))
        path = " ".join(f'{"M" if j == 0 else "L"}{x:.1f},{y:.1f}' for j, (x, y) in enumerate(points)) + "Z"
        shade = round(47 + 14 * (sin(angle - 0.8) + 1))
        rings.append((sin(angle), f'<path d="{path}" fill="hsl(72,29%,{shade}%)" stroke="#4f6136" stroke-width=".8"/>'))
    return '<g transform="translate(1100 30) scale(.42)">' + "".join(path for _, path in sorted(rings)) + "</g>"


def render(language: str) -> str:
    copy = COPY[language]
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 1110" role="img" aria-labelledby="title desc">',
        f'<title id="title">{escape(copy["title"])}</title>',
        f'<desc id="desc">{escape(copy["description"])}</desc>',
        '<style>text { font-family: "Manrope", "Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; } .mono { font-family: "DM Mono", Consolas, "Microsoft YaHei", monospace; } .serif { font-family: "Instrument Serif", Georgia, "Noto Serif CJK SC", SimSun, serif; font-style: italic; }</style>',
    ]

    def rect(x, y, width, height, color, radius=0):
        parts.append(f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="{radius}" fill="{COLORS[color]}"/>')

    def text(x, y, value, size=24, color="ink", weight=400, family="", anchor="start"):
        parts.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{COLORS[color]}" class="{family}" text-anchor="{anchor}">{escape(value)}</text>')

    def line(data, color="line"):
        parts.append(f'<path d="{data}" fill="none" stroke="{COLORS[color]}" stroke-width="1.5"/>')

    rect(0, 0, 1440, 1110, "paper", 8)
    text(64, 64, "RIND", 20, "green", family="mono")
    text(64, 150, copy["headline"], 64, weight=500)
    text(64, 226, copy["serif"], 60, "green", family="serif")
    text(64, 280, copy["subhead"], 24, "muted")
    parts.append(sculpture())

    rect(48, 320, 1344, 420, "dark", 8)
    text(80, 364, copy["folders_tag"], 18, "dim", family="mono")
    text(80, 418, copy["folders_title"], 34, "light", 500)
    for i, (folder, role) in enumerate(zip(TREE, copy["roles"])):
        y = 484 + i * 46
        text(80, y, folder, 24, "lime", family="mono")
        text(340, y, role, 24, "light")
    line("M720 352V640", "dark_line")
    text(760, 364, copy["team_tag"], 18, "dim", family="mono")
    text(760, 418, copy["team_title"], 34, "light", 500)
    for i, (label, note) in enumerate(zip(copy["steps"], copy["step_notes"])):
        y = 484 + i * 46
        text(760, y, f"0{i + 1}", 18, "dim", family="mono")
        text(806, y, label, 25, "lime", 500)
        text(946, y, note, 22, "dim")
    line("M80 662H1352", "dark_line")
    text(80, 708, copy["folders_note"], 22, "light")
    text(760, 708, copy["team_note"], 22, "light")

    line("M505 780V1000")
    line("M961 780V1000")
    for x, (tag, title, command, lines) in zip((64, 542, 998), copy["columns"]):
        text(x, 800, tag, 18, "muted", family="mono")
        text(x, 850, title, 33, "green", 500)
        y = 900
        if command:
            text(x, y, command, 24, "green", family="mono")
            y += 46
        for value in lines:
            text(x, y, value, 21, "muted")
            y += 36
    line("M64 1030H1376")
    text(64, 1072, copy["footer"], 18, "muted", family="mono")
    text(1376, 1072, "rindai.dev ↗", 20, "green", family="mono", anchor="end")
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


if __name__ == "__main__":
    for language in COPY:
        suffix = "" if language == "en" else f".{language}"
        target = ROOT / "assets" / f"rind-overview{suffix}.svg"
        target.write_text(render(language), encoding="utf-8")
        print(target.relative_to(ROOT))
