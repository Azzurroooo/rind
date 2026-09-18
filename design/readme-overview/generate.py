"""Render the bilingual core-design artwork using the website's visual language."""

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
        "title": "Rind — a small core, many ways to work",
        "description": "CLI, desktop, web and gateway share a reusable worker. The CLI interface and worker run in separate processes; execution loads on demand and releases when idle, with session history on disk. A built-in guide, persistent specialist workspaces and run/send interfaces make it approachable and programmable.",
        "brand": "RIND / CORE DESIGN",
        "headline": "A small core. Room to grow.",
        "subhead": "Interfaces change. The core stays.",
        "entry": "YOUR WAY IN",
        "surface": "01 / SURFACE PROCESS",
        "surface_title": "An interface for people.",
        "surface_lines": ["Input, rendering and interaction.", "The CLI stays ready while work runs."],
        "boundary": "CLI process boundary",
        "request": "requests", "events": "events",
        "worker": "02 / WORKER PROCESS",
        "worker_title": "An engine built to stay lean.",
        "steps": ["Load", "Execute", "Release"],
        "step_notes": ["on demand", "models + tools", "when idle"],
        "disk": "Session history stays on disk.",
        "protocol": "Desktop also isolates its worker. Web and gateway connect over WebSocket.",
        "guide_tag": "01 / GUIDANCE", "guide_title": "Start with a tour.",
        "guide_lines": ["Watch real CLI layouts in action.", "Learn the controls before your first task.", "No model calls. No API key."],
        "team_tag": "02 / SPECIALISTS", "team_title": "Give work a home.",
        "team_lines": ["Roles and files persist across tasks.", "Experts hand off results through shared/."],
        "script_tag": "03 / AUTOMATION", "script_title": "Put it in a script.",
        "run": "One task → answer on stdout",
        "send": "New instructions → live CLI session",
        "footer": "OPEN SOURCE · ON YOUR MACHINE · ON YOUR TERMS",
    },
    "zh-CN": {
        "title": "Rind — 小巧内核，多种工作方式",
        "description": "CLI、桌面、Web 与消息网关共用可复用的 worker。CLI 界面与 worker 分进程运行；执行对象按需加载、空闲释放，会话历史保存在磁盘上。内置指南、持久化专家工作区和 run/send 接口，让使用与自动化都更顺手。",
        "brand": "RIND / 核心设计",
        "headline": "小巧内核，从容扩展。",
        "subhead": "界面各异，内核如一。",
        "entry": "多种入口",
        "surface": "01 / SURFACE 界面进程",
        "surface_title": "让交互顺手。",
        "surface_lines": ["负责输入、渲染与交互。", "任务执行时，CLI 仍可接收指令。"],
        "boundary": "CLI 进程边界",
        "request": "请求", "events": "事件",
        "worker": "02 / WORKER 执行进程",
        "worker_title": "让内核保持轻巧。",
        "steps": ["加载会话", "执行任务", "释放资源"],
        "step_notes": ["按需创建", "模型与工具", "会话空闲后"],
        "disk": "会话历史持久保存在磁盘上。",
        "protocol": "桌面端同样独立启动 worker；Web 与消息网关通过 WebSocket 接入。",
        "guide_tag": "01 / 内置指南", "guide_title": "先看懂，再动手。",
        "guide_lines": ["用真实 CLI 布局演示操作。", "第一次任务前，就能熟悉交互。", "不调用模型，无需 API Key。"],
        "team_tag": "02 / 专家团队", "team_title": "让工作有处积累。",
        "team_lines": ["职责与文件保留，供后续任务继续使用。", "专家通过 shared/ 交接成果。"],
        "script_tag": "03 / 脚本调用", "script_title": "自然融入工作流。",
        "run": "单次任务 → 最终回答写入 stdout",
        "send": "新指令 → 正在运行的 CLI 会话",
        "footer": "开源 · 本地执行 · 自主掌控",
    },
}


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
    return '<g transform="translate(1120 20) scale(.4)">' + "".join(path for _, path in sorted(rings)) + "</g>"


