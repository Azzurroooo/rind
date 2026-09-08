"""`gateway doctor`: one checklist for "为什么我的渠道没反应".

Each check answers a question a user would actually ask, in order:
配置在吗 → 能读吗 → worker 通吗 → 每个渠道的 SDK 装了吗、凭证有效吗 →
状态文件没坏吧。`--probe` adds live credential checks; `--fix` repairs what
can be repaired automatically (corrupt state files get a .corrupt backup).
"""

from __future__ import annotations

import importlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path

from .config import ConfigError, load_config
from .onboarding import GUIDES


@dataclass
class CheckResult:
    name: str
    ok: bool | None  # None = warning
    detail: str
    fix: str = ""


def _read_json(path: Path) -> tuple[bool, Any]:
    try:
        return True, json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return True, None  # missing is fine (fresh install)
    except Exception:
        return False, None


def _fix_corrupt(path: Path) -> str:
    backup = path.with_name(path.name + ".corrupt")
    try:
        path.rename(backup)
        return f"已备份为 {backup.name}"
    except OSError as exc:
        return f"重命名失败：{exc}"


def run_checks(config_path: Path | None, workspace: Path, *, probe: bool = False, fix: bool = False) -> list[CheckResult]:
    results: list[CheckResult] = []

    def add(name: str, ok: bool | None, detail: str, fix: str = "") -> None:
        results.append(CheckResult(name, ok, detail, fix))

    path = config_path or (workspace / ".rind" / "gateway.yaml")
    if not path.is_file():
        add(
            "配置文件",
            False,
            f"未找到 {path}",
            "运行 `python main.py gateway init` 创建（约 2 分钟）",
        )
        return results

    try:
        config = load_config(path)
        add("配置文件", True, f"{path} 解析成功")
    except ConfigError as exc:
        add("配置文件", False, str(exc), "按提示修正后重跑；或运行 `gateway init` 重新生成")
        return results

    # worker reachability (cheap: TCP/WS open is checked live only with --probe)
    worker = config.worker
    if worker == "stdio":
        add("worker 连接", True, "stdio 模式：网关将自起 worker 子进程")
    else:
        if config.worker_token:
            add("worker 连接", None, f"{worker}（未实测；加 --probe 做 WS 握手验证）")
        else:
            add("worker 连接", None, f"{worker}（无 worker_token：确认 worker 允许无鉴权连接）")

    if not Path(config.workspace).is_dir():
        add("workspace 目录", False, f"目录不存在：{config.workspace}", "修正 gateway.yaml 的 workspace 为绝对路径")
    else:
        add("workspace 目录", True, config.workspace)

    runtime_dir = Path(config.workspace) / ".rind"
    for name in ("state.json", "pairing.json"):
        target = runtime_dir / name
        readable, data = _read_json(target)
        if readable:
            add(name, True, "可读" if data else "尚未生成（首次运行后出现）")
        elif fix:
            add(name, True, f"文件损坏，{_fix_corrupt(target)}（已重置）")
        else:
            add(name, False, "文件损坏", "加 --fix 自动备份并重置")

    for channel_id, channel in config.channels.items():
        guide = GUIDES.get(channel_id)
        label = guide.label if guide else channel_id
        sdk_module = guide.sdk_module if guide else ""
        sdk_ok = True
        if sdk_module:
            try:
                importlib.import_module(sdk_module)
            except Exception:  # noqa: BLE001 - SDK 可选，缺失只影响该渠道
                sdk_ok = False
                add(f"渠道 {label}", False, f"SDK 未安装：pip install {sdk_module}")
        if not sdk_ok:
            continue
        if guide is not None and guide.probe and probe:
            answers = {"token": channel.token, **channel.extra}
            required = [spec.name for spec in guide.fields if spec.required]
            missing = [name for name in required if not answers.get(name)]
            if missing:
                add(f"渠道 {label}", False, f"缺少必填字段：{', '.join(missing)}")
                continue
            result = guide.probe({key: value for key, value in answers.items() if value})
            add(f"渠道 {label} 凭证", result.ok, result.detail)
        else:
            add(f"渠道 {label}", True, "已配置（加 --probe 验证凭证有效性）")

    if not config.channels:
        add("渠道", None, "尚未配置任何渠道", "运行 `python main.py gateway init` 添加")
    return results


def run_doctor(args) -> int:
    workspace = Path(args.workspace).expanduser().resolve()
    config_path = Path(args.config) if args.config else None
    results = run_checks(config_path, workspace, probe=bool(args.probe), fix=bool(args.fix))
    print("Rind 网关体检")
    failed = 0
    for check in results:
        if check.ok is True:
            mark = "✔"
        elif check.ok is None:
            mark = "⚠"
        else:
            mark = "✘"
            failed += 1
        print(f"  {mark} {check.name}：{check.detail}")
        if check.fix and not check.ok:
            print(f"      ↳ {check.fix}")
    if failed == 0:
        print("全部通过。启动：python main.py gateway --config <配置路径>")
        return 0
    print(f"{failed} 项未通过。", file=sys.stderr)
    return 1


__all__ = ["run_checks", "run_doctor"]
