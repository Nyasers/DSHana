---
name: dshana
description: "dshana App（把 DeepSeek Harness 接进 Hana 的受管子代理执行器）的使用、排错与工具手册。触发场景：提交/查询/取消 DSH 任务、应答审批（dshana action=open/reply/close/get/approve 任一动作前）、DSHana 卡显示未启动/启动中/需要处理（三态自举页）、DSH 起不来或启动超时、DSH 任务失败排查、默认模型怎么配、DSH Web UI 打不开、主题跟随宿主、DeepSeek Harness 相关。遇到 dshana 相关需求优先读本技能再动手。"
---

# dshana 使用、排错与工具手册

DSHana 把 DeepSeek Harness（DSH）作为**受管子代理执行器**接进 Hana：App 加载后自动拉起一个受管 Node runtime，里面跑 DSH web 服务；DSH 前端以**同文档注入**方式挂进 DSHana 卡（不是 iframe 内嵌）。DSH 依赖随 App 包物化，**运行时不需要安装任何东西**。

## 架构一句话

`apply(ctx)` 注册工具与路由 → 微任务触发 `ctx.runtime.start` 拉起受管 runtime → 壳页轮询 boot 状态 → 就绪后取 DSH index 注入当前页面。DSH 与宿主之间：指令走 runtime 控制面（`/_control` + loopback HTTP RPC），模型推理走宿主 `ctx.models`，凭据不进 DSH 进程。

## 首次安装（无需配置）

- **无需装依赖、无需配 Node**：DSH 及其依赖树随包分发在安装目录 `node_modules`，我们的子插件也落在那里（`node_modules/@dshana`）；启动只做 DSH boot + 服务监听，不写数据目录里的任何东西。
- **无需配 API Key / 模型**：推理经受管 runtime 内 `hana.models` 发起，provider 凭据留在宿主。DSH 自带的两个 LLM adapter 行（`llm-deepseek` / `llm-pi-ai`）在我们的 roster patch 里停掉，llm 路由只剩宿主目录那几条（那两行要凭据库里的 key，而凭据在宿主手里，它们只会摆出选到就报 `no API key` 的路由）；设置里那页「模型」也一并停掉（它只编辑这两行的 settings 段，停掉后没可编辑对象，只剩空壳）。会话的模型跟着「谁开的」走：工具建的会话按**调用方那张角色卡配的模型**开（`agents/<id>/config.yaml` 的 `models.chat`，经 `agent:list` / `agent:config` 读，见 `app/agents.read`）；App 设置页的「会话模型」可以改成「自定义模型」固定一条（`sessionModelProvider` / `sessionModelModel`，可选该模型支持的推理强度 `sessionModelReasoningEffort`；缺省是「复用调用方」）；DSH 自己那格默认模型（`agent-default-model`）本页不经手：你手设过、而已不在宿主目录里时，就地对账换一条可服务的（优先留在原 provider 里换，再退角色卡模型、目录第一条；日志有「默认模型对账」，见 `src/lib/model-default-guard.ts`）。
- **聊天流卡档位**（`sessionCardDisplay`，App 设置页「聊天流卡片」）：卡是一次会话一张、注入 DSH 会话的 iframe，reply 一发一张会在聊天流里叠起来。缺省 `open-only` = 一个会话只留一张（open 那张；卡页按 `?sid=` 跟踪整段会话，所以那张一直活着）；`all` = 每发一次挂一张（旧行为）；`never` = 一张也不挂——任务照跑、结果照投，只是没有那张句柄卡（看会话用 `get`）。
- **默认模型**：DSH 自己的 `agent-default-model`（`DSH_HOME/settings.yaml`）——用户层为空时回落到 base 层那份官方路由。界面里直接开的会话在 DSH 自己的模型选择器里选一条，候选就是宿主目录那几条；App 设置页只列候选给「会话模型」用，不经手这格。
- **目录选择器**：DSH 的 workspace 选择对话框由 `directory-picker` seam 提供，官方 web-app 层挂的 `directory-picker-auto` 在 win32 + loopback 下挑 native；native 的客户端半优先读页面里的 `__DSH_DIRECTORY_PICKER__`（官方桌面壳由 preload 注入、弹 Electron 对话框），没桥才叫宿主进程的 OS chooser——后者要在宿主进程里 spawn 一个子进程跑 `IFileOpenDialog`（koffi 走 COM，还先合成一次 Alt 抢前台），上游写明它只适合「操作者坐在宿主屏幕前」，而本形态的受管 runtime 是沙箱里的后台子进程，开不出来。壳页在注入 DSH index 前把桥装上（`src/ui/dsh-inject.ts` 的 `installDirectoryPickerBridge`），弹窗改由宿主出：`hana.resources.pick`，`mode=directory`。用户看到的是自己机器上的系统弹窗，选择器不经沙箱。
- **数据目录**：固定用 App 内置独立目录（App 数据目录下的 `.dsh`），开箱即用；共享已有目录 / 切换数据源暂不提供。
- `dshana(action="open")` 每次调用**必须显式传 `cwd`**；它必须是**已存在的绝对目录**（提交前校验，分两段：相对路径在 App 侧直接拒掉；「存在 / 是目录」由受管 runtime 的控制面动作 `cwd-check` 判——App 宿主半的 `node:fs` 只覆盖应用自己的目录，用它 stat 用户路径会一律失败，而那个失败与「目录不存在」分不开）。会话一旦建立，cwd 就是记录值，之后每次 spawn（命令、终端）都从它出发——别拿一次性 scratch 目录当会话根。

