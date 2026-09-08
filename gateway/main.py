"""Gateway process entry: config → worker client → channels → pump loop.

Also hosts the out-of-process pairing approval: ``python main.py gateway
approve <CODE>`` reads and writes the same pairing.json as the running
gateway, so approval never needs the bot process to restart.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from .channels import build_channel
from .config import ConfigError, GatewayConfig, load_config, resolve_config_path
from .pump import TurnPump
from .router import SessionRouter
from .security import CooldownGate, PairingStore, SecurityGate
from .worker_client import WorkerClient, WorkerError

logger = logging.getLogger(__name__)

STARTING_NOTICE = "Rind 网关启动中……（worker 就绪与渠道连接可能需要几十秒）"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gateway",
        description="Rind 消息网关——把聊天软件接到你的 worker。首次使用：gateway init",
    )
    parser.add_argument("--config", default=None, help="gateway.yaml 路径（默认 <工作目录>/.rind/gateway.yaml）")
    parser.add_argument("--workspace", default=".", help="工作目录（配置与状态查找的根，默认当前目录）")
    subparsers = parser.add_subparsers(dest="command")
    approve = subparsers.add_parser("approve", help="批准配对码；不带码则列出全部待批请求")
    approve.add_argument("code", nargs="?", default="", help="6 位配对码（陌生发送者收到的卡片上）")
    init = subparsers.add_parser("init", help="交互式创建 gateway.yaml（分渠道引导 + 实时凭证验证 + 自动抓取账号 ID）")
    init.add_argument("--channel", default="", help="逗号分隔的渠道 id（如 telegram,email；跳过选择菜单）")
    init.add_argument("--yes", action="store_true", help="非交互一键模式：字段全部来自 RIND_GW_<渠道>_<字段> 环境变量")
    init.add_argument("--worker-url", default="", help="Worker 地址（不填则自动决定：探测本机 worker，没有就 stdio 自起）")
    init.add_argument("--workspace", default=None, help="工作目录（默认当前目录）")
    doctor = subparsers.add_parser("doctor", help="逐项体检：配置/worker/SDK/凭证/状态文件（--probe 实测凭证，--fix 自动修复）")
    doctor.add_argument("--probe", action="store_true", help="实时验证渠道凭证（会访问平台 API）")
    doctor.add_argument("--fix", action="store_true", help="自动修复可修复项（损坏的状态文件备份为 .corrupt）")
    doctor.add_argument("--config", default=None, help="gateway.yaml 路径")
    doctor.add_argument("--workspace", default=".", help="工作目录")
    status = subparsers.add_parser("status", help="一屏状态：会话映射/配对/渠道/worker 在线")
    status.add_argument("--config", default=None, help="gateway.yaml 路径")
    status.add_argument("--workspace", default=".", help="工作目录")
    subparsers.add_parser("start", help="启动网关（等价于不带子命令运行）")
    return parser


async def _run(config: GatewayConfig, runtime_dir: Path, pairing: PairingStore) -> int:
    router = SessionRouter(runtime_dir / "state.json")

    def cursor_for(session_id: str) -> int:
        key = router.key_for_session(session_id)
        return router.cursor_for(key) if key else 0

    worker = WorkerClient(config.worker, config.worker_token, cursor_provider=cursor_for)
    security = SecurityGate(
        pairing=pairing,
        cooldown=CooldownGate(config.cooldown_per_minute),
        allow_from={channel_id: channel.allow_from for channel_id, channel in config.channels.items()},
        group_allow={channel_id: channel.group_allow for channel_id, channel in config.channels.items()},
        pairing_enabled=config.pairing.enabled,
        pairing_ttl_seconds=config.pairing.ttl_minutes * 60,
    )
    pump = TurnPump(worker=worker, router=router, security=security, workspace_root=config.workspace)
    await worker.start()  # connect + initialize + capability gate
    for key, record in router.all_sessions().items():
        try:
            await worker.subscribe(record.session_id)
        except WorkerError as exc:
            logger.warning("gateway: resubscribe of %s failed: %s", key, exc)
    uploads_root = Path(config.workspace) / config.uploads_dir
    outcomes: list[tuple[str, bool]] = []
    for channel_id, channel_config in config.channels.items():
        channel = build_channel(channel_id, channel_config, uploads_root)
        if channel is None and config.auto_install_sdk:
            # SDK 缺失时自愈：装好再建一次（向导同意过 auto_install_sdk 的用户
            # 不该被 "pip install xxx" 挡在门外）。
            from .doctor import ensure_sdk_installed
            from .onboarding import guide_for

            guide = guide_for(channel_id)
            if guide is not None:
                for module in [guide.sdk_module, *guide.runtime_deps]:
                    if module:
                        ok, detail = ensure_sdk_installed(module)
                        logger.info("gateway: auto-install %s for channel %s: %s", module, channel_id, detail)
                channel = build_channel(channel_id, channel_config, uploads_root)
        if channel is None:  # registry already logged why (unknown id / SDK / config)
            outcomes.append((channel_id, False))
            continue
        pump.register_channel(channel)
        try:
            # The pump is the adapters' sink: they normalize SDK events into
            # InboundMessage and call back through pump.inbound (§8).
            await channel.start(pump)
        except Exception as exc:  # §1: one failing channel never stops the process
            logger.warning("gateway: channel %s failed to start; disabled: %s", channel_id, exc)
            outcomes.append((channel_id, False))
            continue
        outcomes.append((channel_id, True))
    scan = asyncio.create_task(pump.run(), name="gateway-scan")
    from .status import startup_panel

    print(startup_panel(config.worker, outcomes, config.pairing.enabled), flush=True)
    try:
        await scan
    finally:
        await worker.stop()
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    args = build_parser().parse_args(list(sys.argv[1:] if argv is None else argv))
    # init owns its workspace prompting (default None on the subparser); every
    # other path resolves against the current directory.
    workspace = Path(args.workspace or ".").expanduser().resolve()

    if args.command == "init":
        from .wizard import run_init

        return run_init(args)
    if args.command == "doctor":
        from .doctor import run_doctor

        return run_doctor(args)
    if args.command == "status":
        from .status import run_status

        return run_status(args)
    if args.command == "start":
        args.command = "run"  # start 与裸运行等价；提供给向导与文档作为显式动词

    # Approving a pairing code only needs pairing.json — never require (or
    # even read) gateway.yaml, so approval works on a machine without config.
    if args.command == "approve":
        from .status import channel_label, pending_lines

        pairing = PairingStore(workspace / ".rind" / "pairing.json")
        code = args.code.strip()
        entry = pairing.approve(code) if code else None
        if entry is not None:
            channel = str(entry.get("channel") or "")
            print(f"已批准 {channel_label(channel)} · {entry.get('sender_id', '?')}——现在可以直接给 bot 发消息了。")
            return 0
        pending = pending_lines(pairing.pending)
        if pending:
            print("待批准的配对请求：")
            for line in pending:
                print(line)
            print("批准：python main.py gateway approve <上面的配对码>")
        else:
            print("没有待批准的配对请求。等有人给 bot 发消息后，这里会出现配对码。")
        return 0 if not code else 1

    try:
        config = load_config(resolve_config_path(args.config, workspace))
    except ConfigError as exc:
        # 引导向导不再限定 tty：管道输入 "Y\n" 同样可用（便于自动化与测试），
        # 输入结束（EOF）则安静取消。
        print(f"gateway: {exc}")
        try:
            offer = input("现在运行配置向导（gateway init）？[Y/n]: ").strip().lower()
        except EOFError:
            offer = "n"
        if offer in ("", "y", "yes"):
            from types import SimpleNamespace

            from .wizard import run_init

            # The base parser has no init-only flags; give the wizard the
            # namespace shape it expects (interactive mode, wizard's own
            # prompts for worker/workspace).
            return run_init(
                SimpleNamespace(
                    command="init", config=None, channel="", yes=False,
                    worker_url="", workspace=str(workspace),
                )
            )
        print("运行 `python main.py gateway init` 交互式创建配置。", file=sys.stderr)
        return 2
    runtime_dir = Path(config.workspace) / ".rind"
    pairing = PairingStore(runtime_dir / "pairing.json")
    print(STARTING_NOTICE, flush=True)
    try:
        return asyncio.run(_run(config, runtime_dir, pairing))
    except KeyboardInterrupt:
        print("\n网关已停止。")
        return 0
    except RuntimeError as exc:  # capability gate: worker needs upgrading first
        print(f"gateway: {exc}", file=sys.stderr)
        return 1


__all__ = ["main"]
