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

源码：[设置加载](../../../agent/infrastructure/settings.py)、[凭证存储](../../../agent/infrastructure/credentials.py)、[解析和登录](../../../agent/infrastructure/llm/provider_service.py)。验证：[设置加载](../../../test/test_settings_loader.py)、[供应商认证](../../../test/test_provider_auth.py)、[协议认证交互](../../../test/test_runtime_server_auth.py)。

[返回系列地图](../README.md)
