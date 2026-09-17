# Python worker 瘦身与提效：实施及验证记录

日期：2026-09-17。依据本地 `.docs/python-worker-slimming-plan.md` 实施；未改持久化格式、模型协议字段或前端交互。

完成了确定性清理、资源归属、会话 I/O 与局部计算去重，以及 Windows 冻结包裁剪。SDK、网页解析器和 YAML 的整库替换没有通过本轮采用门槛，未保留试验后端。**Windows 验证完成不等于四平台发布验收完成。**

## 1. Git 与交付边界

| 项目 | 基线 | 本轮实现 |
| --- | --- | --- |
| Rind | `57cec279d0c628d23f9b831bba5cf4f1ec0a9b12` | 分支 `refactor/python-worker-slimming`；最终 worker 构建输入 `7fd89997acf0f697a06ff631d2ec998cb5828e9e`，之后仅补充 CI 引用、基准脚本和本报告 |
| distribution | `f10cb12`，原有 `experiment/cli-size-0.8.0` | 隔离克隆 `.docs/slimming-distribution`，同名分支，提交 `bf65d8f43c41856c303245a1877b20e95b4ed106` |
| Python / 构建工具 | CPython 3.12.13 / PyInstaller 6.22.3 / hooks 2026.7 | 相同版本；发布依赖固定版本及 wheel/sdist 哈希 |

源码按清理、provider、依赖方向、装配、会话、plan、shell、HTTP、计算和验证分别提交。原有 distribution 工作目录没有被修改，也没有合并其他功能分支。

**两仓库都未推送、未创建 PR、未合并 main。** `release.yml` 已引用上述新的 distribution SHA。远端发布前必须先推送 distribution 分支，确保该 SHA 可被 checkout，再提交/合并 Rind 的配套变更。

distribution 分支基于原有打包实验分支，包含其已有的 5 个优化/修复提交；它不是从 distribution 的 `main` 重新开始。后续 PR 应明确此依赖，不能把旧实验的优化算作本轮收益。

## 2. 实测收益

### 2.1 源码与发布闭包

| 指标 | 基线 | 当前 | 变化 |
| --- | ---: | ---: | ---: |
| `agent/` + `gateway/` Python 物理行 | 25,504 | 25,312 | **−192 行** |
| 业务 Python 文件数 | 162 | 164 | +2；用于显式边界和资源归属 |
| 通用发布锁中的包数（含构建工具、平台条件包） | 68 | 62 | **−6** |
| Windows x64 one-folder | 71.483 MiB | 67.579 MiB | **−3.904 MiB，约 5.46%** |
| 相同 ZIP Deflate level 6 压缩 | 36.595 MiB | 33.276 MiB | **−3.319 MiB，约 9.07%** |
| 冻结 Python 模块数 | 5,682 | 5,169 | −513 |

源码统计包含注释、空行和包文件，不包含测试、基准脚本及独立打包仓库。没有靠压行或删除功能测试制造减少量。ZIP 是比较用的 worker 压缩包，**不是 Windows 安装器或 npm 平台包的实测体积**；本轮也未测 Docker 镜像层。

最终基线使用只安装原 runtime requirements 与构建工具的干净环境重建，排除了早期测试环境中额外收集的 3 个 `_pytest` 模块。两边相同的依赖使用同一解析版本，基线新增的无用直接依赖也被固定版本和哈希。

实际减少的发布锁依赖为 `prompt-toolkit`、`wcwidth`、`rich`、`markdown-it-py`、`mdurl`、`pygments`。本轮锁定的 curl_cffi 0.16.3 不要求 Rich；较旧安装环境可能仍将 Rich 作为传递依赖保留，不能只看应用 requirements 推断安装闭包。

Tenacity 已不再由业务直接导入/声明，但仍由 Google SDK 引入。OpenAI、Anthropic、Google SDK、Pydantic、cryptography、HTTPX、curl_cffi、tiktoken 和完整正文提取链均保留。

冻结收集的具体变化：

