"""Default tool catalog."""

from __future__ import annotations

from ..spec import ToolSpec
from .files import apply_patch, edit_file, glob, grep, read_file, write_file
from .pdf import read_pdf
from .planning import update_plan
from .shell import bash, bash_output
from .skill import skill_create
from .user_question import ask_user_question
from .web import fetch_web_page, search_web


TOOL_SPECS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="ask_user_question",
        handler=ask_user_question,
        description="向用户提出一个必须由用户确认的问题。仅当偏好、范围、阻塞决策或无法从环境发现的信息确实需要用户回答时使用；不要询问可通过工具探索得到的问题。",
        param_descriptions={
            "question": "要向用户提出的单个明确问题",
            "options": "可选答案列表，字符串数组；用户也可输入自由文本。",
            "recommended": "可选推荐答案，应与 options 中的一项文本一致或为空。",
        },
    ),
    ToolSpec(
        name="read_file",
        handler=read_file,
        description="读取 UTF-8 文本文件的指定行范围，返回行号、截断状态、下一次 offset 和完整文件 SHA-256。",
        param_descriptions={
            "path": "文件绝对或相对路径",
            "offset": "起始行号（默认 1）",
            "limit": "最多读取的行数（默认 1000 行，最大 2000 行；超过会被截断）",
        },
    ),
    ToolSpec(
        name="read_pdf",
        handler=read_pdf,
        description="解析PDF文件内容，支持文字版和扫描版PDF。提取结构化文本（标题、段落）、表格（Markdown格式）。分页返回，每次最多30页。扫描版PDF自动使用OCR。",
        param_descriptions={
            "file_path": "PDF文件路径",
            "start_page": "起始页码（默认1）",
            "end_page": "结束页码（默认到文件末尾，每次最多30页）",
            "force_ocr": "强制使用OCR（用于编码异常的文字PDF，默认False）",
        },
    ),
    ToolSpec(
        name="write_file",
        handler=write_file,
        description="原子新建 UTF-8 文本文件，或在 expected_sha256 匹配时完整覆盖已有文件。",
        param_descriptions={
            "file_path": "文件绝对或相对路径",
            "content": "完整文件内容",
            "expected_sha256": "覆盖已有文件时必填，必须使用最近一次 read_file 返回的 sha256；新建文件时省略。",
        },
    ),
    ToolSpec(
        name="edit_file",
        handler=edit_file,
        description="在 expected_sha256 匹配时原子替换已有 UTF-8 文件中的唯一文本块。old_str 必须与文件内容完全一致。",
        param_descriptions={
            "file_path": "文件绝对或相对路径",
            "old_str": "需要被替换的原文块。建议包含上下文以确保唯一。",
            "new_str": "用来替换 old_str 的新文本块。",
            "expected_sha256": "必填，必须使用最近一次 read_file 返回的 sha256。",
        },
    ),
    ToolSpec(
        name="apply_patch",
        handler=apply_patch,
        description="严格应用 Codex *** Begin Patch 格式的多文件补丁。支持 Add File、Update File、Delete File；Update/Delete 段必须紧跟 *** Expected SHA256 指令。不支持 move、模糊匹配或 unified diff。",
        param_descriptions={"patch": "完整的 Codex 格式 patch 字符串；修改或删除已有文件时嵌入 read_file 返回的 SHA-256。"},
    ),
    ToolSpec(
        name="glob",
        handler=glob,
        description="按 glob 模式快速查找文件路径，并返回文件大小。适合在读取文件内容前定位候选文件。",
        param_descriptions={
            "pattern": "文件匹配模式，如 **/*.py、src/**/*.ts。",
            "path": "搜索目录。默认为当前目录 .。",
            "max_results": "最大返回文件数。默认 100。",
        },
    ),
    ToolSpec(
        name="grep",
        handler=grep,
        description="使用 rg 在文件中搜索模式，返回匹配文件、行号和文本。达到上限时返回截断状态。",
        param_descriptions={
            "pattern": "要搜索的正则表达式（rg 语法）",
            "path": "搜索的根目录 (默认为当前目录 .)",
            "glob": "文件匹配模式 (如 **/*.py, src/*.ts)。默认为 **/*。",
            "max_results": "最大返回结果数 (默认为 50)",
        },
    ),
    ToolSpec(
        name="bash",
        handler=bash,
        description="执行 Shell 命令。支持 cd 保持目录状态，并返回 running、completed、failed、cancelled 或 timed_out 状态。run_in_background=false 时前台运行直到完成或超时；run_in_background=true 时先等待 wait_ms，短任务直接返回结果，仍在运行才返回 bg_id 供 bash_output 后续等待。",
        param_descriptions={
            "command": "要执行的命令",
            "run_in_background": "允许命令在等待窗口后挂起为后台任务。默认 False。",
            "wait_ms": "仅在 run_in_background=true 时生效：后台启动后先等待新输出或完成的毫秒数，默认 10000，范围 1000-60000。前台执行会忽略此参数。",
        },
    ),
    ToolSpec(
        name="bash_output",
        handler=bash_output,
        description="阻塞等待并读取后台进程的增量输出，或终止整个进程树。默认等待 wait_ms 直到有新 stdout/stderr、进程完成或超时；no_new_output=true 表示没有新信息，应按 suggested_next_wait_ms 再查。若返回 RepeatedEmptyPoll，应停止继续轮询并把 bg_id 告诉用户，提示稍后可继续查看。",
        param_descriptions={
            "bg_id": "后台进程 ID（bash 返回的 bg_id）",
            "kill": "设为 true 可终止该进程。默认 False（仅读取输出）。",
            "wait_ms": "阻塞等待新输出或完成的最长毫秒数，默认 15000，范围 5000-300000。连续无输出时建议等待 120000 或 300000。",
            "max_output_chars": "单次返回 stdout/stderr 增量的最大字符数，默认 20000，最大 40000。",
        },
    ),
    ToolSpec(
        name="update_plan",
        handler=update_plan,
        description=(
            "维护多步骤任务的轻量计划。每次调用必须提交完整列表，数组顺序就是展示和执行优先顺序；"
            "只保存控制状态，不记录事实总结。状态只能是 pending、in_progress、completed 或 cancelled，"
            "最多一个 in_progress；完成工作并验证后再标记 completed。"
        ),
        param_descriptions={
            "plan": {
                "description": "完整计划列表；传入空数组可清空当前计划。",
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "step": {"type": "string", "minLength": 1},
                        "status": {"type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"]},
                    },
                    "required": ["step", "status"],
                    "additionalProperties": False,
                },
            }
        },
    ),
    ToolSpec(
        name="skill_create",
        handler=skill_create,
        description="创建格式正确的 Rind Skill。自动写入当前目录 .rind/skills/<name>/SKILL.md 或用户级 RIND_HOME/skills/<name>/SKILL.md，并生成稳定的 frontmatter。",
        param_descriptions={
            "name": "Skill 名称。只能包含字母、数字、下划线和连字符。",
            "description": "Skill 的简短说明，写入 frontmatter，用于上下文中的 skill index。",
            "body": "SKILL.md 正文指令内容。",
            "triggers": "可选触发短语列表。为空时写入 triggers: []。",
            "scope": {"description": "写入范围：project 写到当前项目，user 写到用户目录。默认 project。", "enum": ["project", "user"]},
            "overwrite": "是否覆盖已存在的 SKILL.md。默认 False。",
        },
    ),
    ToolSpec(
        name="search_web",
        handler=search_web,
        description="搜索互联网信息。支持多搜索引擎自动切换（Bing/Baidu/DDG），适用于中英文内容查询，中国大陆可用。",
        param_descriptions={"query": "搜索关键词（支持中英文）", "max_results": "最大结果数 (默认 5)"},
    ),
    ToolSpec(
        name="fetch_web_page",
        handler=fetch_web_page,
        description="抓取并提取网页主要内容（自动去除导航、广告等干扰，输出Markdown）。通常在 search_web 返回 URL 后使用。",
        param_descriptions={"url": "网页 URL"},
    ),
)


__all__ = ["TOOL_SPECS"]
