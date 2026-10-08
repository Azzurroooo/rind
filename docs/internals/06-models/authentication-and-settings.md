# 配置与凭证：先选配置，再解析秘密

Rind 分开保存模型设置与登录凭证。设置只来自用户自己的 RIND_HOME/settings.json；凭证按当前供应商独立解析。

~~~mermaid
flowchart TD
    U["RIND_HOME/settings.json"] --> S["有效 AppSettings"]
    S --> K{"当前供应商的 apiKey 可解析？"}
    K -->|"是"| C["客户端凭证"]
    K -->|"否"| A["auth.json 中的供应商凭证"]
    A -->|"存在"| C
    A -->|"不存在"| E["供应商对应的环境变量"]
    E --> C
~~~

## 项目目录不提供配置

项目里的 .rind/settings.json 不被读取。仓库内容是不可信输入：如果它能决定 baseUrl，就能把已登录的密钥和代码上下文引到任意地址；如果它能决定 serverToken，就能预设 Web 运行时的认证口令。项目 .rind/ 下的 Skill 与 RIND.md 不受影响。

RIND_HOME 默认是 ~/.rind，统一改变设置、凭证、会话等用户数据的位置。会话中的模型选择还可通过协议更改；磁盘默认设置与当前会话选择是不同职责。

## 连接：选择指向谁

会话保存的 provider 是一个连接 id。内置供应商各是一个同名连接，登录后即可使用；用户也可以在 /login 里选择 "Add a named endpoint"，填写名字、OpenAI 兼容的 Base URL、可选的模型 id 和 API key，得到一个命名连接（id 由名字生成，不能与内置供应商重名）。命名连接与它的 key 一起存在 auth.json，从不写入项目目录；再次 /login 同一连接只替换 key，/logout 删除整个连接。

连接的地址与凭证在每次组装客户端时重新解析，所以换 key 或重新登录从下一轮生效。会话引用的连接不存在时，回合直接失败并说明原因（提示 /login 或 /model），不会悄悄换成另一个端点。模型在两轮之间切换时，客户端与该模型的图片能力一起替换。

## 新对话从哪里取模型

会话创建时查一次默认，结果写进会话 meta；之后每一轮只读 meta。查找顺序（模型组与 effort 各自取第一个设置过的值）：

1. 此文件夹的默认（RIND_HOME/workspaces.json，以规范化真实路径为键）；
2. 若此文件夹是 Git worktree：主仓库文件夹的默认（从 .git 文件的 gitdir 找到主仓库，不启动 git）；
3. settings.json。

模型组是连接加模型，总是一起设置；effort 单独设置。文件夹默认只影响之后新建的对话，已有对话保持自己的选择。会话 meta 的 selection_source 记录两部分各自来自 session、folder、main_repository 还是 settings，/status 据此标注来源。设置文件夹默认时会校验：连接已配置、模型在它的列表里、effort 是该模型支持的级别。协议方法为 rind/folder_defaults/get、set、unset，以及把一个已有对话同步到文件夹当前默认的 rind/folder_defaults/apply。

## 最小配置与登录

CLI 中用 /login 保存供应商 API key，用 /model 选择模型，/effort 调整支持的推理级别。目前交互式登录只实现 api_key；凭证数据类型能表示 OAuth，不等于已有 OAuth 登录流程。

通用 Chat Completions 端点可使用以下 settings.json；将 MY_MODEL_KEY 设置为本机环境变量：

~~~json
{
  "provider": "openai-compatible",
  "api": "openai-chat",
  "baseUrl": "https://your-endpoint.example/v1",
  "model": "your-model-id",
  "apiKey": "$MY_MODEL_KEY"
}
~~~

## 保存方式的真实边界

auth.json 是本地 JSON 文件，使用文件锁、临时文件替换和尽力设置的文件权限；它没有操作系统密钥链或加密存储承诺。单次读写有锁，也不等于整个读—改—写事务一直持锁。移动端的安全存储保存的是远程连接凭证，与 Python 供应商凭证不是同一个系统。

源码：[设置加载](../../../agent/infrastructure/settings.py)、[文件夹默认](../../../agent/infrastructure/workspace_defaults.py)、[凭证存储](../../../agent/infrastructure/credentials.py)、[解析和登录](../../../agent/infrastructure/llm/provider_service.py)。验证：[设置加载](../../../test/test_settings_loader.py)、[文件夹默认](../../../test/test_workspace_defaults.py)、[协议](../../../test/test_folder_defaults_protocol.py)、[供应商认证](../../../test/test_provider_auth.py)、[协议认证交互](../../../test/test_runtime_server_auth.py)。

[返回系列地图](../README.md)
