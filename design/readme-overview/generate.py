"""Render the bilingual README overview as self-contained SVGs."""

from html import escape
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PALETTE = {
    "background": "#0b1115",
    "panel": "#13242b",
    "inset": "#0e1a20",
    "line": "#34505c",
    "text": "#edf4f1",
    "muted": "#a4b8c1",
    "cyan": "#5fd7ff",
    "gold": "#f5c451",
}
COPY = {
    "en": {
        "title": "Rind: persistent teams, programmable sessions, a lean worker",
        "description": "The CLI surface and worker run in separate processes. Execution objects load on demand and release when idle; session history lives on disk. Specialists retain workspaces and publish shared artifacts. Scripts use rind run and rind send.",
        "brand": "RIND / CORE DESIGN",
        "edition": "OPEN SOURCE / LOCAL RUNTIME",
        "headline": "One engine. Work that lasts.",
        "subtitle": "Persistent teams. Programmable sessions. A worker built to stay lean.",
        "surface_tag": "01 / SURFACE PROCESS",
        "surface_title": "Your interface to the work",
        "prompt": "Review the current diff",
        "surface_footer": "Input, rendering, interaction",
        "worker_tag": "02 / WORKER PROCESS",
        "worker_title": "A lean session kernel",
        "load": "Load session",
        "execute": "Execute",
        "release": "Release",
        "load_sub": "on demand",
        "execute_sub": "models + tools",
        "release_sub": "when idle",
        "disk_title": "Session history stays on disk",
        "disk_sub": "JSONL / messages / tool calls",
        "worker_footer": "Transient execution. Durable session state.",
        "request": "requests",
        "events": "events",
        "team_tag": "03 / PERSISTENT TEAMS",
        "team_title": "Specialists with a home",
        "main": "main-agent",
        "tester": "tester",
        "researcher": "researcher",
        "shared_sub": "published artifacts",
        "team_footer": "Roles and files carry forward to the next task.",
        "auto_tag": "04 / PROGRAMMABLE SESSIONS",
        "auto_title": "Start it. Steer it.",
        "run_sub": "Scripts → final answer on stdout",
        "send_sub": "New instructions → live CLI session",
        "footer": "CLI process split shown. Desktop separates its worker too; Web and gateway connect over WebSocket.",
    },
    "zh-CN": {
        "title": "Rind：持久化专家团队、可编程会话与轻量 worker",
        "description": "CLI 界面与 worker 分进程运行。执行对象按需加载、空闲释放，会话历史保存在磁盘上。专家保留工作区，通过共享文件交付成果；脚本可使用 rind run 和 rind send。",
        "brand": "RIND / 核心设计",
        "edition": "开源 / 本地引擎",
        "headline": "一个引擎，让工作持续积累。",
        "subtitle": "持久化专家团队 · 可编程会话 · 按需执行的轻量 worker",
        "surface_tag": "01 / SURFACE 界面进程",
        "surface_title": "与工作直接交互",
        "prompt": "检查当前代码变更",
        "surface_footer": "输入、渲染与交互",
        "worker_tag": "02 / WORKER 执行进程",
        "worker_title": "轻量、按需的会话内核",
        "load": "加载会话",
        "execute": "执行任务",
        "release": "释放资源",
        "load_sub": "按需创建",
        "execute_sub": "模型与工具",
        "release_sub": "会话空闲后",
        "disk_title": "会话历史保存在磁盘上",
        "disk_sub": "JSONL / 消息 / 工具调用",
        "worker_footer": "执行状态暂驻内存，会话历史持久保存。",
        "request": "请求",
        "events": "事件",
        "team_tag": "03 / 持久化专家团队",
        "team_title": "每个专家都有自己的工作区",
        "main": "main-agent",
        "tester": "测试专家",
        "researcher": "研究专家",
        "shared_sub": "正式交付的成果",
        "team_footer": "职责与文件保留下来，供下一次任务继续使用。",
        "auto_tag": "04 / 可编程会话",
        "auto_title": "发起任务，也能中途引导",
        "run_sub": "脚本 → 最终回答写入 stdout",
        "send_sub": "新指令 → 正在运行的 CLI 会话",
        "footer": "图示为 CLI 双进程结构；桌面端同样独立启动 worker，Web 与消息网关通过 WebSocket 接入。",
    },
}