## DSHana 卡三态

壳页轮询 `GET /api/apps/dshana/routes/dshana/boot-state`，按 `phase` 渲染：

| 状态 | 表现 | 怎么办 |
|---|---|---|
| 未启动（idle） | 台面只有一行「DSH 未启动」 | 打开本卡会补一次启动请求；也可以等自动链 |
| 启动中（starting） | 细圆环 + 「正在启动 DSH…」 | 等即可（首次含 DSH boot） |
| 就绪（ready） | 页面装载 DSH Web UI | 直接用 |
| 需要处理（error / stopped） | 状态行 + 一块 `<pre>`（code / message / note / runtimeId / port） | 看 `<pre>` 定位；自动链按退避重试，端口占用自动换端口 |

**读状态的出口**：`boot-state`（壳页与 Agent 都用；含 phase/error/userText）。App 侧不再写文件日志——日志一律走宿主 `ctx.logger`，受管子进程输出由宿主运行日志捕获。

## 工具手册：`dshana(action, …)`

宿主 Agent 面**仅此一个工具**（一个插件一个同名工具，动作以顶层 `action` 区分），装配见 `src/tools/index.ts`，各动作见 `src/tools/actions/<action>.ts`，每个文件 = 一个同名操作。

语义对齐 subagent：`open` ≈ `subagent`（创建即带任务）、`reply` ≈ `subagent_reply`（按句柄续同一个）、`close` ≈ `subagent_close`（收工）；`get` / `list` / `approve` 是本项目特色（subagent 没有）。

推理经受管 runtime 内 `hana.models` 发起，消耗宿主 provider 额度，provider 凭据留在宿主。

### 参数契约

顶层 `action` 必填，每个子命令只认自己的字段（`oneOf` 分支 + `additionalProperties: false`，所以 `open` 的 schema 里没有 `approvalId`）。

| action | 必填 | 可选 | 语义 |
|---|---|---|---|
| `open` | task, cwd | label, timeout, agentPreset, reasoningEffort, provider, model | 开一个 DSH 子代理并交首件活（新建会话 + 立即提交首条 prompt） |
| `reply` | task | taskId 或 sessionId（二选一）, timeout, agentPreset, reasoningEffort, provider, model | 往同一个子代理续发消息 |
| `close` | 无 | taskId 或 sessionId（至少一个） | 取消正在跑的任务 |
| `get` | 无 | taskId 或 sessionId（至少一个） | 回看该会话最近一轮的最终结论 |
| `approve` | approvalId | outcome, taskId 或 sessionId | 应答挂起审批 |

> 查任务走宿主提供给 Agent 的内置任务查询工具（模型侧，本环境是 `check_pending_tasks`）：dshana 的 open/reply 建的就是本会话的后台任务，本来就出现在那份清单里，不需要本工具另开一扇只读门。

**句柄与凭证**：`taskId`（open/reply 返回）与 `approvalId` 是**句柄路径**，工具自己解析会话并按宿主记录的来源会话校验归属；`sessionId`（形如 `session-<uuid>`）是**凭证路径**，显式传入即视为"我要跨对话操作"，跳过归属校验。

### action=open：开一个子代理并交首件活