- curl_cffi 模块从 28 个降至 20 个，移除 CLI 和 `__main__` 收集；保留请求、流、cookies、代理和 TLS impersonation。
- Rich 从 94 个冻结模块降至 0；SQLite Python 模块从 4 个降至 0，并移除 Windows SQLite 动态库。filelock 4.0.0 对可选 reader/writer 锁的 ImportError 有明确处理，实际使用的 FileLock 保留。
- 排除 `lxml.objectify`，保留 `etree`、HTML clean、trafilatura 配置和全部 justext stoplists。
- **新增约 1.60 MiB 的 cl100k_base 编码数据**，上述净体积收益已经扣除此成本。编码内容由 tiktoken 的预期 SHA-256 校验，冻结启动通过 runtime hook 指向内置缓存；显式用户缓存覆盖仍被尊重。

### 2.2 会话和计算

同机、同一 Python 3.12 环境，使用合成数据，无真实用户历史。每种会话先热身一次，再采集 20 次；p95 使用 nearest-rank。峰值是 `tracemalloc` 记录的加载及首次投影阶段 Python 分配，**不是进程 RSS**。

| 场景 | 基线 p50 / p95 | 当前 p50 / p95 |
| --- | ---: | ---: |
| 1k 消息恢复 | 27.71 / 33.09 ms | 9.36 / 10.52 ms |
| 10k 消息恢复 | 218.60 / 226.69 ms | 59.72 / 62.51 ms |
| 1k 消息首次投影 | 12.18 / 17.14 ms | 10.36 / 11.53 ms |
| 10k 消息首次投影 | 105.75 / 109.90 ms | 87.92 / 94.24 ms |
| 10k 消息 + 1k 工具记录恢复 | 250.50 / 257.40 ms | 110.73 / 130.42 ms |
| 同上首次投影，第一批 | 176.72 / 184.83 ms | 157.20 / 199.25 ms |

工具记录每条同时包含约 8.2 KiB 原始输出和模型输出。第一批工具密集投影的 p95 有回退，因此追加 3 轮基线/当前交替测量，每轮各 20 次：基线投影 p50 为 179.03–180.48 ms、p95 为 187.17–192.03 ms；当前 p50 为 152.40–153.67 ms、p95 为 155.78–166.66 ms。**保留第一批波动，不把单轮数据当作稳定的尾延迟保证。**

10k 普通消息加载/投影峰值分配从 18.53 MiB 降至 16.69 MiB；工具密集样本从 36.38 MiB 降至 34.11 MiB。三组消息投影的 SHA-256 前后一致。

rescue 样本使用 100 条较长中英文消息和 500-token 人工低上限，触发原有循环保护：热身后 5 次的中位数 **716.59 → 88.83 ms**。结果仍为 26,220 tokens，消息散列一致；该极端样本用于证明重复 tokenization 热点，不能解释为所有正常请求提速 8 倍。

并发启动检查使用无外部模型请求的真实 worker 装配，热身后 10 次：第一个会话就绪中位数 35.16 ms，两个会话全部就绪 70.13 ms。锁内串行化仍存在。本轮保留锁策略，没有为约 35 ms 的本机等待增设每会话初始化任务表；慢磁盘、大型 Team 或大规模并发需另做负载测量。

## 3. S01–S15 实施对应

