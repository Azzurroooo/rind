# Desktop：Electron 只做桥接与窗口

Desktop 的 Electron main 进程启动并持有一个模块级 Worker runtime；preload 通过 allowlist 暴露窄接口，renderer 只调用这些接口并订阅快照与事件。当前实现不是“每个工作区永久一个 Worker”：`startRuntime` 在已有 runtime 存活时复用它，工作区作为启动参数和请求上下文传入。

~~~mermaid
flowchart LR
    R["Renderer<br/>原生 DOM/TS"] -->|allowlist| P["Preload contextBridge"]
    P --> M["Electron main"]
    M --> W["Python app-server --stdio<br/>单一存活 runtime"]
    M --> G["Remote Gateway（可选）"]
    G --> B["远端 Web / Mobile"]
    G --> M
~~~

main 维护 request_id 与 pending promise，runtimeGeneration 丢弃旧进程的迟到回复；stderr 有界保存，shutdownPromise 等待退出。Worker 错误通过 envelope 返回，preload 解包成带 type 的 Error，保持 renderer 的 try/catch 语义。

preload 同时暴露 runtime、auth、settings、models、sessions、workspaceFiles、background、goal、notifications 等能力；renderer 不能直接接触 Node 或 Python。远程 Gateway 复用本地 Worker，自己处理 ticket、Origin/网络策略与 Web 静态资源；关闭远程访问会清理远端票据，但不停止本地 Worker。

## 构建与远程访问

配置好 Python 环境后，使用 Node.js 22.19+（22.x）或 24+，在仓库根目录运行：

~~~sh
npm --prefix frontend-web ci
npm --prefix desktop ci
npm --prefix desktop run build:web
npm --prefix desktop run dev
~~~

build 会先构建 Web；package 还要求 desktop/resources/runtime 中有已冻结的 Worker，打包时复制到应用 resources/runtime，Web 产物复制到 resources/web。这些命令构建本地应用，不发布版本。

在 Desktop 的 Remote access 中启用共享，再从同一可信网络扫码或使用登录链接。每次启动默认关闭远程访问；Generate new code 会撤销已有连接和未使用票据。外网接入依赖已有 VPN 或 HTTPS 反向代理，Desktop 不创建公网隧道。关闭浏览器只断开该客户端；关闭 Desktop 才结束它托管的远程入口。

源码：[runtime 管理](../../../desktop/src/main/runtime.ts)、[main IPC](../../../desktop/src/main/index.ts)、[preload allowlist](../../../desktop/src/preload/index.ts)、[远程 Gateway](../../../desktop/src/main/gateway/server.ts)、[构建脚本](../../../desktop/package.json)。验证：[runtime 生命周期](../../../desktop/scripts/runtime-lifecycle.test.mjs)、[preload](../../../desktop/scripts/preload-runtime.test.mjs)、[Gateway](../../../desktop/scripts/gateway.test.mjs)。

[返回系列地图](../README.md)