def render(language: str) -> str:
    copy = COPY[language]
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 1016" role="img" aria-labelledby="title desc">',
        f'<title id="title">{escape(copy["title"])}</title>',
        f'<desc id="desc">{escape(copy["description"])}</desc>',
        '<style>text { font-family: "Segoe UI", Arial, "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; } .mono { font-family: Consolas, "Liberation Mono", monospace; }</style>',
        '<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">',
        f'<path d="M1 1L7 4L1 7" fill="none" stroke="{PALETTE["cyan"]}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>',
    ]

    def rect(x, y, width, height, fill="panel", radius=16, stroke="line"):
        parts.append(f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="{radius}" fill="{PALETTE[fill]}" stroke="{PALETTE[stroke]}"/>')

    def text(x, y, value, size=24, color="text", weight=400, anchor="start", mono=False):
        family = ' class="mono"' if mono else ""
        parts.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{PALETTE[color]}" text-anchor="{anchor}"{family}>{escape(value)}</text>')

    def path(data, color="line", arrow=False):
        marker = ' marker-end="url(#arrow)"' if arrow else ""
        parts.append(f'<path d="{data}" fill="none" stroke="{PALETTE[color]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"{marker}/>')

    rect(0, 0, 1440, 1016, "background", 24, "background")
    path("M48 36H96", "cyan")
    path("M96 36H128", "gold")
    text(48, 68, copy["brand"], 19, "cyan", 600)
    text(1392, 68, copy["edition"], 18, "muted", 500, "end")
    text(48, 130, copy["headline"], 49, weight=650)
    text(48, 170, copy["subtitle"], 24, "muted")

    rect(48, 210, 524, 382)
    text(76, 249, copy["surface_tag"], 18, "cyan", 600)
    text(76, 293, copy["surface_title"], 31, weight=600)
    rect(76, 317, 468, 126, "inset", 10)
    text(96, 353, "[TEAM]", 20, "gold", 600, mono=True)
    text(184, 353, "model · effort · cwd", 20, "muted", mono=True)
    path("M96 373H524")
    text(96, 413, "▷", 26, "cyan")
    text(128, 413, copy["prompt"], 24)
    for x, label in [(76, "CLI"), (194, "Desktop"), (312, "Web"), (430, "Gateway")]:
        rect(x, 472, 114, 42, "inset", 8)
        text(x + 57, 500, label, 20, "muted", anchor="middle")
    text(76, 558, copy["surface_footer"], 23, "muted")

    text(630, 349, copy["request"], 18, "muted", anchor="middle")
    path("M590 370H668", "cyan", True)
    path("M668 415H590", "cyan", True)
    text(630, 447, copy["events"], 18, "muted", anchor="middle")

    rect(688, 210, 704, 382)
    text(716, 249, copy["worker_tag"], 18, "gold", 600)
    text(716, 293, copy["worker_title"], 31, weight=600)
    for index, (label, caption) in enumerate([("load", "load_sub"), ("execute", "execute_sub"), ("release", "release_sub")]):
        x = 716 + index * 225
        rect(x, 320, 198, 95, "inset", 10, "gold" if index == 1 else "line")
        text(x + 99, 357, copy[label], 24, "gold" if index == 1 else "text", 600, "middle")
        text(x + 99, 389, copy[caption], 20, "muted", anchor="middle")
        if index < 2:
            path(f"M{x + 204} 367h15", "cyan", True)
    path("M1040 415V447", "cyan", True)
    rect(716, 455, 648, 74, "inset", 10)
    path("M738 474h25v35h-25z M744 483h13 M744 491h13 M744 499h8", "cyan")
    text(782, 486, copy["disk_title"], 23, weight=600)
    text(782, 515, copy["disk_sub"], 20, "muted")
    text(716, 566, copy["worker_footer"], 23, "muted")

    rect(48, 622, 768, 326)
    text(76, 662, copy["team_tag"], 18, "cyan", 600)
    text(76, 705, copy["team_title"], 31, weight=600)
    rect(76, 771, 164, 56, "inset", 10)
    text(158, 806, copy["main"], 21, "gold", 500, "middle", True)
    for y, label in [(740, "tester"), (816, "researcher")]:
        rect(290, y, 198, 56, "inset", 10)
        text(389, y + 35, copy[label], 22, anchor="middle")
    path("M240 799H264V768H281", "cyan", True)
    path("M264 799V844H281", "cyan", True)
    path("M488 768H516V796H550", "cyan", True)
    path("M488 844H516V812H550", "cyan", True)
    rect(558, 765, 230, 78, "inset", 10, "gold")
    text(673, 797, "shared/", 25, "gold", 600, "middle", True)
    text(673, 827, copy["shared_sub"], 20, "muted", anchor="middle")
    text(76, 916, copy["team_footer"], 23, "muted")

    rect(840, 622, 552, 326)
    text(868, 662, copy["auto_tag"], 18, "gold", 600)
    text(868, 705, copy["auto_title"], 31, weight=600)
    text(868, 764, '$ rind run --prompt "…"', 24, "cyan", mono=True)
    text(868, 801, copy["run_sub"], 23, "muted")
    path("M868 823H1364")
    text(868, 868, "$ rind send --session <id>", 24, "gold", mono=True)
    text(868, 906, copy["send_sub"], 23, "muted")
    text(48, 989, copy["footer"], 19, "muted")
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


if __name__ == "__main__":
    for language in COPY:
        suffix = "" if language == "en" else f".{language}"
        target = ROOT / "assets" / f"rind-architecture{suffix}.svg"
        target.write_text(render(language), encoding="utf-8")
        print(target.relative_to(ROOT))