| 任务 | 结果与边界 |
| --- | --- |
| S01 基线/发布环境 | 完成 Windows 干净基线、版本和哈希锁、Python patch pin、重建环境、两仓库 SHA/锁哈希/pip inspect/TOC/xref 记录。构建开始要求 tracked 文件干净，构建结束检查输入未变化。新增四平台手动验证 workflow，但未在远端运行。 |
| S02 死代码 | 删除旧 Git prompt provider、无调用 context/formatting 辅助函数；使用 `Path.is_relative_to`；清理重复异常分支等。 |
| S03 依赖/冻结收集 | 移除 3 项无业务直接用途的声明；按实际依赖链裁剪 CLI、objectify、可选 SQLite 锁；保留 TLS 和提取资源，补齐离线编码数据。 |
| S04 取消/关闭 | 统一等待与任务回收；成功、错误、token 取消、外部取消、同时完成均有测试。`ChatClient.close()` 成为明确契约；Google 异步/同步资源分别关闭。 |
| S05 重试 | 移除 OpenAI Chat 外层 Tenacity，生产装配明确 SDK `max_retries=14`，SDK 为唯一网络重试所有者；持续 429 实测最多 15 次请求，Retry-After 等待可取消。不重放已输出的流。 |
| S06 依赖环 | 公共命令契约下沉至 `commands/contracts.py`；网关入口逻辑移至 `gateway/runner.py`。AST 检查涵盖函数内和相对导入，无业务模块循环依赖。 |
| S07 装配/导入 | 删除根级工具目录构建副作用，registry 接收显式目录，catalog 必须接收 shell/HTTP 资源；provider 延迟导入；schema 复用已解析的函数签名。 |
| S08 资源归属 | ShellTools/WebSessions 由 worker 拥有并显式传入；standalone container 暴露所拥有资源。idle 释放 shell 状态但保留后台进程，删除会话/关闭 worker 回收进程；inspect 使用独立 shell。HTTP session 独占借用，可并发且可复用；关闭等待在用连接归还，在工作线程等待，不阻塞事件循环。 |
| S09 plan 显式路径 | load/write 和摘要接收 session base；工具绑定公开路径 getter，在草稿持久化后才取路径。删除 ContextVar、set/clear/preserve 及未公开使用的环境 fallback。 |
| S10 读盘 | 恢复/初始化复用一次 messages 读取，原路径为四次；启动不再通过 settings_for 重读 info。计数、preview、过滤和文件锁语义保留；不增加长期配置缓存。info 内默认配置解析和后续 settings 装配仍各有一次读取。 |
| S11 投影/回放 | cache miss 只在返回边界 deepcopy；每组选项仅保留最新签名，最多 8 组；保留外部追加检测和修改隔离。回放先切事件范围再创建 envelope，cursor 不变；仍是全量历史投影，没有宣称实现分页存储。 |
| S12 计算 | rescue 在单次 build 内按序列化 payload 复用 token 数，内容/标签变化自动失效；不引入跨轮缓存。未扩大到 snapshot/schema/normalizer 的全局缓存或新数据结构。 |
| S13 网页 | 搜索与抓取响应统一关闭，包括重定向、超限、取消和错误；保留抓取上限、引擎顺序与正文回退。HTTPX/正文库整体替换本轮不采用。 |
| S14 SDK 替换 | 完成边际体积和契约范围评估，未进入 REST 后端重写；保留现有适配器，未添加无使用者的双后端开关。 |
| S15 MIME/YAML | 5 个渠道共用附件 MIME 分类纯函数。PyYAML 语义对照发现兼容差异，保留现有两套有不同职责的受限解析器；不增加第三套解析器或渠道基类。 |

### 重试行为的明确变化

15 次是原来特定错误下的 5 × 3 网络尝试上限，不是所有错误原本都有 15 次。新的退避、Retry-After 和可重试 HTTP 状态由 SDK 决定；408/409 等状态也使用 SDK 的统一预算。**重试间隔与部分错误的尝试次数不再和旧组合完全相同，长时间失败时可能等待更久。** 本轮没有将其计为延迟收益，也未引入自写 SDK 退避复刻层；取消测试验证用户可以中止长 Retry-After 等待。

### 保留重依赖的具体依据

- 当前 PYZ 中 OpenAI/Anthropic/Google 模块的压缩字节约为 2.02/1.35/1.28 MiB。这些值不是删库后必然减少的安装包大小；Pydantic、Jiter、HTTPX 等由多方共享。尚无经过完整契约和四平台验证的替代实现，因此不以减少 SDK 名称数量换取协议缺失。
- curl_cffi 的 Chrome TLS impersonation 与普通 HTTPX 不等价；trafilatura/justext 的多语言主体、表格和代码提取仍有用途。本轮用实际裁剪、关闭响应和连接复用获取收益，没有将普通 get_text 当作等价替代。
- PyYAML 对 `yes`/`on` 默认得到 bool，对 `2026-09-17` 得到 date，对 `1.0` 得到 float，而现有两套解析器保留这些字符串。`001` 在 Team 中为字符串、网关中为整数；`null` 在 Team 中为 None、网关中为字符串；引号转义规则也不同。保持现有语义还需要定制 resolver/限制和业务校验，不能简单换成 safe_load 宣称净简化。