- **task + cwd 必填**；不允许传 `sessionId`（续会话用 `reply`）
- **固定异步**：立即返回 `{ content, details: { dsh: { action: "open", taskId, sessionId, rpcId, status: "running", delivery: "next-step", cwd }, card } }`（`card` 挂不挂按 App 设置「聊天流卡片」的档位，见《首次安装》；缺省 `open-only` 时 open 挂，`never` 时不挂）；任务在后台执行，完成/失败按回执里的 `delivery` 档投递回发起会话：结果在下一个输入点自动贴回，不必为等它结束回合（会话空闲时自动起新一轮）；要看过程或最终结论用 `get`
- **投递档位（回执里的 `delivery`）**：宿主不替作者默选档位，本 App 在 create 时显式声明，档位定死后 update 改不了。`next-step`（当前值）＝结果在下一个输入收集点贴回本会话，相当于 `session:send` 的 `steer`：不打断在途请求，也不要求模型结束回合专门等；`next-turn` 才是本回合结束后另起一轮（`followUp`）。回执里的值就是实际档位，别自行推断。
- **句柄**：返回值里的 `taskId` 就是后续 `reply` / `close` / `get` 用的句柄，优先用它
- `label` 是显示名（宿主任务列表与结果通知里可见），缺省按动作给默认前缀
- 提交链路：`ctx.tasks.create` → 受管 runtime 就绪 → `session.create` →（显式传 provider/model/effort 时才 `selectModel`）→ 绑定回写宿主任务记录（`ctx.tasks.update` 的 `metadata.dsh`，DSH 坐标的事实源）→ `session.prompt`（queue）→ runtime task-bridge 回投终态

### action=reply：续同一个子代理

- **task 必填**；目标二选一：`taskId`（句柄，默认推荐）或 `sessionId`（凭证，跨对话用）
- cwd 沿用会话已有值（持久非活跃会话自动 resume）
- 同会话多次 reply 由 App 侧串行化，按提交顺序排队，不并发

### action=close：取消正在跑的任务

- 目标二选一：`taskId`（句柄，默认）或 `sessionId`（凭证）
- 链路：通知 DSH `session.cancel`（中止模型流 / 工具 / 终端）→ 收敛为取消终态；只停本工作，不影响共享 runtime 上的其他会话
- **异步**：回执只说「已请求取消」，**不等确认窗口**（15s 窗口在后台走）；确认或超窗升级的证据随后台任务通知（投递回发起会话）与 App 日志落定。占着工具回调等确认会堵住宿主通道，多张卡同时取消时尤甚
- **取消打在哪个时刻，结局不同**：砸在“回合还没跑起来”（刚 open / 刚 reply）上，DSH 能确认中止（也常直接走上面那条异步回执）；砸在**回合已跑完**的任务上，没有可中止的在途物，宿主任务会被升级标记 canceled（正常语义：记录跟着最后一条命令走）
- **与 subagent_close 的差异**：DSH 会话是持久的、随时可 resume，没有实例槽位这回事，`close` 只取消当前活动任务，不“释放实例”
- 句柄反查不到（任务已被回收 / 宿主记录里的绑定已缺失）会**明确报错**，不会拿猜出来的会话继续操作

### action=get：回看某一轮最终结论

| | |
|---|---|
| 目标 | `taskId`（句柄）或 `sessionId`（凭证） |
| 取数 | `session/list` 定该会话读位点 `projections.asOfSeq` → `session/page` 在该 cut 上取尾部一窗 records |
| 口径 | **最后一次 user 消息之后、最后一次 assistant 输出**就是本轮结论（一次 open/reply = 一轮）；文本截断 ≤4000 |

会显式标注、不静默篡改的情形：本轮尚无输出（退到更早的最近结论）／窗口内无 user 消息／该轮被中断／**该轮以错误结束**（模型或工具报错时 DSH 只写 `attempt` + `turn/end`，这里把错误原因透出来）／还有更早轮次未读。

注：会话日志已是 V3 格式，**不再自读 `session_projcache.json` / `session.jsonl.zstd`**（格式演进交回官方）；DSH 未启动时 list/get 不可用。

### action=approve：应答挂起审批

- **approvalId 必填**（审批通知里带；同一任务可挂起多个审批，逐个应答）——它是唯一句柄，会话由工具解析（句柄路径会校验归属）；`sessionId` 仅在"我要跨对话"时显式传
- **outcome**：`allowed-once`（默认，放行本次）/ `rejected`（拒绝）
- **决策看 args（具体要执行什么），不听 reason（模型自述不可尽信）**：合理放行，危险拒绝。审批请求的 `label` 写作“工具名 + 具体操作 + 申请的权限档”，`details` 同源带 `operation` / `escalationMode` / `escalationNote` / `approvalTimeoutMs`
- **回合边界**：审批通知只在**回合边界**送达。`open`/`reply` 提交后要**结束本回合**，下一回合才会收到 `app-task-approval-requested`（含 `approvalId`）。在同一个回合里空等或连续重发，会撞上宿主工具回调的 30 秒上限（`RPC callback.tools.execute timed out after 30000ms`），而且该会话可能就此卡住（后续 `reply` 一律超时，`close` 也难得到 DSH 确认）；遇到这种会话换新的，不要原地重试
- 审批超时未应答按 `approvalTimeoutSec` 自动拒绝（本 App 缺省 30 秒；显式设 0 则禁用自动拒绝）。注意宿主自身的 `timeoutMs` 默认是 0（不禁用即不超时）——30 秒是 App 侧策略

