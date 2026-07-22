"""Default tool catalog."""

from __future__ import annotations

from ..spec import ToolSpec
from .files import apply_patch, edit_file, glob, grep, read_file, write_file
from .pdf import read_pdf
from .planning import (
    plan_add_step,
    plan_close,
    plan_create,
    plan_get,
    plan_link_dependency,
    plan_next,
    plan_reorder,
    plan_update_meta,
    plan_update_step,
)
from .shell import bash, bash_output, kill_shell
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
    ToolSpec(name="kill_shell", handler=kill_shell, description="重置 Shell 会话状态"),
    ToolSpec(
        name="plan_create",
        handler=plan_create,
        description="创建一个 DAG 计划（支持并行步骤与阻塞），可携带长期目标、约束和指标。不要直接编辑 plan.json。",
        param_descriptions={
            "title": "计划标题",
            "goal": "计划目标",
            "steps": "步骤数组，每项含 title/depends_on/priority 等字段",
            "expected_version": "可选版本号。已有计划时用于乐观锁校验。",
            "objectives": "可选长期目标数组，如 annual_return >= 0.10。",
            "constraints": "可选约束数组，如 max_drawdown <= 0.12。",
        },
    ),
    ToolSpec(
        name="plan_get",
        handler=plan_get,
        description="读取当前会话计划。",
        param_descriptions={"plan_id": "可选计划 ID，用于校验读取对象。"},
    ),
    ToolSpec(
        name="plan_add_step",
        handler=plan_add_step,
        description="向当前 active plan 追加一个新步骤。用于长期迭代任务中新实验、新假设或后续修复。必须使用 expected_version，不要直接编辑 plan.json。",
        param_descriptions={
            "title": "新增步骤标题，必填且非空",
            "description": "步骤说明",
            "step_id": "可选步骤 ID；不填则自动生成",
            "depends_on": "依赖的已有步骤 ID 数组",
            "priority": "优先级，数字越大越优先",
            "owner": "负责人或执行者标签",
            "acceptance": "验收标准",
            "expected_version": "必填版本号，用于乐观锁",
        },
    ),
    ToolSpec(
        name="plan_update_meta",
        handler=plan_update_meta,
        description="更新当前 active plan 的长期目标、目标指标和约束。必须使用 expected_version，不要直接编辑 plan.json。",
        param_descriptions={
            "expected_version": "必填版本号，用于乐观锁",
            "goal": "可选新的全局目标文本",
            "objectives": "可选目标数组，整体替换 objectives",
            "constraints": "可选约束数组，整体替换 constraints",
        },
    ),
    ToolSpec(
        name="plan_update_step",
        handler=plan_update_step,
        description="更新步骤状态或字段（严格状态机 + 乐观锁）。",
        param_descriptions={
            "step_id": "步骤 ID",
            "patch": "变更对象（如 status/blocked_reason/priority 等）",
            "expected_version": "必填版本号，用于乐观锁",
        },
    ),
    ToolSpec(
        name="plan_link_dependency",
        handler=plan_link_dependency,
        description="更新步骤依赖关系并校验环路。",
        param_descriptions={
            "step_id": "步骤 ID",
            "depends_on": "依赖步骤 ID 数组",
            "expected_version": "必填版本号，用于乐观锁",
        },
    ),
    ToolSpec(
        name="plan_reorder",
        handler=plan_reorder,
        description="重排步骤展示顺序（不改变依赖）。",
        param_descriptions={
            "step_orders": "完整的步骤 ID 顺序数组",
            "expected_version": "必填版本号，用于乐观锁",
        },
    ),
    ToolSpec(
        name="plan_next",
        handler=plan_next,
        description="获取下一步建议或并行可执行集合。",
        param_descriptions={
            "mode": {"description": "ready|focus|blocked_report", "enum": ["ready", "focus", "blocked_report"]},
            "expected_version": "可选版本号，用于一致性校验",
        },
    ),
    ToolSpec(
        name="plan_close",
        handler=plan_close,
        description="在所有步骤完成后关闭计划。只更新计划状态，不生成事实总结。",
        param_descriptions={"expected_version": "必填版本号，用于乐观锁"},
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
