"""`gateway doctor`: one checklist for "为什么我的渠道没反应".

Each check answers a question a user would actually ask, in order:
配置在吗 → 能读吗 → worker 通吗 → 每个渠道的 SDK 装了吗、凭证有效吗 →
状态文件没坏吧。`--probe` adds live credential checks; `--fix` repairs what
can be repaired automatically (corrupt state files get a .corrupt backup).
"""

from __future__ import annotations

import asyncio
import importlib
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .config import ConfigError, load_config
from .onboarding import GUIDES
from .status import _worker_alive


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


def sdk_missing(sdk_module: str) -> bool:
    try:
        importlib.import_module(sdk_module)
        return False
    except ImportError:
        return True


def ensure_sdk_installed(sdk_module: str, *, runner=None) -> tuple[bool, str]:
    """pip install a channel SDK on the user's behalf; (ok, detail).

    `runner` is injectable for tests. After installing, the import cache is
    invalidated so the lazy adapter loader picks the SDK up immediately.
    """
    try:
        importlib.import_module(sdk_module)
        return True, "已安装"
    except ImportError:
        pass
    run = runner or (lambda cmd: subprocess.run(cmd, capture_output=True, text=True))
    result = run([sys.executable, "-m", "pip", "install", sdk_module])
    if getattr(result, "returncode", 1) != 0:
        tail = (getattr(result, "stderr", "") or "").strip().splitlines()[-1:] or ["pip 失败"]
        return False, f"pip install {sdk_module} 失败：{tail[0]}"
    importlib.invalidate_caches()
    try:
        importlib.import_module(sdk_module)
        return True, f"已自动安装 {sdk_module}"
    except ImportError as exc:
        return False, f"安装后仍无法导入 {sdk_module}：{exc}"


def _looks_like_source_dir(path: Path) -> bool:
    """运行数据绝不该落进 Rind 的工程目录（含 main.py 与 gateway/ 的树）。"""
    return (path / "main.py").is_file() and (path / "gateway").is_dir()


def ensure_channel_sdks(guides, *, interactive: bool, confirm=None, echo=print):
    """缺渠道 SDK 的自动 pip 安装；返回（保留的渠道，是否启用启动自愈）。

    一键模式直接装；交互模式先征求同意（confirm 注入，向导传自己的提问
    函数；缺省用 prompt.confirm）。失败或用户拒绝 → 渠道从本次配置剔除。
    环境变量 RIND_GATEWAY_NO_AUTO_INSTALL=1 整体关闭（测试/CI）。
    """
    import os

    if confirm is None:
        from .prompt import confirm as _confirm_impl

        confirm = _confirm_impl

    if os.environ.get("RIND_GATEWAY_NO_AUTO_INSTALL"):
        return guides, False
    kept = []
    for guide in guides:
        if guide.sdk_module and sdk_missing(guide.sdk_module):
            if interactive:
                if not confirm(f"渠道 {guide.label} 需要 {guide.sdk_module}（当前未安装）。自动安装？"):
                    echo(f"  已跳过 {guide.label}：缺 {guide.sdk_module} 的渠道不会写入配置。")
                    continue
            echo(f"  正在安装 {guide.sdk_module} …")
            ok, detail = ensure_sdk_installed(guide.sdk_module)
            echo(f"  {'✔' if ok else '✘'} {detail}")
            if not ok:
                echo(f"  已跳过 {guide.label}。手动安装：pip install {guide.sdk_module}")
                continue
        kept.append(guide)
    return kept, bool(kept)


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

    # worker reachability: real WS handshake by default — "开没开" 不该靠猜
    worker = config.worker
    if worker == "stdio":
        add("worker 连接", True, "stdio 模式：网关将自起 worker 子进程")
    else:
        alive, detail = asyncio.run(_worker_alive(worker, config.worker_token, timeout=5.0))
        add(
            "worker 连接",
            True if alive else False,
            f"{worker} — {detail}",
            fix="" if alive else "确认 worker 已启动（python main.py app-server --web ...）且 worker_token 一致",
        )

    ws_dir = Path(config.workspace)
    if not ws_dir.is_dir():
        add("workspace 目录", False, f"目录不存在：{config.workspace}", "修正 gateway.yaml 的 workspace 为绝对路径")
    elif _looks_like_source_dir(ws_dir):
        add(
            "workspace 目录",
            None,
            f"{config.workspace} 看起来是 Rind 的工程目录——运行数据（state/pairing/uploads）会混入源码树",
            "建议为网关会话换一个独立目录（如 ~/rind-workspace）",
        )
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