### 典型用法

- 开活：`open`（新任务）或 `reply`（往已有子代理续；先 `get` 确认）
- 回看：`get`（最终结论）
- 止损：`close`；越界权限：`approve`（提交后先让出回合，审批通知下一回合才到）

`sessionId` 即访问凭证；`get` 的取数走受管 runtime 的官方查询面，不读会话文件、不发起推理，DSH 未启动时不可用。

## 改完源码之后（开发循环）

三件工具都在仓库里，别再造临时脚本：

| 要干什么 | 命令 |
|---|---|
| 把本地包装进宿主（卸载 → 提交 staging → 确认 → 等就绪，跨平台） | `pnpm run install:local -- --zip releases/<包>.zip` |
| 体检**装好的**那棵树（预检：依赖就位 + 定位 DSH + 产物在位） | `pnpm run smoke:packed -- --preflight` |
| 同上但不加 `--preflight`：完整 boot 到中继有应答 | `pnpm run smoke:packed` |
| 查宿主能力面：应用能调哪些 bus 动词、不能用哪些事件名（SDK 已发布契约）；某个字面在宿主 bundle 里出现在哪 | `pnpm run probe:host [-- --look models-changed]` |

升级 DSH 或重新装包之后先跑一次 `smoke:packed`：仓库树能过不等于装好的树能过（0.1.6 那次 profile-boot 就是只在装好的树里不合格——哈希产物被压缩，导出名全丢）。

## 主题

只有 DSH 主题偏好为 **system** 时跟随宿主配色（经 `@dshana/theme` 子插件注入）；在 DSH 内显式选 light/dark 时完全用 DSH 自己的主题，宿主配色不介入。
外观里这个选项的文案是**「跟随宿主」**（上游原文是「跟随系统」）——偏好值仍是 `system`，只是措辞按我们的形态改了，见 `src-integrations/ui-theme` 的覆盖层。

## 排错表

