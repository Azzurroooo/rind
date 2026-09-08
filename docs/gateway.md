# Rind 网关：从零到第一条回复

网关把你的聊天软件（Telegram、微信/QQ、飞书……）接到 Rind 上：你在 IM 里发消息，agent 在电脑上干活，结果回到聊天窗口。本文按真实使用顺序组织——照着做即可，不需要理解内部结构。

## 三步上手

```bash
# 1. 配置向导（约 2 分钟：选渠道 → 粘贴凭证 → 自动验证）
python main.py gateway init

# 2. 启动网关（向导最后一步也可以直接帮你启动）
python main.py gateway

# 3. 用手机给 bot 发一条消息。陌生账号会收到 6 位配对码，在电脑上批准：
python main.py gateway approve <配对码>
```

之后这个账号就是你的了，直接对话，无需重复批准。

## 向导会问你什么（以及不会问什么）

向导只问它必须问的——**你没有任何凭证时，只需要粘贴渠道凭证本身**：

- **worker / token：不问。** 向导先探测本机是否已有 worker 在跑：有就用它；没有就用 `stdio` 模式（网关自己启动 worker，随网关开关，不需要第二个终端）。远程 worker 是高级用法，用 `--worker-url` 显式指定时才会问 token。
- **渠道凭证：逐个引导。** 每个渠道都会先打印"去哪里拿凭证"的分步说明（如 Telegram：找 @BotFather → /newbot → 复制 token），然后才要你粘贴。
- **粘贴前先验证。** 凭证填完可以选择立即探活（真实调用平台 API），错了当场重填，而不是启动后才发现。
- **环境变量已有值的不再问。** 设置过 `RIND_GW_<渠道>_<字段>`（如 `RIND_GW_TELEGRAM_TOKEN`）的项直接采用并告知。
- **白名单可以留空。** 陌生账号首次发消息会收到配对码，批准后自动进入白名单——不用预先收集自己的数字 ID。
- **收尾不用抄命令。** 写完配置自动体检、可以直接启动。

自动化/CI 场景用一键模式，全程零交互：

```bash
RIND_GW_TELEGRAM_TOKEN=123456:AAE python main.py gateway init --yes --channel telegram
```

## 配对是怎么工作的

- 名单内（`allow_from` / 已批准）账号：直接对话。
- 陌生账号：收到一张配对卡——身份、6 位配对码、有效期（默认 60 分钟）。
- 你在**运行网关的机器**上批准：`python main.py gateway approve <码>`。
- 忘了码 / 码抄错了：直接运行 `python main.py gateway approve`（不带码），列出全部待批请求，照着列表批准。
- 每个账号批准一次永久有效（存在工作区 `.rind/pairing.json`）。

## 日常命令

| 命令 | 什么时候用 |
| --- | --- |
| `python main.py gateway` | 启动。就绪后会打印一屏状态：worker、各渠道 ✔/✘、配对说明 |
| `python main.py gateway status` | 不启动，只看当前状态（会话、配对、渠道、worker） |
| `python main.py gateway doctor` | 排查。逐项体检：配置 → worker → 渠道 SDK → 状态文件 |
| `python main.py gateway doctor --probe` | 体检 + 真实验证各渠道凭证 |
| `python main.py gateway init` | 加渠道 / 换渠道（重新跑向导，只填新渠道即可） |

## 出问题了？

先跑 `python main.py gateway doctor`，它会直接告诉你哪一项没过、为什么、怎么修。常见情况：

- **渠道启动后显示 ✘** → `gateway doctor` 给出原因（通常是渠道 SDK 未安装，按提示 `pip install` 即可）。
- **发了消息没反应** → ①先确认你已批准配对（`gateway approve` 看列表）；②群聊需要 @机器人；③`gateway doctor --probe` 验证凭证是否还有效。
- **Telegram 超时** → 国内网络需要给网关配代理（向导里有专门字段，`http://127.0.0.1:7890` 这种形式；系统代理对网关不自动生效）。
- **worker 连不上**（仅远程 worker 场景）→ 确认 worker 进程在跑、`worker_token` 两边一致。

## 高级：手写 gateway.yaml

向导生成的配置在 `<workspace>/.rind/gateway.yaml`。手写是支持的（例如批量部署），同样的文件格式：

```yaml
worker: ws://127.0.0.1:8765   # 或 stdio：网关自起 worker 子进程
worker_token: ${RIND_SERVER_TOKEN}
workspace: /home/me/rind-workspace   # 绝对路径；网关会话的根目录
channels:
  telegram:
    token: ${TELEGRAM_BOT_TOKEN}
    allow_from: ["12345678"]
  discord:
    token: ${DISCORD_BOT_TOKEN}
pairing:
  enabled: true          # 陌生账号凭配对码申请加入
```

规则：`${VAR}` 从环境变量插值；未知键、未定义变量都是启动错误（绝不静默兜底）；每个渠道还有自己的扩展字段，跑一次 `gateway init` 选择该渠道即可看到全部字段说明。

Docker 部署：`docker compose --profile gateway up -d`，配置放在 `./.rind/gateway.yaml`。网关只发起出站连接，没有任何入站端口。