def render(language: str) -> str:
    copy = COPY[language]
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 1120" role="img" aria-labelledby="title desc">',
        f'<title id="title">{escape(copy["title"])}</title>',
        f'<desc id="desc">{escape(copy["description"])}</desc>',
        '<style>text { font-family: "Manrope", "Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; } .mono { font-family: "DM Mono", Consolas, "Microsoft YaHei", monospace; } .serif { font-family: "Instrument Serif", Georgia, "Noto Serif CJK SC", SimSun, serif; font-style: italic; }</style>',
        '<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M1 1L7 4L1 7" fill="none" stroke="#d6df9a" stroke-width="1.4"/></marker></defs>',
    ]

    def rect(x, y, width, height, color, radius=0):
        parts.append(f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="{radius}" fill="{COLORS[color]}"/>')

    def text(x, y, value, size=24, color="ink", weight=400, family="", anchor="start"):
        parts.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{COLORS[color]}" class="{family}" text-anchor="{anchor}">{escape(value)}</text>')

    def line(data, color="line", arrow=False):
        marker = ' marker-end="url(#arrow)"' if arrow else ""
        parts.append(f'<path d="{data}" fill="none" stroke="{COLORS[color]}" stroke-width="1.5"{marker}/>')

    rect(0, 0, 1440, 1120, "paper", 8)
    text(64, 64, copy["brand"], 20, "green", family="mono")
    text(64, 146, copy["headline"], 58, weight=500)
    text(64, 208, copy["subhead"], 40, "green", family="serif")
    parts.append(sculpture())
    line("M64 250H1376")
    text(64, 305, copy["entry"], 19, "muted", family="mono")
    for x, label in [(358, "CLI"), (622, "Desktop"), (886, "Web"), (1150, "Gateway")]:
        text(x, 308, label, 30, "green", weight=500)
    line("M64 340H1376")

    rect(48, 370, 1344, 350, "dark", 8)
    text(80, 412, copy["surface"], 18, "dim", family="mono")
    text(80, 468, copy["surface_title"], 34, "light", 500)
    for i, value in enumerate(copy["surface_lines"]):
        text(80, 520 + i * 36, value, 23, "dim")
    line("M80 590H474", "dark_line")
    text(80, 630, copy["boundary"], 21, "dim")

    text(574, 495, copy["request"], 19, "dim", anchor="middle")
    line("M508 515H636", "lime", True)
    line("M636 557H508", "lime", True)
    text(574, 590, copy["events"], 19, "dim", anchor="middle")

    text(682, 412, copy["worker"], 18, "dim", family="mono")
    text(682, 468, copy["worker_title"], 34, "light", 500)
    for i, (label, caption) in enumerate(zip(copy["steps"], copy["step_notes"])):
        x = 682 + i * 234
        text(x, 528, label, 29, "lime", 500)
        text(x, 563, caption, 21, "dim")
        if i < 2:
            line(f"M{x + 164} 523h42", "lime", True)
    line("M682 590H1352", "dark_line")
    text(682, 630, copy["disk"], 24, "light")
    line("M80 655H1352", "dark_line")
    text(80, 693, copy["protocol"], 21, "dim")

    line("M505 766V1026")
    line("M961 766V1026")
    for x, tag, title in [(64, "guide_tag", "guide_title"), (542, "team_tag", "team_title"), (998, "script_tag", "script_title")]:
        text(x, 789, copy[tag], 18, "muted", family="mono")
        text(x, 838, copy[title], 33, "green", 500)
    text(64, 895, "$ rind tour", 26, "green", family="mono")
    for i, value in enumerate(copy["guide_lines"]):
        text(64, 944 + i * 34, value, 22, "muted")
    text(542, 892, "agents/specialist/", 24, "green", family="mono")
    text(566, 932, "memory/ · work/ · outputs/", 21, "muted", family="mono")
    line("M544 906V925H556", "green")
    for i, value in enumerate(copy["team_lines"]):
        text(542, 974 + i * 34, value, 21, "muted")
    text(998, 892, "$ rind run", 25, "green", family="mono")
    text(998, 926, copy["run"], 21, "muted")
    text(998, 974, "$ rind send", 25, "green", family="mono")
    text(998, 1008, copy["send"], 21, "muted")
    line("M64 1050H1376")
    text(64, 1092, copy["footer"], 18, "muted", family="mono")
    text(1376, 1092, "rindai.dev ↗", 20, "green", family="mono", anchor="end")
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


if __name__ == "__main__":
    for language in COPY:
        suffix = "" if language == "en" else f".{language}"
        target = ROOT / "assets" / f"rind-architecture{suffix}.svg"
        target.write_text(render(language), encoding="utf-8")
        print(target.relative_to(ROOT))