| 现象 | 原因 | 处理 |
|---|---|---|
| 卡在「启动中」很久 | 首次 boot 较慢（含插件就位与服务监听） | 等即可；持续不动看宿主日志与 `error.userText`（boot 快照不带日志尾） |
| 状态转「需要处理」 | runtime 启动失败 | 看 `error.userText` 与原始错误；日志定位 |
| 提示端口被占用 | 端口竞争 | 会自动换随机端口重试；持续失败看日志 |
| DSH Web UI 打不开但状态就绪 | 注入失败 / surface 票据缺失 | 重开卡；反复出现查中继前缀与 surface 授权 |
| `dshana` 报 runtime 未就绪 | DSH 还没起来 | 等就绪即可（工具首调会重新拉起）；持续失败看 boot 状态与宿主日志 |
| 改了宿主提供商/模型，DSH 里的候选没变 | DSH 侧的 provider 路由与模型目录是启动快照 | 正常路径由 `models-changed` 订阅经控制面触发重拉（不重启 runtime）；订阅面不可用时重启 runtime |
| 模型报 `no API key for provider route "deepseek-official"` | 官方自带的 LLM adapter 还在服务那条路由（本形态里它拿不到 key），说明 roster patch 没随包落地或被人改过 | 确认装好的树 `cordis.patch.yml` 里 `llm-deepseek` / `llm-pi-ai` 是 `disabled: true`，然后重启 DSH |
| 默认模型指向宿主没配的提供商/模型（你手设过的那个消失了） | 宿主换过提供商或删了凭据 | 不用手改：App 在 runtime 就绪与宿主模型变更后会对账，换成宿主目录里一条可服务的（日志有「默认模型对账」）；这格现在只由 DSH 自己与对账维护，App 设置页不再有它的入口 |
| 界面里直接开的会话报 `no API key for provider route "deepseek-official"` | `agent-default-model` 的 user 层为空，值落回 base 层那条官方路由（工具建的会话不受影响：它们按调用方角色卡开） | 在 DSH 自己的模型选择器里选一条可服务的（会话级；App 设置页不再有默认模型的入口） |
| 主题没跟随宿主 | DSH 主题偏好是 light/dark 而非 system | 在 DSH 外观里选「跟随宿主」（偏好值 system） |
| DSH 设置里找不到「模型」页 | 该页（`ui-settings-models`）随两个官方 LLM adapter 一起停掉——它只编辑那两行的 settings 段 | 不是故障：工具建会话用的模型在 App 设置页的「会话模型」里配，模型候选列的是宿主目录；DSH 侧会话在 DSH 自己的模型选择器里选 |
| 选工作区目录时弹一个错误 | 目录弹窗落到了 DSH 宿主进程的 OS chooser（要在沙箱里 spawn 子进程开 `IFileOpenDialog`），而本形态的 runtime 是后台子进程 | 正常路径不该走到那里：壳页注入的目录桥让弹窗由宿主出（`hana.resources.pick`）。若仍报错，确认桥装上了（`__DSH_DIRECTORY_PICKER__`）且宿主授予了资源选择 |
| 命令执行里找不到 `bash` 工具 | shell 行按平台互斥挂载：win32 停 `bash` / `bash-sandbox`，只挂 `pwsh` / `pwsh-sandbox` | 用 `pwsh` 工具跑命令（PowerShell）；读写文件仍走文件系统工具 |
| `reply` 连续 30 秒超时（`RPC callback.tools.execute`）/ 该会话后续提交全失败 | 上一轮的审批没能在回合边界被应答，宿主工具回调超时，会话卡住 | 不要原地重试：换新会话（`open`）；旧会话用 `close` 收敛（回执只说已请求取消，升级标记随后台落定） |
| `close` 回执只说「已请求取消」/ 会话流卡在会话结束后不再更新 | 正常语义：取消确认不进工具回调（后台结算）；流卡在会话终结后断消息流并拒绝重开（陈旧卡冻结） | 不用处理；要确认结局看 `get` 或任务通知 |
| 会话流卡停在「历史加载失败」/ `gateway/internal` | 该卡对应的宿主任务已终结，中继按闸门拒了它的流（正常：陈旧卡不再建流） | 不用处理；要看会话内容去主卡或 `get` |

## 已知限制

- **升级 DSH = 装新 App 包 + 重启宿主**：DSH 版本由 App 声明的依赖（`@deepseek-ai/dsh`）决定，产物版本段带上它；无独立升级通道。
- **壳页没有「启动 / 重启 DSH」的入口**：台面只报状态。拉起由 `apply` 后的自动链、工具首调、以及打开卡页时补的那一次请求承担，失败按退避重试（5s 起、封顶 5min）。要真正重启只能卸载重装或重启宿主。
- **拆窗、钉回、切页面都不停 DSH 后台**：只有卸载/重载 App 或退出 Hana，宿主才回收受管 runtime。
- **数据源固定为 App 内置独立目录**（`<dataDir>/.dsh`，即本形态的 `DSH_HOME`），不碰用户主目录的 `~/.dsh`；共享已有 DSH 目录 / 切换数据源的链未启用（`POST /dshana/settings/restart` 回 503）。
- **会话↔任务的绑定不落 App 文件**：事实源是宿主任务记录（`metadata.dsh` 的 sessionId / rpcId / timeoutSec / approvalTimeoutMs / cancel），读取失败一律 fail-closed。DSH 未启动时 `list` / `get` 不可用。
- **越界权限默认走审批，且只能在新回合被应答**：`open` / `reply` 提交后须结束本回合，审批通知（含 `approvalId`）下一回合才到；同回合内空等会撞上宿主工具回调的 30 秒上限，并可能卡住该会话。`approvalTimeoutSec` 内无人应答自动拒绝（缺省 30 秒；显式设 0 禁用）。DSH Web UI 里直接开的会话没有委派任务，审批请求没有应答者，按 fail-closed 处理。
- **会话流卡在会话终结后冻结**：宿主任务进终态那一刻起，该卡的流按终态收场并拒绝重开（陈旧卡成快照）；中继侧另有一道闸门，带票的流只在宿主任务活跃期建/留。主卡与 FP 不带会话票，不参与冻结与闸门。
- **模型分两条路**：工具建的会话按调用方角色卡配的模型开（App 设置可改成固定的自定义那条）；DSH Web UI 里直接开的会话用 DSH 自己的模型选择器选的那条，候选只来自宿主目录、且是启动快照——宿主改提供商后由 `models-changed` 订阅触发重拉，订阅面不可用时才需要重启 runtime。