## 4. 回归证据

| 验证 | 结果 |
| --- | --- |
| Python 3.12.13 完整测试，最终 worker 代码 | **972 passed，1 skipped**，pytest 9 另报告 4 个 subtests passed |
| Python 3.13.2 完整测试 | **972 passed，1 skipped**；最后的 HTTP 关闭等待补丁另通过 32 项网页/worker/provider 测试 |
| 最终 Windows 冻结产物 | **6 项端到端测试通过**：Chat、Responses、Anthropic、Gemini、会话恢复和网页/代理流程 |
| 冻结版离线 tokenizer | Responses/Anthropic 流程阻断外部 HTTPS 下载，清除显式缓存覆盖，context board 的 user token 数与 cl100k_base 精确计数一致 |
| 冻结版网页 | 通过真实 HTTP 代理提取中文、英文、表格及代码；不是仅验证 `--version` |
| CLI Node 回归 | **407 passed、4 failed、1 skipped**；同样 4 个失败已在 `57cec27` 的原始前端复现 |
| 构建校验 | 哈希安装、pip check、manifest 校验、UTF-8 pip inspect、TOC/xref 和必要资源检查通过 |

Python skip 来自 Windows 环境无法创建测试符号链接。CLI 基线失败是 context board 的 3 项颜色断言及 tour 的旧 `Check the banner` 文案断言。本轮未改前端源码或这些断言，也不把该测试集报告为全绿。

尚未完成：Linux/macOS 三个平台的构建与运行、无 Python/pip 的干净机器安装、安装器/npm/Docker 体积、真实供应商/公网搜索抽样、SOCKS 专项冻结验证。现有 fake-server 与本机冻结测试不能替代这些发布门槛。

## 5. 复现及后续发布

会话和 rescue 基准脚本已保存到 `test/benchmarks/worker_slimming.py`。将基线 checkout/归档置于单独目录，在同一已安装应用依赖的 Python 3.12 环境中顺序运行：

```powershell
python test/benchmarks/worker_slimming.py <baseline-source> > baseline.json
python test/benchmarks/worker_slimming.py . > current.json
python -m pytest test/ -q
```

冻结版验证入口复用生产协议测试，无新增产品调试开关：

```powershell
python .docs/slimming-distribution/scripts/build_runtime.py --target windows-x64 --source .
$env:RIND_TEST_RUNTIME = (Resolve-Path .docs/slimming-distribution/artifacts/runtime/windows-x64/rind-runtime/rind-runtime.exe).Path
python -m pytest test/test_provider_e2e.py -q
```

构建要求 Python 3.12.13，且两仓库 tracked 内容已提交；锁文件更新命令见 distribution 的 `locks/README.md`。每次正式构建重新创建安装环境，复用下载缓存，不复用残留已安装包。

本机原始记录保存在忽略的 `.docs/`：`slimming-measure-*-final.json`、`slimming-tool-projection-rechecks.json`、`slimming-package-final.json`、`slimming-yaml-comparison.json`、`slimming-concurrent-start.json`、`slimming-tests-*-final.log`、`slimming-frozen-tests.log`。distribution 的 `artifacts/runtime/windows-x64/build-evidence/` 包含最终构建的输入 SHA、锁哈希、pip inspect 和 PyInstaller 清单。

发布顺序：先推送并审阅 distribution 的配套提交，再推送 Rind 分支；用 `Verify frozen Python worker` workflow 指定 distribution SHA 跑四平台，完成其余发布验收后再触发正式 release。验证 workflow 本身没有发布权限。
