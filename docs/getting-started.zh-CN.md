# Rind 安装与配置指南

[返回 README](../README.zh-CN.md) · [English](getting-started.md)

## 安装 CLI

安装 Node.js 18+ 后：

```bash
npm install -g @rind-ai/cli
cd your-project
rind
```

npm 包会依赖对应平台的预编译程序包。目前发布的平台为 Windows x64、macOS x64/arm64、Linux x64。也可以从 [Releases](https://github.com/Azzurroooo/rind/releases) 下载独立 CLI 安装包。

在 Rind 中，用 `/login` 选择供应商并输入 API Key，再用 `/model` 选择模型。`/effort` 提供当前模型支持的推理级别。登录凭据保存在 `~/.rind/auth.json`；设置 `RIND_HOME` 后则保存在对应目录下。

让 Rind 读取本地图片路径，或发送已有的 `uploads/...` 图片引用，即可进行图片分析。`/model` 会显示识图能力；图片快照随会话保存，原图修改或删除不会影响历史。支持 PNG/JPEG/WebP/GIF/BMP，动画读取首帧；每次请求最多 8 张图片。未知能力会提示并尝试，明确不支持时会说明图片未发送。详见[图片输入说明](image-input.md)。

## 自定义端点

对于 OpenAI 兼容的 Chat Completions 端点，在 `~/.rind/settings.json` 中填写地址、模型 ID 和密钥：

```json
{
  "provider": "openai-compatible",
  "api": "openai-chat",
  "model": "your-model-id",
  "apiKey": "your-api-key",
  "baseUrl": "https://your-endpoint.example/v1"
}
```

当前工作区中完整的 `.rind/settings.json` 优先于用户配置，两者不会逐字段合并。Team Agent 从各自工作目录启动：共享配置可放在用户目录，某个专家的独立配置则放在其工作区的 `.rind/` 下。

`RIND_HOME` 可修改用户数据目录，默认是 `~/.rind`。其中保存配置、登录凭据、会话与用户蓝图。原生供应商 ID 和 API 类型见[供应商目录](../agent/infrastructure/llm/catalog.py)。

## 从源码运行

需要 Python 3.12+、Node.js 18+ 和 Git。源码分支包含尚未进入最新发布版的更新，例如 v0.8.0 之后加入的交互导览。

```bash
git clone https://github.com/Azzurroooo/rind.git
cd rind
python -m venv .venv
```

激活虚拟环境：

```bash
# macOS / Linux
source .venv/bin/activate
```

```powershell
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
```

然后安装运行所需依赖并启动 CLI：

```bash
python -m pip install -r requirements-runtime.txt
node frontend-cli/bin/rind.js
```

阅读其他示例时，用 `node /absolute/path/to/rind/frontend-cli/bin/rind.js` 替换 `rind`。保持 Python 虚拟环境激活；使用脚本绝对路径，即可从其他项目或 Team Agent 的目录启动。

在仓库根目录体验导览：

```bash
node frontend-cli/bin/rind.js tour team.create
```

导览需要交互式终端，不调用模型。不带页面 ID 的 `tour` 会打开目录。按键和实现细节见[导览文档](cli-tour.md)（英文）。

## 桌面端

桌面构建工具需要 Node.js 20.x 中的 20.19+ 版本，或 Node.js 22.12+。完成上述 Python 环境配置后，在仓库根目录执行：

```bash
npm --prefix desktop install
npm --prefix desktop run dev
```

桌面端会启动自己的本地 worker。使用与 CLI 相同的 `RIND_HOME` 和会话目录，即可访问同一批已保存会话。

## Web 端

安装 Docker 和 Compose v2 后，在仓库根目录创建 `.env`：

```dotenv
RIND_SERVER_TOKEN=replace-with-a-long-random-token
RIND_WORKSPACE=/absolute/path/to/your/project
RIND_HOME=/absolute/path/to/rind-data
```

两个路径都应指向宿主机上已存在的目录。将模型供应商配置写入所选数据目录的 `settings.json`，然后执行：

```bash
docker compose up -d --build
```

打开 `http://localhost:8080`，使用配置的服务端 token 连接。默认仅绑定本机；远程访问可使用私网或带身份验证的 TLS 代理。通过 `RIND_WEB_PORT` 和 `RIND_WEB_BIND` 调整浏览器访问端口与绑定地址。

浏览器断开后 worker 继续运行。不使用 Docker 时，可参考 [Web 本地开发说明](../frontend-web/README.md#local-development)（英文）。

## 消息网关

在源码仓库中保持 Python 环境激活，先用一个终端启动 WebSocket worker：

```bash
python main.py app-server --web --host 127.0.0.1 --port 8765 --cwd /absolute/path/to/your/project
```

在仓库根目录打开另一个终端，运行配置向导，再启动网关：

```bash
python main.py gateway init --workspace /absolute/path/to/your/project
python main.py gateway --config /absolute/path/to/your/project/.rind/gateway.yaml
```

向导会询问 worker 连接方式和渠道凭据、确认工作区，并在其中生成 `.rind/gateway.yaml`。如果选择了其他工作区，启动时使用向导输出的配置路径。

适配器包括 Telegram、Discord、Slack、飞书、钉钉、QQ、企业微信、WhatsApp Cloud 和邮件。各渠道所需的 SDK、平台账号和入站回调条件不同，向导会提供针对性说明；`python main.py gateway doctor` 可检查配置与依赖。连接启用身份验证的 worker 时，需要在网关配置中填写其 token。

陌生发送者可以请求配对。使用 `python main.py gateway approve <CODE>` 批准配对码，确保该命令与运行中的网关使用相同配置和工作区。

## 开发与测试

在仓库根目录、Python 虚拟环境已激活的情况下：

```bash
python -m pip install -r requirements.txt
python -m pytest test/ -q
npm --prefix frontend-cli install
npm --prefix frontend-cli test
```

以上为自动回归。真实用户流程验收单独放在 [`test/manual/`](../test/manual/README.md)，仅在用户明确要求时执行，可能消耗真实模型 token，不属于默认测试命令。参见[测试分类](../test/README.md)。

[架构文档](architecture.md)介绍模块边界，[CLI 渲染](cli-rendering.md)介绍终端组件模型。[CLI turn 流程](cli-turn-flow.md)和[主流水线](main_pipeline.md)进一步说明执行过程（均为英文）。
