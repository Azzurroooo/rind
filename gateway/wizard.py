"""`gateway init`: guided, per-channel configuration instead of a YAML wall.

The interactive loop (input/print) is thin; the actual work lives in pure
functions — `collect_answers_env` (one-click env-driven mode) and
`build_config_data` (answers → gateway.yaml dict) — so the whole flow is
unit-testable without a terminal.
"""

from __future__ import annotations

import asyncio
import getpass
import os
import sys
from pathlib import Path
from typing import Any

from .config import build_config, parse_yaml, render_yaml
from .prompt import WizardCancelled, ask as _ask, ask_list as _ask_list, confirm as _confirm, pick_channels as _pick_channels
from .onboarding import ChannelGuide, all_guides, guide_for

DEFAULT_WORKER = "ws://127.0.0.1:8765"


# --- pure builders -------------------------------------------------------------


def env_answer(channel_id: str, field_name: str, env: dict[str, str]) -> str:
    return env.get(f"RIND_GW_{channel_id.upper()}_{field_name.upper()}", "")


def collect_answers_env(guide: ChannelGuide, env: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """Non-interactive mode: read every field from RIND_GW_<CH>_<FIELD>."""
    answers: dict[str, str] = {}
    missing_required: list[str] = []
    for spec in guide.fields:
        value = env_answer(guide.id, spec.name, env) or (spec.default if spec.default else "")
        answers[spec.name] = value
        if spec.required and not value:
            missing_required.append(f"RIND_GW_{guide.id.upper()}_{spec.name.upper()}")
    allow = env_answer(guide.id, "allow_from", env)
    group = env_answer(guide.id, "group_allow", env)
    lists = {
        "allow_from": [item.strip() for item in allow.split(",") if item.strip()],
        "group_allow": [item.strip() for item in group.split(",") if item.strip()],
    }
    return {"answers": answers, **lists}, missing_required


def build_config_data(
    selected: list[str],
    answers: dict[str, dict[str, str]],
    lists: dict[str, dict[str, list[str]]],
    *,
    worker: str,
    worker_token: str,
    workspace: str,
    pairing_enabled: bool = True,
    auto_install_sdk: bool = False,
) -> dict[str, Any]:
    channels: dict[str, Any] = {}
    for channel_id in selected:
        guide = guide_for(channel_id)
        if guide is None:
            continue
        block: dict[str, Any] = {}
        for spec in guide.fields:
            value = answers.get(channel_id, {}).get(spec.name, "")
            if value:
                block[spec.name] = int(value) if value.isdigit() and spec.name in {"imap_port", "smtp_port", "poll_interval", "callback_port", "webhook_port", "ws_port"} else value
        allow = [item for item in lists.get(channel_id, {}).get("allow_from", []) if item]
        group = [item for item in lists.get(channel_id, {}).get("group_allow", []) if item]
        if allow:
            block["allow_from"] = allow
        if group:
            block["group_allow"] = group
        if block:
            channels[channel_id] = block
    data: dict[str, Any] = {
        "worker": worker,
        "workspace": workspace,
        "channels": channels,
    }
    if worker_token:
        data["worker_token"] = worker_token
    if pairing_enabled:
        data["pairing"] = {"enabled": True}
    if auto_install_sdk:
        data["auto_install_sdk"] = True
    return data


def config_path_for(workspace: str) -> Path:
    return Path(workspace).expanduser() / ".rind" / "gateway.yaml"


def _guide_walk(guide: ChannelGuide, env: dict[str, str]) -> tuple[dict[str, str], dict[str, list[str]]]:
    print(f"\n=== {guide.emoji} {guide.label} ===")
    for step in guide.setup_steps:
        print(f"  · {step}")
    if guide.scopes:
        print("  精确权限/事件代码（在平台对应搜索框里逐个粘贴，唯一确定）：")
        for code in guide.scopes:
            print(f"      {code}")
    answers: dict[str, str] = {}
    env_prefix = f"RIND_GW_{guide.id.upper()}_"
    for spec in guide.fields:
        env_value = env.get(env_prefix + spec.name.upper(), "")
        label = f"{spec.label}" + (f"（{spec.help}）" if spec.help else "")
        answers[spec.name] = _ask(label, spec.default, secret=spec.secret) or env_value
    print("  allow_from / group_allow 现在可以留空——陌生账号首次发消息会收到配对码，")
    print("  在服务器执行 `gateway approve <码>` 后即自动进入白名单。")
    allow = _ask_list("allow_from 白名单")
    group = _ask_list("group_allow 群白名单")
    probe_detail = ""
    if guide.probe and answers:
        if _confirm("立即验证凭证（会访问平台 API）？"):
            result = guide.probe({key: value for key, value in answers.items() if value})
            probe_detail = result.detail
            mark = "✔" if result.ok else "✘"
            print(f"  {mark} {probe_detail}")
            # 探活失败（常见于直连被墙的超时）：给一次改代理重试的机会。
            retries = 0
            while not result.ok and retries < 2 and _confirm("重新填写『代理地址』并再次验证？", default_yes=False):
                answers["proxy"] = _ask("代理地址（如 http://127.0.0.1:7890）")
                result = guide.probe({key: value for key, value in answers.items() if value})
                probe_detail = result.detail
                mark = "✔" if result.ok else "✘"
                print(f"  {mark} {probe_detail}")
                retries += 1
            if not result.ok:
                print("     可稍后运行 `python main.py gateway doctor --probe` 重新体检。")
    if guide.discover_senders:
        import re

        bot_match = re.search(r"@[\w]+", probe_detail)
        where = f"在 Telegram 里给你的 bot {bot_match.group(0)} 发一条消息" if bot_match else "在 Telegram 里找到你的 bot（BotFather 给的 username）并发一条消息"
        if _confirm(f"现在抓取你的账号 ID？（60 秒内{where}）", default_yes=False):
            print(f"  等待消息中——请在 Telegram 里给 {bot_match.group(0) if bot_match else '你的 bot'} 发送任意消息…")
            senders = guide.discover_senders({key: value for key, value in answers.items() if value}, 60.0)
            if senders:
                print("  发现以下发送者：")
                for index, sender in enumerate(senders, start=1):
                    print(f"    {index}. {sender}")
                picked = _input("把哪些加入 allow_from（编号，回车=全部，0=不加）: ").strip()
                if picked != "0":
                    ids = [senders[int(token) - 1].split(" ")[0] for token in picked.replace("，", ",").split(",") if token.strip().isdigit() and 0 < int(token) <= len(senders)] if picked else [sender.split(" ")[0] for sender in senders]
                    allow = allow or ids
            else:
                print("  60 秒内没有收到消息。稍后直接给 bot 发消息会收到配对码卡（含你的 ID），")
                print("  用 `gateway approve <码>` 批准即可，无需重跑向导。")
    return answers, {"allow_from": allow, "group_allow": group}


def _default_workspace() -> str:
    """运行数据绝不默认写进 Rind 工程目录——回退到用户主目录下的独立工作区。"""
    cwd = Path(os.getcwd())
    from .doctor import _looks_like_source_dir

    if _looks_like_source_dir(cwd):
        return str(Path.home() / "rind-workspace")
    return str(cwd)


def _resolve_workspace(raw: str | None) -> str:
    from .doctor import _looks_like_source_dir

    candidate = Path(raw or _default_workspace()).expanduser()
    if _looks_like_source_dir(candidate):
        print("  ✘ 这是 Rind 的工程目录——运行数据（state/pairing/uploads）不能放进源码树。")
        fallback = Path.home() / "rind-workspace"
        value = Path(_input(f"请换一个工作目录（回车 = {fallback}）: ").strip() or str(fallback)).expanduser()
        if _looks_like_source_dir(value):
            print("  ✘ 仍是工程目录。已取消。")
            raise WizardCancelled()
        candidate = value
    candidate.mkdir(parents=True, exist_ok=True)
    return str(candidate.resolve())


def run_init(args) -> int:
    env = dict(os.environ)
    if args.yes:
        # 一键模式：全程零交互——渠道列表、字段、连接信息全部来自参数与环境变量。
        selected = [token.strip() for token in args.channel.split(",") if guide_for(token.strip())]
        unknown = [token.strip() for token in args.channel.split(",") if not guide_for(token.strip())]
        if unknown:
            print(f"未知渠道已忽略: {', '.join(unknown)}", file=sys.stderr)
        if not selected:
            print("--channel 缺少有效渠道。", file=sys.stderr)
            return 2
        worker = args.worker_url or env.get("RIND_GW_WORKER") or DEFAULT_WORKER
        worker_token = env.get("RIND_SERVER_TOKEN", "")
        workspace = _resolve_workspace(args.workspace)
        guides = [guide_for(channel_id) for channel_id in selected]
        answers: dict[str, dict[str, str]] = {}
        lists: dict[str, dict[str, list[str]]] = {}
        for guide in guides:
            collected, missing = collect_answers_env(guide, env)
            answers[guide.id] = collected["answers"]
            lists[guide.id] = {key: collected[key] for key in ("allow_from", "group_allow")}
            if missing:
                print(f"✘ {guide.label} 缺少必需字段（环境变量）: {', '.join(missing)}", file=sys.stderr)
                return 2
        from .doctor import ensure_channel_sdks
        guides, auto_install = ensure_channel_sdks(guides, interactive=False)
        if not guides:
            print("没有可启动的渠道。", file=sys.stderr)
            return 2
        return _finish(args, selected, answers, lists, worker, worker_token, workspace, confirm=False, auto_install_sdk=auto_install)

    print("Rind 网关配置向导 —— 一步步把 IM 渠道接到你的 worker（全程约 2 分钟）")
    try:
        if args.channel:
            selected = [token.strip() for token in args.channel.split(",") if guide_for(token.strip())]
            unknown = [token.strip() for token in args.channel.split(",") if not guide_for(token.strip())]
            if unknown:
                print(f"未知渠道已忽略: {', '.join(unknown)}", file=sys.stderr)
            if not selected:
                print("没有可用的渠道。", file=sys.stderr)
                return 2
        else:
            selected = _pick_channels()
        worker_token = os.environ.get("RIND_SERVER_TOKEN", "")
        worker = _ask("Worker 地址", args.worker_url or DEFAULT_WORKER)
        workspace = _resolve_workspace(_ask("工作目录（网关会话的根目录，绝对路径）", args.workspace or _default_workspace()))
        if not worker_token:
            worker_token = _ask("Worker Token（RIND_SERVER_TOKEN 的值，可留空）", secret=True)

        guides = [guide_for(channel_id) for channel_id in selected]
        from .doctor import ensure_channel_sdks

        guides, auto_install = ensure_channel_sdks(guides, interactive=True)
        if not guides:
            print("没有可启动的渠道。", file=sys.stderr)
            return 2
        answers = {}
        lists = {}
        for guide in guides:
            answers[guide.id], lists[guide.id] = _guide_walk(guide, env)
    except WizardCancelled:
        print("\n已取消（配置未写入）。")
        return 1
    return _finish(args, selected, answers, lists, worker, worker_token, workspace, confirm=True, auto_install_sdk=auto_install)


def _finish(args, selected, answers, lists, worker, worker_token, workspace, *, confirm: bool, auto_install_sdk: bool = False) -> int:
    data = build_config_data(
        selected, answers, lists,
        worker=worker, worker_token=worker_token, workspace=str(workspace),
        auto_install_sdk=auto_install_sdk,
    )
    text = render_yaml(data)
    print("\n—— 生成的 gateway.yaml ——")
    print(text)
    target = config_path_for(str(workspace))
    if confirm and not _confirm(f"写入 {target}？"):
        print("已取消（配置未写入）。")
        return 1
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    print(f"\n✔ 已写入 {target}")

    # 收尾包装：体检和启动由向导接管——用户不需要抄任何命令。
    from .doctor import run_checks

    print("\n—— 自动体检 ——")
    for check in run_checks(target, Path(workspace)):
        mark = "✔" if check.ok is True else ("⚠" if check.ok is None else "✘")
        print(f"  {mark} {check.name}：{check.detail}")

    print("\n下一步：启动网关开始对话。")
    print(f"  python main.py gateway --config \"{target}\"")
    print("  （加渠道/换渠道：重新运行 python main.py gateway init）")

    # 启动由向导接管：交互式终端默认直接启动（EOF/管道安静跳过——自动化友好）。
    try:
        start_now = _confirm("立即启动网关？（Ctrl+C 停止）", default_yes=True)
    except WizardCancelled:
        start_now = False
    if not start_now:
        return 0

    from .main import _run
    from .security import PairingStore

    runtime_dir = Path(workspace) / ".rind"
    config = build_config(parse_yaml(text, env=os.environ))
    try:
        return asyncio.run(_run(config, runtime_dir, PairingStore(runtime_dir / "pairing.json")))
    except KeyboardInterrupt:
        print("\n网关已停止。")
        return 0


__all__ = ["build_config_data", "collect_answers_env", "config_path_for", "run_init"]
