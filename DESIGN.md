# DSHana 设计

插件 id：`dshana`。把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）接进 Hana。

## 文档与注释约定

**注释写现状与原因，不写演变史。** 代码注释回答“现在是什么、为什么这样”；“以前是什么、怎么变成
今天这样”属于 commit 与 CHANGELOG（仓库用 conventional-changelog：`pnpm run changelog` +
`scripts/release/version.mts`，历史自动成文）。

- 不写日期栈记（“2026-xx-xx 定调”）、不写迁移步骤编号（“步骤 3 接线”）、不写“已退役/已删除”的注记。
- 保留现状事实（依赖怎样装、路径在哪、失败向哪侧回落）、保留设计取舍的**理由**。
- 指向本地未入库文档（`specs/`、`SPECS.md`）的引用不入注释与公开文档：规划件带隐私信息、不入库，
  引用只会指向克隆者拿不到的路径。

**覆盖层是别人的文件。** `integrations/*/files/**` 是官方 DSH 文件的整体覆盖，里面只允许两类
内容：上游原有注释，以及我们**无注释的代码改动**。我们自己的说明（为什么改、改了什么、与样例的
差异）一律写在同包的 `integration.json` 的 notes 里——那里是我们的文件，且漂移闸也读它。

理由：覆盖层越像上游，与上游重新对齐越容易，漂移闸的 diff 也越可读；注释里的“我们/样例/当时”
会把一份官方文件变成半自述文件，下次对齐时全是噪音。

## 工具链前提

Node 版本下界是 `^22.22.2 || ^24.15.0 || ^26.8.1`，五件事各管一职：

- `.nvmrc`（26.8.1）是实际使用的版本，也是宿主（Hana 宿主进程）的 Node 版本，26 线的下界即取它；
- `package.json` 的 `engines.node` 是唯一真源（机器可读声明）；
- `scripts/shared/root.mts` 加载时**从 `engines.node` 读范围**并断言版本，不满足即抛出可读错误，
  退出码 1（环境前提不满足，与“用户输入错误”的 2 分开）；主要入口都 import 它，这是真正拦得住的
  那一处（pnpm 对**根项目**的 engines 不做强制，实测即便 `--engine-strict` 也照常安装）；
- `scripts/check/engines.cjs`（`pnpm run check:engines`）扫依赖树报出各包的 `engines.node` 约束与
  多版本包，用来核对下界该取到哪：下界不得低于工具链自身声明的约束；
- `tests/build/node-version.test.mjs` 枚举 `package.json` 里所有以 TypeScript 直跑的入口，断言它们的
  import 闭包都触达 `shared/root.mts`——“新增入口忘了 import”这条只能靠它抦住。

下界的依据：三条线就是本仓已知的三条大版本，每条的下界不得低于依赖树里最严的那条约束。当前最严的
是 pnpm 自带包管理器引导层 `corepack` 的 `^22.22.2 || ^24.15.0 || >=26.0.0`——22 / 24 两线照抄它
的下界，26 线取 `.nvmrc` 的实际版本（`^26.8.1`，与宿主同步；`^` 不跨大版本，等于只承诺这三条线，
不预支 27+）。
类型剥离本身只要求 22.18 / 23.6（此前需要 `--experimental-strip-types`），低于依赖约束、不构成下界：
`scripts/**/*.mts` 与 `packages/app/src/build.ts` / `packages/app/src/cordis.ts` 都以 `node <file>` 直跑（`package.json`
的 scripts 都这么调），低于下界时这批脚本在运行期才炸，而 `scripts/check/type.mts` 只做静态检查、
管不到运行期。

范围的写法限定为 `^x.y.z` / `>=x.y.z` / `x.y.z` 并用 `||` 连接（见 `satisfiesNodeRange`）；
遇到别的写法它当场抛错、不静默放行，也不引入 semver 依赖（这条字符串是本仓自己维护的，为一个
自己写的声明引一个包不划算）。代价是放宽写法必须同时改解析器与测试，这一步是有意的：只改
`package.json` 一个字符串就悄悄换了语义，正是这个仓库一直在避免的那类漂移。`.nvmrc` 保持单行版本号：解析方
（`actions/setup-node` 的 `node-version-file`、各家 nvm 实现）不保证忽略注释，往里写说明有让
CI 直接失败的风险。`engines.node` 不参与 lockfile 解析，改这个区间不需要、也不应期待
`pnpm-lock.yaml` 变化。

## App 契约的派生

`manifest.json`（`packages/app/src/`，App 域的契约件）的两个字段都来自 derive，不手写：`version` 取主 `package.json`，
`minAppVersion` 取 `vendor/hana-app-sdk/source-manifest.json` 的 `packedVersion`（随包 SDK 快照
打包时的宿主版本，也就是 App 要求的最低宿主版本）。两者由**同一个** manifest 任务产出完整内容
（同文件两个任务会互相覆盖）。版本事实源都落在 `package.json`：主号归 `pnpm version`，`+dsh-…` 段归 derive 从 `packages/host/package.json` 声明的内核版本派生（根 `devDependencies` 里那份同名声明由 integrations 校验对拍，两处不得分家），manifest、cordis 与组合层子包的版本一律跟随，不手改。唯一不经过 `package.json` 的是 `minAppVersion`：它取自随包 SDK 快照自带的 `packedVersion`（该快照按哈希清单同步，且全仓只此一处读取，没有第二份拄本）。同步随包 SDK 由 `postsync:vendor:sdk` 钩子顺带刷这两处（`node scripts/derive/index.mts manifest thirdparty`，同步完就走，不必另记一歩），`derive --check` 是漂移闸。

## 架构总览（受管 runtime）

```text
Hana 宿主进程（App 隔离进程内加载 dist/bin/app.mjs）
  ├─ App 侧：apply(ctx)
  │    ├─ ctx.tools.register(dshana)                 工具（单工具 + subcommand，五动作）
  │    ├─ ctx.routes.register(/dshana/*)             壳页/诊断面（boot-state|health|settings|models|card-state|start|stop）
  │    └─ ctx.runtime.start({ runtime:"node", entry:"bin/dsh.mjs",
  │           cwd:ctx.dataDir, service:{ port:<随机>, readyMarker:"..." } })
  │              ↓ 受管 Node 子进程
  ├─ bin/dsh.mjs（dist/bin，rspack 产物，与 app 主体同一次构建）
  │    └─ 原生 import 安装目录 node_modules/@deepseek-ai/dsh/lib/profile-boot-*.js
  │         → runProfile() → cordis Context
  │              → 加载自有 profile $DSH_HOME/profiles/dshana（壳只建与初始化：层列初值 base → dsh-app，
  │                 之后归用户与插件管理面；启动期不另叠 overlay）
  │                   → dsh-* 官方插件 + @dshana/* 子插件（后者在安装目录 node_modules/@dshana）
  │         → HTTP 服务监听本地端口（宿主按 readyMarker 判定就绪）
  └─ 浏览器面：/api/apps/dshana/routes/_runtime/<runtimeId>/ 由宿主自动代理
```

- **受管 runtime**：DSH 跑在 `ctx.runtime.start` 拉起的独立 Node 子进程中。App 侧与子进程分责：App 管启动/停止/状态，子进程管 DSH 的 cordis 生命周期；崩溃可被父侧识别并重起。
- **依赖形态（自包含打包）**：DSH 及其依赖树由 `scripts/release/pack/index.mts` 在构建时物化进**安装目录** `node_modules`，运行时**不安装、不 spawn pnpm**。运行时依赖的唯一真源是 `packages/host/package.json` 的内核声明（交付面的清单与锁都由 pack 现生成，树里不留第二份；根那份只留构建面，另留一条同名 devDependencies 供开发侧安装，两处版本由 integrations 闸守）。
- **更新 = 装新 App 包**：装包那一次加载就把新实例接上（入口重新 import、工具与路由重登记、受管 runtime 随自动链重启）。**重载后已建立的会话照常可调**：工具面按宿主当前注册表解析，旧会话继续调 `dshana` 即可。
- **连接与鉴权交回官方**：组合层里的官方 connection（BrowserAuth token/cookie）与 frontend-static 各自负责其位，App 侧只经 runtime 中继补 cookie。
- **DSH Web UI**：DSH 前端以**同文档注入**方式挂进壳页（`dsh-inject.ts`：取 index → 搬 link/script → 装配 `__DSH_TRANSPORT__` + 流 mux）；到 runtime 的请求走宿主代理前缀 + 路径票据。流 mux 的失败按官方**跨 bundle 契约**打结构标记（页半与内核半类身份不通，DSH 只看标记不看 `instanceof`）：载体丢失 `kind:'carrier'`（DSH 侧按可重试的载体丢失处理，自动重连续流），宿主交付的逻辑失败 `kind:'remote'` + 域码（原样重建成带码的 RemoteError）。少了 carrier 标，一次断链会被折成 `gateway/internal` 终态，会话历史流不再自愈。

## 工具

宿主 Agent 工具面为**单工具 `dshana`**（一个插件一个同名工具 + CLI subcommand：装配 `packages/tools/src/index.ts`，各动作 `packages/tools/src/actions/<action>.ts`，提交链 `packages/session/src/session-run.ts`，取消/审批编排 `packages/session/src/cancel-chain.ts` / `packages/session/src/approve-respond.ts`）。语义对齐 subagent（open/reply/close），另有 get/approve 两个特色动作。**完整调用手册见 [dshana skill](skills/dshana/SKILL.md)**：

| action | 用途 | 实现 |
| --- | --- | --- |
| `open` / `reply` | 开子代理+交首件活 / 续已有子代理（task 必填；open 另需 cwd） | `packages/tools/src/actions/open.ts` / `packages/tools/src/actions/reply.ts` → `packages/session/src/session-run.ts` |
| `get` | 回看某一轮最终结论（官方 `session/list` + `session/page`） | `packages/tools/src/actions/get.ts` |
| `close` | 取消正在跑的任务（taskId 句柄或 sessionId 凭证） | `packages/tools/src/actions/close.ts` → `packages/session/src/cancel-chain.ts` |
| `approve` | 应答挂起审批（allowed-once/rejected，决策看 args） | `packages/tools/src/actions/approve.ts` → `packages/session/src/approve-respond.ts` |

> 会话靠句柄（宿主 taskId）定位，工具面不设“先列清单再操作”的入口：“查任务”由宿主提供给 Agent 的内置任务查询工具（模型侧，本环境是 `check_pending_tasks`）承担——dshana 的 open/reply 建的就是本会话的后台任务，本来就在那份清单里；`sourceId` / `cursor` 这类为其配套的字段一并不要。

调用模型：句柄默认（taskId/approvalId，按宿主记录的来源会话校验归属）、凭证显式（sessionId = 我要跨对话）。每个子命令的参数在 `parameters.oneOf` 里单独成支（`additionalProperties:false`）。

**参数是一份 zod schema 的三个投影**（`packages/tools/src/shared/fields.ts` 放跨 action 共享片段，各 action 在自己的 `fields` 里给专属字段，装配在 `packages/tools/src/index.ts`）：`z.toJSONSchema(…, { io: "input" })` 生成模型面 `parameters`，同一份 union 在分发前 `safeParse` 做运行期校验，derive 的 `skill-params` 任务再把同一份 `parameters` 投影成技能包的 `skills/dshana/references/parameters.md`（字段表，供按需阅读）。**宿主不校验工具入参**（装机宿主 bundle 里 `ajv` / `zod` / `safeParse` 各出现 0 次），校验责任全在本 App，这也是这几样必须同源的原因——手写 schema 与手写 if 判断是今天唯一的口子。校验失败抛一条带全部 issues（`path` / `code` / `message`，英文原文）的错误，不做字段整形：`run()` 里的取值与兜底逻辑仍接原始入参，行为不变。运行期 union 的每支比模型面多一个 `context`（`looseObject`，只声明我们真正读的 `sessionPath` / `callToken`，其余键放行——宿主注入的形状随通道变），**它不进 `parameters`**：模型不该看到也不该传。

技能参照的生成形状取自 DSH 的 PTC 模式（`@deepseek-ai/dsh-tools` 的 `jsonSchemaToTs` + `renderToolsSdk`：前者把一个 schema 节点投影成类型文本，后者确定性装配成进系统提示词的 SDK 段），区别是读者：那边是模型直读的 SDK，这边是技能包里的参照文件，由 SKILL.md 指过去按需读。**只投影 schema 表达得了的东西**：跨字段约束（`reply` 目标二选一、`close`/`get` 至少一个、`open` 不收 `sessionId`）不是 JSON Schema 能表达的（`discriminatedUnion` 的分支只能是普通 `ZodObject`，挂 refine 会在构造时抛错），仍手写在 SKILL.md 正文——边界划在可推导性上。

提交链路：`ctx.tasks.create` → 受管 runtime 就绪 → `session.create` →（显式传 provider/model/effort 时才 `selectModel`）→ 绑定回写宿主任务记录（`ctx.tasks.update(taskId, { metadata: { dsh: {…} } })`，见 `packages/shared/src/task-binding.ts`）→ `session.prompt`（queue）→ runtime task-bridge 把任务状态与终态回投。

## DSH Web UI（DSHana 卡）

DSHana 以**单卡 + 自带功能面板**注册（manifest `contributes.cards[0]`：卡 id `dshana`、route `/main.html`、`functionPanel.route` = `/sidebar.html`；`siteNavEntry` 为本项目有意保留的形态差异）：

- **自举台**：DSHANA 字标 + 细圆环 + 一行状态小字；报错时下方直接一块 `<pre>`（时间线/折叠详情已撤）。boot-state 由**主卡单独轮询**，FP 只读跨面共享快照（订阅，不重复取）；owner 不在场（快照不存在/下线/过旧）时 FP 才自取。
- **三态 + 设置页**：default（full / detached 共用一页 = 整幅 DSH UI，顶部 44px 让位宿主 chrome）/ main（主卡，无 DSH 侧栏——侧栏归 FP）/ sidebar（FP，只有侧栏）；settings 是 App 自己的设置页（`ui.route`，不注入 DSH）。面由**页面静态声明**（`<meta name="hana-dshana-role">` + `data-dshana-view`）；映射到 DSH 侧上游角色词：default→standalone / sidebar→navigation / main→workspace。
- **注入鉴权**：壳页以 `appSurfaceSession` 作为 `_surface` 路径段取得运行时代理凭据（同源预请求种 `hana_app_runtime` cookie 兜住子请求）；未取得票据时不下挂内容，面板上说明原因。装配只做一次（本文档里 DSH 前端实例、它的载体与监听都绑在这唯一一次装配上），而中继前缀里含 runtimeId：宿主重启或运行体重建之后这份前缀就是死端点（宿主对它的 WS 升级当场断开，DSH 的流载体连试两次后折成 `gateway/internal`，界面停在「历史加载失败」）。重载是唯一干净的出路——旧实例在文档里还活着，就地重注入会留下两套。故壳页在**取到的新快照说 `runtimeId` 与装配时不同**时重载本页；判断放在取到快照之后，凭据本已失效的页面不会去重载（那只会撞上宿主的 403），照旧停在凭据缺失的提示上。
- **会话卡（`ui/stream.html`）的一张卡两个挂载态**：工具回执的 `details.card` 指向这一页（App 不为它声明 manifest 卡），`open` 与 `reply` 都挂（`act=` 区分）。卡面抬头固定 `DSHana`；钉住的 DSH 会话 id 来自查询串（`?sid=`，工具出卡时写进 route）；没带 `sid` 时跟随跨面共用的当前选中。页自己认挂载态（宿主契约见 APPS_EN.md「Mount-mode table」）：**聊天流**里 `hana.envelope` 的 height 是 `flexible`，此时只画入口行（1 行抬头 + 3 行坐标，坐标由 `stream.html` 的内联脚本在求值时写就，不排在任何握手后面；卡声明的 `aspectRatio` 是这一面的**高度下界**（取宽扁一档 `32:1`），入口行按内容把真实高度报给宿主 `hana.ui.resize`，但上报值低于比例算出的高度时以比例为准——所以把这一行压薄的杠杆是比例，不是上报），不装配中继、不注入；**取出到黑板 / 拆窗**后 height 是 `fixed`，此时才装配中继、注入完整 DSH 现场。两态各自的 DOM 按需实例化（`stream.html` 的 `<template>` + `stream-entry.ts` 的按需装载），认到哪个态才建哪块，不靠 `hidden` / `display` 藏一个留一个；重型半（React 三态 + dsh-inject + host-theme，`stream-stage.tsx`）是 `import()` 出来的独立 chunk，聊天流态的卡永不解析它。**跟踪态只在聊天流态**：`stream-entry.ts` 把 `GET /dshana/card-state` 的片段放进小标题行（只在 `tracked` / `cancelling` 期间慢轮询 4s，终态即停手），detail 不占版面、进悬停提示；取出的卡不带任何 App 状态行（那面就是那段会话本身），并保留输入卡：在那里打的字进的是这个 DSH 会话自己的一轮，不走 dshana 工具链。**终态之后不断流**：这段会话多半是用户主动打开来翻看的历史会话，断掉或拒绝重开就等于看不了。主卡与 FP 不带 `sid`，不挂跟踪态。
- **承载面分片（`api/remote.mux`）**：宿主对 App 受管服务的 WS 中继有 1 MiB **上游帧**上限（上游 ws 客户端 `maxPayload: 1024 * 1024`，超限即把下游连接 `close(1011, "Managed service stopped")`），而 DSH 的 mux 帧是原子 JSON——长会话打开时的首帧就是整段历史 snapshot，一帧就能超，DSH 又只立刻重试一次（两次都撞上限就折成 `gateway/internal` 终态），于是历史流永远打不开。分片点必须在宿主**之前**，而本 App 的运行时中继与页面载体正好夹在这条管子的两侧、都是本仓库代码（DSH 协议两端一行不改）：中继把超限消息按尺寸切成二进制分片（信封与上限见 `packages/shared/src/mux-chunks.ts`），载体在页面侧**先拼字节再解码**、重组回一条完整消息交给 DSH。每片回一次执，中继只在 768 KiB 窗口内在途——宿主另有一条「转发下一帧前下游缓冲超 1 MiB 就掐」的守卫（同样报 1011），而且它判的是**线上字节**（一片 128 KiB 载荷在线上是 131,088 字节），所以窗口取 768 KiB（6 片 = 线上 786,528），给 live 帧与 ping 留 256 KiB；只把帧切小不够，发得快一样致命，尤其远端访问时页面排空更慢。开关显式：载体在 mux URL 上带 `dshanaMuxChunks=1` 声明（宿主只滤掉凭据类查询参数，其余原样转发），中继只在看到它时才启用帧搬运（`packages/host/src/mux-relay.ts`），否则保持原来的原始 socket 双向透传——旧文档与新中继不会互相看不懂。帧搬运只认 WS 帧头：未改动的帧原样转发（控制帧立即转，DSH 的 mux ping 不会被大消息卡住，pong 由宿主的 ws 客户端负责），只有超限消息被重写成分片；窗口用尽只是等回执，不断链。

### 设置面

- **App 设置页**：`contributes.settings.ui.route`，宿主设置区渲染，不依赖 DSH 运行。三项：常规（审批超时 / 任务超时，App 自持存储）+ 会话模型模式 + 主题（强制跟随宿主主题的面，逐面一个开关，缺省只有侧栏面）。模型候选读 `GET /dshana/models`，后端取**宿主模型目录**（`ctx.models.list`，能力面 `app/models.infer`）——宿主目录是「这条路走不走得通」的唯一事实源，页面因此不列 DSH 自己的目录，DSH 在不在跑都一样（`packages/models/src/model-catalog-view.ts` 归一化、按 provider 归组并附推理档）。主题那组的候选面与缺省来自 `packages/shared/src/face-theme.ts`（声明单点），页面只补人话标签。
- **取出到黑板**：会话卡在聊天流里点右上角菜单 / 拖拽**取出**（纯宿主手势，不经 App 代码）——宿主把这张聊天卡（连 aspectRatio / cardForm）钉到黑板 / 拆窗上，本页那时才认到 `fixed` 挂载态并注入 DSH 现场。App 不声明卡、不调 `hana.cards.open`，因此卡片中心不占一格；会话历史归 DSH 自己的侧边栏（打开 DSH UI 即可翻看），App 不另存清单。
- **会话模型从哪来**：App 设置项 `sessionModelMode` 决定——`caller`（缺省，跟着调用方走）或 `custom`（`sessionModelProvider` / `sessionModelModel` / `sessionModelReasoningEffort` 固定一条，推理强度空串 = 不指定、由 DSH 决定）。优先级：工具入参显式 > App 自定义那条 > **调用方会话当前实际在用的**（用宿主任务记录的 `parentSessionId` 寻址，读宿主 `session:context` 的 `model` + `thinkingLevel`；调用方会话不属于本 App，故 `scope: "all"` + 能力面 `app/sessions.read`）。寻址用 id 而非 path：`session:context` 的归属判定走会话 manifest，只认 `sessionId` / `legacySessionPath`，而工具面递过来的只有 `context.sessionPath`（一条路径）；任务记录里的 `parentSessionId` 就是那个稳定 id，不用另找。读会话而不是读角色卡：角色卡是静态配置，会话是实际在用的（会话开跑后用户可能在会话里换过模型，那份变更只记在会话自己的事件流里）；会话读不到（或它用的那条不在宿主目录里）就不补——不换别的来源充数，跟随调用方是这一模式的实义。**DSH 自己的默认模型（`agent-default-model` 段）不参与本优先级**：那是 DSH 侧的全局选择，属另一面，本 App 不经手也不据它改主意。显式入参的 `provider` 与 `model` 是**一条路由的两半**，只接受成对给（缺任一半即拒，不去别处补另一半）。模型选择按**元组语义**合并：请求给的那部分覆盖，没给的那部分沿用当前值（`reasoningEffort` 单独给就是「只改强度」；换路由本身允许，代价是丢上下文缓存，所以一般不推荐）。create 的缺省路由由上面的优先级算出，reply 的缺省路由沿用会话当前那条（读 `session/list` 投影的 `modelSelection.next`）。选出的那条**随会话请求带上**（集成层给 `session/create` 与 `session/prompt` 加了可选 `model` 字段，见 `integrations/api-session-controller`）：只在会话内生效，不写 DSH 的全局默认；只在 create 上补，send 沿用会话已有的选择。见 `packages/models/src/caller-model.ts`（决策）、`agent-models.ts`（读角色卡，默认模型对账在用）、`host-models.ts`（宿主目录）。
- **DSH 自己的默认模型**（`agent-default-model`）：本页不经手它，也不在 config.json 存副本。它的用户层有值、而已不在宿主目录里时，`packages/models/src/model-default-guard.ts` 在 runtime 就绪与宿主 `models-changed` 之后就地对账换一条可服务的（优先留在原 provider 里换，再退角色卡模型、目录第一条）；用户层为空不动手——本形态里界面直接开的会话在 DSH 自己的模型选择器里选一条。**读写都经 DSH 自己的 settings 服务**（`packages/models/src/model-settings.ts`）：`settings.yaml` 在本版 DSH 里已不存在（settings 服务启动时整份迁进 profile 并把文档改名为 `settings.yaml.imported`，见上游 `settings/settings` 的 `importLegacyDocument`），所以任何对该文件的读都不再是这条路的事实源。

### 目录选择器

DSH 的 workspace 选择对话框来自 `directory-picker` seam（宿主半列目录或开系统弹窗，客户端半渲染）。组合层（派生自官方 web-app）挂的是 `dsh-host-directory-picker-auto`，它按启动时采样的一把宿主事实（bindHost / ssh / platform / DISPLAY）挑后端，win32 + loopback 必落 native。native 的客户端半优先读页面里的 `__DSH_DIRECTORY_PICKER__`（官方桌面壳由 preload 注入、弹 Electron 对话框），没桥才回落到宿主进程的 OS chooser——后者要在宿主进程里 spawn 一个子进程跑 `IFileOpenDialog`（koffi 走 COM，还先合成一次 Alt 把弹窗抢到前台），上游写明它只适合「操作者坐在宿主屏幕前」。本形态的受管 runtime 是沙箱里的后台子进程，那条回落路开不出来，客户端就把异常交给 owner 的 `onError`，表现成每次选目录弹一个错误。

壳页因此自己提供桥：在注入 DSH index 之前装 `__DSH_DIRECTORY_PICKER__`（`packages/ui/src/dsh-inject.ts` 的 `installDirectoryPickerBridge`），`pick()` 调宿主的 `hana.resources.pick({ mode: 'directory' })`。弹窗由宿主出、在用户自己的机器上，既不经沙箱，也不依赖 DSH 自己的桌面壳；roster 层不动，native 那一对照挂，只是其中宿主半永远不会被调到。

## 主题跟随

`@dshana/dsh-theme` 经 `tapIndex` 注入 index 响应：静态 fallback + 动态桥脚本，向壳页索取宿主主题 vars → 写 body 层覆盖 `--dsw-alias-*` / `--dsw-specific-*`。覆盖**按面分两档力度、选择器形状只有一种**（`html body` / `html body[data-ds-dark-theme]` 两条同声明规则）：**强制面带 `!important`**——那一面的跟随是强制的，任何元素级/属性级请求都不得改写它；**其余面不带**——靠 `html body` / `html body[data-ds-dark-theme]` 的特异性赢过 DSH 自己那张调色板（DSH 在 `body` 与 `body[data-ds-dark-theme]` 上同格声明、且晚于本桥注入），同时让位给按属性收窄的请求。桥落地时把壳页垫的内联底色一并抹掉（内联只有 `!important` 压得住，留着就把非强制面那条让位堵死；强制面那侧反正压得住，但垫片一律在桥落地时抹掉）。
**哪些面是强制面可配置**（设置页「主题」区块，逐面一个开关，缺省只有侧栏面）：这张表住在 `packages/shared/src/face-theme.ts`（声明单点，缺省 `FORCE_FOLLOW_FACES`、可选面 `FORCE_FOLLOW_CANDIDATES`），存在 `dataDir/settings.json` 的 `forceFollowFaces`，壳页经 `GET /dshana/settings` 取回后编码成 `<html>` 的 `data-dshana-force-follow`（逗号分隔面名），桥读它判强制面。绕 DOM 一圈是因为桥是 cordis 侧散装分发的浏览器 JS（无 import、ES5 风格），引不到本仓库的模块；同文档注入后它与壳页在同一个文档里。**属性缺席**（老页面 / 设置还没拉到）按缺省名单兜底，与**空串**（显式一个都不强制）是两回事。桥里的面名字面量只剩缺省名单那一处，其余一律从属性读（回归闸 `tests/cordis/theme-bridge-backdrop.test.mjs` 守着，否则「哪些面强制跟随」就有了第二个事实源）。改完设置即时生效：宿主 App 存储没有订阅口，设置页保存后在同源广播频道（`FORCE_FOLLOW_CHANNEL`）发一条，已开的壳页与会话卡收到就重读一次；可见性与焦点只当兜底（旧宿主没有 `BroadcastChannel`、以及同文档内切页的情形）。

**App 页面这一侧要自己贴样式表，而且分两段**：宿主把主题参数附在 App surface iframe 的 URL 上（`hana-theme` / `hana-css` / `hana-theme-appearance`），变化时再推 `hana.theme.changed`；但把样式表贴进页面这件事宿主不代劳，而 SDK 只在收到 `hana.theme.changed` 时才应用 `cssUrl`——页面不自己贴首帧，就会一路吃 HTML 里写死的纸张 fallback，直到第一次主题变化才跟上。

- **首帧（第一次绘制之前）**：五个页面（`main` / `default` / `sidebar` / `settings` / `stream.html`）在 `<head>` 内各带一段**逐字相同**的内联片段（标记注释 `dshana:first-frame-theme`），位置固定在所有静态 `<link rel="stylesheet">` 之后、模块脚本之前。它同步读 URL 参数、把 `data-theme` / `data-appearance` 写到 `<html>`、append 一张 `<link>`（`<link>` 阻塞首次绘制，所以第一帧就是宿主配色）。**贴哪张样式表分三档**（规则与 `host-theme.ts` 的 `themeCssUrlFor` 同源，两侧各半）：① 宿主给了 `hana-css` 就直接用；② 没给 `hana-css` 但有 `hana-theme` 就拼 `/api/apps/theme.css?theme=<encodeURIComponent(id)>`——**FP（`slot=function-panel`）的 surface URL 只带 `hana-theme` / `hana-theme-appearance`、不带 `hana-css`，所以这是 FP 的主路径，不是罕见回退**；③ 两者都没有就**不贴**——裸 `/api/apps/theme.css`（不带 `theme`）返回的是**默认主题暖纸**，贴它等于贴一张概率上错的主题表，猜出来的颜色比不画更糟（官方口径：a failed swap keeps the current theme rather than falling back to a built-in palette），宁可留白让页面回落到自己 CSS 里的兜底色。`/api/apps/theme.css` 是宿主自己的公开路由，不是本 App 的资源。回归闸 `tests/ui/first-frame-theme.test.mjs` 锁住「五个页面都带、逐字相同、位置正确、三档 URL 规则（真跑一遍片段取它贴的 href）与模块侧逐条同源」——以后新增页面忘了贴、或谁把裸回退加回来，都会被挡住。
- **快照与订阅（此后）**：`packages/ui/src/host-theme.ts` 首屏读一次 SDK 快照（兜住内联片段因故没跑的页面），此后按 `hana.theme.changed` 事件驱动地贴样式表（壳页 / 设置页 / 会话卡共用一份）；贴哪张同样走 `themeCssUrlFor`（主题未知时它给空串，本模块也不贴）。内联片段把已贴的 URL 记在 `<html>` 的 `data-hana-theme-css` 上，本模块据此跳过同一 URL 的重复 fetch（主题 CSS 可达 47KB）；**片段没贴时那条属性不写**，本模块读回空串、与任何非空 URL 都比不上，因此不会误判「已贴过」。两侧契约各半，同样被上面那条测试锁住。
- **注入前的首帧底色垫片按面取，面必须在垫片之前就定下来**：壳页在注入 DSH 之前先往 `body` 写一层 DSW 底色 token（`packages/ui/src/seed-tokens.ts`，写内联 style、不加 `!important`：赢过 DSH 自己的静态样式表，桥落地时被桥抹掉），值按**这一面可见底**那格取宿主变量——中列面是 `--bg`，**侧栏面（FP）是 `--sidebar-bg`**，两者不同源。垫片的第一次执行挂在顶层 `followHostTheme` 的 `onApplied` 上，而完整的面判据（含宿主 slot 兜底）要到 `begin()` 才拿得到：因此面的初值必须取**页面自己的静态声明**（`meta[name=hana-dshana-role]`，模块脚本是 deferred、此刻 DOM 已解析完），`begin()` 拿到完整判据后不一致再重垫一次。若在这里写死 `default`，未就绪的 FP（停在「未启动」/「已停止」，走不到注入）就会整页垫成中列色——真机实测过那一帧 `bodyInlineBg=rgb(59,74,84)`（青夜 `--bg`）而该是 `#34424B`（`--sidebar-bg`）。回归闸在 `tests/cordis/theme-bridge-backdrop.test.mjs`。

**跟随语义（有意自持）**：仅当 DSH 主题偏好为 `system` 时跟随宿主配色；显式 `light`/`dark` 时完全用 DSH 自己的主题，宿主配色不介入。**例外是强制面（缺省只有侧栏面 FP）：它恒跟随宿主**——整幅嵌在宿主框架里，用 DSH 自己的明暗会与四周不同调；这一面同时是**强制面**：它的覆盖一律带 `!important`，元素级/属性级请求改写不了它。强制面名单与恒跟随是同一件事的两面（在名单里 ⇒ 恒跟随 + 带 `!important`），见上一段。壳页把认出来的面写在 `<html>` 的 `data-dshana-face` 上（与 `data-dshana-backdrop` 同源、都取 `seedView`），桥读它比对面名；面词表仍只有 `packages/ui/src/face-role.ts` 那一处。偏好变更经事件驱动重读（不再周期轮询）。此语义与官方样例的「无条件双 palette 替换」不同，是保留项。

## 启动与状态

- **启动触发**：App `apply` 完成后经微任务触发一次 `ensureManagedRuntime`（single-flight，不占 apply 同步栈——宿主对 apply 有 60s bootstrap 超时）；`dshana` 首调与 `POST /dshana/start` 是可重入的兜底入口。
- **就绪判定**：宿主 `ctx.runtime.get(runtimeId).state === "ready"`，配合子进程末行 `readyMarker`。
- **失败面**：`managed-runtime.ts` 的 `START_ERROR_HINTS` 按 code（port-busy / port-unreachable / boot-failed / deps / seed / not-authorized / unknown）给英文指引，随 boot-state 的 `error.userText` 出到壳页 action 态。

## 已知限制

- **更新 = 装新 App 包**：DSH 随包物化在安装目录，换包即换内核；装包这一步就把新实例接上。受管 runtime 每次启动都是新子进程，DSH 在宿主进程内不驻留，宿主模块缓存无需从插件侧豁免。
- **Windows 上的命令执行是 `pwsh`**：base 组合按平台互斥挂载 shell 行（`tool-bash` / `bash-sandbox` 在 win32 停，`tool-pwsh` / `pwsh-sandbox` 只在 win32 开），派给子代理的命令按 PowerShell 写；文件读写仍走文件系统工具。
- **主题仅在 DSH 偏好为 system 时跟随宿主**（见上，有意为之）。
- 越界权限请求默认走审批：deferred 通知 → `dshana(action="approve")` 应答；无人应答按 `approvalTimeoutSec` 自动拒绝。


## 架构决策与落地（接口基线＝随包 SDK 快照）

DSHana 就是「Hana App v2（隔离 App 进程 + `apply(ctx)`）」。本节按子系统记述当前形态与取舍的理由。

**manifest / apply 入口 / 设置 / 工具注册：**

- `manifest.json`（`packages/app/src/`，App 域；derive 写回，构建拷进交付根）是 App v2 契约：`version` 由 derive 取主 `package.json`，`minAppVersion` 取随包 SDK 快照的 `packedVersion`；capabilities 十二项（tools / tasks / session / models / agents.read / sessions.read / resources / runtime 三项 / ui 两项，清单见文件）。
- 顶层 `network` 声明 `{ allowedHosts: ["127.0.0.1"], methods: ["GET","POST"], allowLocalhost: true, defaultTimeoutMs: 60000, maxResponseBytes: 8388608 }`：App 进程在 Node Permission Model 下没有 `--allow-net`，唯一出网面是宿主的 `ctx.network.fetch`，这条声明覆盖的是到受管 runtime DSH web 服务的 loopback RPC 通道。宿主校验只认这五键（别名 `hosts` 被拒）；`127.0.0.1` 属私网且走 http 而非 https，缺 `allowLocalhost: true` 必被拒（核对记录见 `packages/runtime/src/managed-runtime.ts` 头注释与 manifest 注释）。
- `packages/app/src/app.ts` 导出 `apply(ctx)`（兼导出 `default { apply }`）；apply 注册完即返回。统一日志只走宿主 `ctx.logger`；运行包是 `packages/runtime/src/app-runtime.ts` 的 module-scope 单例。
- 工具注册：`ctx.tools.register`，工具名 `dshana`（一个插件一个同名工具 + subcommand；v2 不自动加 `pluginId_` 前缀、重名被宿主当场拒）。动作五个：`open` / `reply` / `get` / `close` / `approve`，装配见 `packages/tools/src/index.ts`、手册见 `skills/dshana/SKILL.md`。
- 设置：`contributes.settings` 的 UI 由 App 自绘设置页承担（`ui.route: /settings.html`，宿主设置区渲染）；键与缺省以 `packages/runtime/src/config.ts` 为准，读写落 `dataDir/settings.json`（旧 `config.json` 只在两键缺位时作读侧兼容）。
- 数据读路径在 `ctx.dataDir`（宿主 `app-data/<id>/`）：list/get 读当前源的 `<DSH_HOME>/...`（projcache + jsonl zstd）；旧插件数据迁移见 `packages/runtime/src/legacy-migrate.ts` 与 `scripts/migrate/legacy.mts`。
- 构建：`node packages/app/src/build.ts` 产物 `dist/` = App 安装目录形态（根只放宿主读的契约件与目录：`manifest.json` + `icon.png` + `skills/` + `ui/`；代码全在 `bin/`：入口 `app.mjs`（manifest.entry 直接指它）+ runtime `dsh.mjs`）。App 契约件 `manifest.json` 与身份图标都在 App 域（`packages/app/src/`），随包 `skills/` 在仓库根，主体也在 `packages/app/src/`；卡面图归 ui 域（`packages/ui/src/face.png` → 产物 `ui/face.png`，face.image 是 ui/ 相对路径，随 ui 整树产出）。源位映射收在 `scripts/shared/contract-assets.mts`（构建摆位、投稿条目与派生同步共用一份）。壳的文档侧另出 `.cache/ui/`（`node packages/ui/src/build.ts`），App 域构建整树拷进 `ui/`。cordis 子插件包另出 `.cache/cordis/`（`node packages/app/src/cordis.ts`）：它们不是安装态里的东西，出包时由 pack 落进包内 `node_modules/@dshana`。
- 两个入口一次 rspack 构建（主体 `bin/app.mjs`（= manifest.entry）/ 受管 runtime `bin/dsh.mjs`），入口即主 bundle；先清 `dist` 再写入，壳的文档侧不在本域编译而是从 `.cache/ui/` 拷进交付目录 `ui/`（缺件即拒），随后统一做 URL 回写 / terser / 断言。

**受管 Node runtime（local-machine/external + readyMarker 就绪门）：**

- 受管 runtime 入口 `bin/dsh.mjs`（源码 `packages/host/src/main.ts`，与 app 主体同一次 rspack 构建 → `dist/bin/dsh.mjs`，见 `packages/app/src/rspack.config.mts`）：App 自有配置解析（唯一 argv = 私有运行时配置文件路径，schema 见 `packages/host/src/options.ts`，与 `packages/runtime/src/managed-runtime.ts buildRuntimeConfig()` 对偶）→ `connectAppRuntime()`（无父 IPC fd → 可操作报错 + 退出码 3，不假装能跑）→ 进程级 env（`DSH_HOME=<dataDir>/.dsh`、`DSHANA_HOME=<dataDir>`，不改宿主进程环境）→ 依赖随包就位（安装目录 `node_modules`，无运行时安装）→ profile 种子化（`initProfile` + `node_modules/@dshana` scope 链接 → installDir `cordis/`，junction/拷贝回退）→ 动态定位 DSH（`locate.ts`，profile-boot/app-boot，webpackIgnore 原生 import）→ `runProfile`（profile dshana、配置中的 dshPort、`--no-open`）→ **就绪门**（webServer 服务端口 === 期望端口 且 HTTP 探测成功）→ stdout 打 `readyMarker`（唯一出口；失败路径绝不打印 READY）→ SIGTERM/SIGINT/父断连有序释放（关 DSH fiber → 再 `hana.close()`；拿到流式响应不能立刻 close）。退出码契约：2=usage/3=IPC 不可用/4=deps/5=seed/6=boot/7=port。
- App 侧封装 `packages/runtime/src/managed-runtime.ts`：`ensureManagedRuntime()`（单例 single-flight：**一个 App runtime 服务多个 DSH 会话**，首次 create 触发启动——设计见模块头注释与 tools/actions 的提交链）父进程随机选取中继端口与 DSH 内部端口（区间 38000..52000，见 `choosePort`/`pickPorts`；宿主 service 端口契约只收确定整数，故不能交给宿主分配）→ `ctx.runtime.start({ runtime:"node", entry:"bin/dsh.mjs", profile:"local-machine", network:"external", cwd:dataDir, service:{ port:中继端口, readyMarker:带随机 opaque }, args:[私有配置文件路径] })`（契约禁止 readRoots/writeRoots/callToken/taskId，故一律不带）→ `ctx.runtime.get` 轮询到 ready（不能把 runtimeId 当就绪；端口占用 port-busy 自动换随机端口重试，上限 3 次）→ 失败归类（`err.code`：port-busy/deps/seed/boot-failed/not-authorized/timeout/unknown，message 带用户指引）+ runtime watch 日志尽力镜像（src=dsht 进 App 会话日志）；每次命中 ready 缓存先经 runtime.get 探活，子进程崩溃/被宿主回收则清单例并重起；失败路径把端口与两把 key 归零（`bridgeAccess()` 不再放出死端口）；`disposeManagedRuntime()`/`stopManagedRuntime()`（App 卸载/更新前停 runtime，Windows .node 锁纪律）；`choosePort`/`pickPorts`/`makeReadyMarker`/`classifyRuntimeFailure` 纯函数可单测。
- `packages/tools/src/actions/*.ts` 接 `packages/session/src/session-run.ts`（open/reply 提交链）、`packages/session/src/cancel-chain.ts`（close 取消链）与 `packages/session/src/approve-respond.ts`（approve 应答）；`get` 走官方 `session/list` + `session/page` 取最近一轮结论（不读 projcache，也不解 jsonl zstd——格式演进交回官方），要求 runtime 就绪。`packages/app/src/app.ts` disposer 接 disposeManagedRuntime。

**依赖部署：随包物化（自包含打包）**

- **形态：DSH 依赖树在打包时逐目标物化进 zip 根 `node_modules/`，运行时零安装（不 spawn pnpm）。** 受管 runtime 的 `depsRoot` 默认 = 安装目录 `<installRoot>/node_modules`，`--deps-root` 可覆盖（调试）。
- 物化方式（`scripts/release/pack/materialize.mts` + `index.mts`）：逐目标（`package.json` 的 `package:<target>` 脚本 → `pack/targets.mts` 目标表）在 `.cache/pkg-root/<target>/` 隔离工位跑一次干净安装；工位是一个独立项目——三件都现生成（工位清单 + 以仓库锁文件为种子重解析出的锁 + 按目标替换过 supportedArchitectures 的 `pnpm-workspace.yaml`），先 `pnpm install --lockfile-only` 再 `pnpm install --prod --frozen-lockfile`，交付面的生产闭包由此落进工位根 `node_modules`，得只含该平台资产的 hoisted 树（顶层真实目录、无软链接——软链进 zip 跨机解压即断），`node_modules` 下的点号条目（`.bin` / `.pnpm` / `.pnpm-workspace-state-v1.json` 这类 pnpm 账本）排除后拷入包根。
- 为什么随包而不在运行时安装：① App 安装目录在运行时只读（App 进程 fs-write 白名单只有 dataDir），`pnpm install` 无处落盘；② native 产物（node-pty/koffi/sharp 等）按平台/ABI 区分，逐平台出包才能各带各的 addon；③ 只物化生产闭包（不含 devDeps），体量可控。
- 版本单一事实源 = `packages/host/package.json` 的 `@deepseek-ai/dsh`（交付面的清单与锁由 pack 从它现生成；根 `devDependencies` 里那条同名声明须与它一致，闸守）；无独立 DSH 升级通道，升级 dsh = 装新 App 包。
- 定位：`bin/dsh.mjs` 在 depsRoot 下经显式路径解析 DSH（`packages/host/src/locate.ts`，`createRequire` + `.pnpm` 枚举 + `webpackIgnore` 原生 import）；profile boot 的模块回退 farm（dsh-app-boot `healProfilesModuleFallback`，把 dsh 安装闭包镜像成 `$DSH_HOME/profiles/node_modules` 链接）覆盖官方插件树解析。
- `@dshana/*` 子插件随包落在安装目录 `node_modules/@dshana`（与 `@deepseek-ai/*` 同锚点）——DSH 的 runtime 解析模式从安装树 + bundle 依赖图算解析代、**不建任何链接**；组合（roster 行、对官方行的取值、`@dshana/*` insert）不住在仓库根，而在组合层包 `packages/dsh/app`（派生自上游 web-app，逐文件上游 sha256 见 provenance.json）：随包落在安装树 `node_modules/@dshana/dsh-app`，由 profile 的层列选中（`dsh-base → dsh-app`），启动期不另传 overlay，也不写 DSH_HOME 里的任何东西。
- Windows native 文件锁：依赖变更即整包替换，替换前必须先停占用 `.node` 的 DSH 进程/worker/终端——受管形态下 DSH 只跑在单例 runtime，App 卸载/更新/停止统一先 `ctx.runtime.stop`。

**provider adapter（DSH 推理走 hana.models）+ 任务回投与工具循环：**

- **决策 A（App → 受管 runtime 指令通道）= runtime service loopback HTTP RPC，复用同一套信封/翻译器协议**（`packages/shared/src/rpc-envelope.ts` 纯函数：client-request 信封 + session.* 的 request/_request 包装 + requestId 注入；DSH 网关校验 body.method === 端点路径段（斜杠形态，official rpc-host 同款）；响应 rpcId 回显 + result.ok）。**不用** 宿主 `/api/apps/<appId>/routes/_runtime/<runtimeId>/` 代理：那是浏览器 surface（HttpOnly cookie + surface 授权 + WS upgrade）的 UI 通道，App 进程没有 cookie 会话面，且受管 runtime 无 getService 之类 App 门（hostCall 白名单只有 tasks/models/network）。App 侧 fetch 经 `ctx.network.fetch`（唯一出网面，宿主代执行），服务端 = 子进程 DSH web `/api` 原生端点（零新增 server 面）。
- **决策 B（provider adapter 分界）**：模型推理在受管子进程内经 `connectAppRuntime().models` 发起；requestId 由 adapter 自管（`models.cancel(requestId)` 定向）；身份按宿主任务记录的 `metadata.dsh` 判三态（`packages/dsh/provider/lib/identity.ts` 的 `resolveSessionIdentity` 经 runtime 挂的绑定索引读；索引缺位报 `BINDING_UNAVAILABLE`，见 `packages/shared/src/task-binding.ts`）——无绑定（用户在 DSH Web UI 自建会话）或绑定指向的任务已终结（委派任务收尾后用户接着在 Web UI 跑）⇒ App 身份（callToken/taskId 都不传）；绑定在且任务活动 ⇒ 传 `taskId`（宿主校验属主）；绑定读不出 ⇒ 报错 `TASK_MAP_BROKEN`（不降级成 App 身份，否则活着的任务会静默丢绑定）。stream 不接受 scope（那是 models.utility 的参数）。provider/model 显式选择：目录 = `hana.models.list()` 投影，provider/model id 原样透传（宿主逐条 `n.provider===provider && n.id===model` 匹配），不做二次命名。`@dshana/dsh-provider` 是自实现 LlmAdapter（`dsh-llm` 动态 import，按 profiles 基座解析）：`listModels`/`resolveModel` 读目录快照；`stream()` 把 DSH Message 转换（user/assistant/toolResult + 回放签名，`lib/messages.ts`）→ `hana.models.stream({requestId, ...身份, provider, model, messages, systemPrompt, tools, reasoningEffort?, maxTokens?, temperature?})` → NDJSON 逐行解析（跨 chunk 半行余量，`lib/ndjson.ts`；**HTTP 非 2xx 先报状态+响应体**，不吞成 `STREAM_CLOSED`）→ 事件处理（start/text-delta/reasoning-delta/tool-call/done/error）；`error` = 失败不算成功；`done.assistant` 完整保存回放（textSignature/signature/thoughtSignature 续接签名进 `ReplayEnvelope{kind:hana}`，DSH assistant source.replayState）并原样产块（block-start/delta/block-end/usage/finish，工具 arguments 为 JSON 字符串）；流未以 `done` 结束 → `STREAM_CLOSED`；图片走 base64 + MIME（attachment store `readImageRequest`，不传路径/URL；store 缺失报 `UNSUPPORTED_CONTENT`）。DSH 自己的工具循环不变（Hana 不执行传入的 tools schema，仅声明）；工具执行后把 `role:toolResult` + toolCallId/toolName/content/isError 放回 messages（`lib/messages.ts` 拆分）。hana client 句柄 = `globalThis.__dshanaHana`（`bin/dsh.mjs` 在 connectAppRuntime 后、runProfile 前设置，与子插件同进程共享；释放顺序：停 task-bridge → ctx dispose → 清句柄 → `hana.close`，`main.ts` 实现）。
- **模型请求字段校验与限额（宿主 `app/models.infer`；口径按装机宿主实测）**：宿主 `models.stream` 只认字段白名单（11 键：`requestId`/`provider`/`model`/`messages`/`systemPrompt`/`tools`/`reasoningEffort`/`maxTokens`/`temperature`/`callToken`/`taskId`）加逐字段形状：`requestId`/`provider` 为 1-128 ASCII id；`model` 非空、去空白非空、≤128 字符、无控制字符（不限 ASCII，多段斜杠 id 可过）；`messages` 非空数组、`tools` 数组；`systemPrompt` 与每处 text/reasoning 为非空字符串；`temperature` 有限数 ∈[0,2]；`reasoningEffort` 必须在宿主按 `thinkingLevels` 归一出的档位内（归一表把 `xhigh` 映到 `max`、丢弃 `minimal`，故 `xhigh` 只在 `thinkingLevels` 同时含 `xhigh` 与 `max` 时才算数），越界报 `APP_MODEL_UNSUPPORTED_REASONING`。**投影的 `thinkingLevels` 就是 stream 校验读的那一份**（同一个归一函数），所以两份 `supportedEfforts`（`packages/dsh/provider/lib/catalog.ts` 与 `packages/models/src/model-catalog-view.ts`）都只按它取档、**不按 `xhigh === true` 单独补 `xhigh`**——那面旗只表示归一档含 `max`，不等于宿主接受 `xhigh` 这个词；按旗补档会在 DSH 模型选择器里多出一个选下去就被宿主拒的档。**消息条数、工具条数与单字段长度没有固定上限**，只受整体请求预算约束（与宿主文档 APPS_EN.md §Model inference 同口径）。限额默认值：`maxConcurrentStreams: 8`、`maxRequestBytes: 32e6`、`maxImageBytes: 1e7`、`maxEventBytes: 4e6`、`maxTokens: 65536`、`timeoutMs: 10 * 6e4`（单请求 10 分钟），宿主构造 App 模型服务时按 `{...默认, ...limits}` 合并，而本 App 的构造点不注入 `limits`，即恒用默认。并发上限按 App 计、跨会话共享（stream 与 utility 同一张在途表），单 runtime 服务多会话时同时在跑的模型流上限是 8。`maxTokens` 的闸取 **`模型 published 上限 ?? limits.maxTokens`**：声明了 published 的模型以 published 为上限（实例：384000），没声明的才回落到 65536。adapter 的取法：超过 `HOST_MAX_OUTPUT_TOKENS`(65536) → **不传该字段**（收敛到 65536 等于把输出悄悄砍到 64k，而不传则把上限交回模型/供应商默认）；未超该阈值但超该模型 published 上限 → 按模型上限收敛（模型自身硬限）；非正整数 → 不发字段。目录投影 `resolveModel` 声明模型真实 `maxTokens`（不夹宿主闸），DSH 因此看到真实能力。temperature 越界收敛到 [0,2]。收敛提示按 provider/model 去重一次，不逐次刷屏。
- **open/reply 业务链**（`packages/session/src/session-run.ts` submitDshTask → `packages/tools/src/actions/open.ts` / `reply.ts`）：execute（含宿主 `context.callToken`）→ `ctx.tasks.create({callToken, label, metadata})`（callToken 只此一次消费，不落盘不落日志）→ `ensureManagedRuntime({taskId})`（未起则启动到 ready，失败归类 err.code 并 fail(taskId)）→ 会话建立（create=`session.create{cwd, agentPreset?}`；send=先 `session.list` 查持久会话（带 cwd）则 `session.create` resume，活跃 Map 会话直接 prompt，list 不含 = 不存在由 prompt admission 报 `session/not-found`）→ 显式 provider/model/effort 才 `session/selectModel`（model-unavailable 降级不带 effort 重试）→ 绑定回写宿主任务记录（先于 prompt）→ `session.prompt` fire（mode:queue, content:[{type:text}], requestId=rpcId）。返回 `{ promise, ready }`：ready 在 prompt accepted 后 resolve 定位键 `{action, sessionId, rpcId, taskId, cwd}`（execute 随即返回）；promise 后台等 Hana task 终态（child task-bridge complete/fail → 宿主 deferred:resolve/fail 投递来源会话）并释放同会话串行化锁。
- **task-bridge（受管 runtime 内，`packages/host/src/task-bridge.ts`）**：DSH boot 就绪后、readyMarker 前挂载，`ctx.on` 订阅 api-session/status|error|activity + session/event（进程内直订——turn 生命周期不经 $events）；按宿主任务记录的 `metadata.dsh.sessionId`（App 提交前写入；本进程 hana.tasks 直读，见 `packages/shared/src/task-binding.ts`）把事件回投：running 进度 `ctx.tasks.update`、终态 `complete(taskId, minimal 定位结果)` / `fail(taskId, message)`。事件按 sessionId 路由到唯一当前任务，天然隔离多会话（决策 C/D）。终态判定：api-session/status false / session/event turn/end（reason.kind=error → 失败；completed → 成功，pendingFailure 兜底判失败）；先到先收、幂等；终态后失效绑定索引缓存。
- **决策 C（绑定事实源 = 宿主任务记录）**：taskId ↔ dshSessionId ↔ rpcId 与协调字段（cancel 等）都落在宿主任务记录的 `metadata.dsh`（`packages/shared/src/task-binding.ts`；写入方一律给全量 dsh 对象——`tasks.update` 的 metadata 合并语义宿主契约没写死）。受管 runtime 子进程的 hana client 本来就有 `tasks.list/get/update`（`AppRuntimeTasksV2`），直接读同一份记录：`createTaskBindingIndex` 用 `tasks.list()` 建 sessionId → 任务索引 + 进程内短 TTL 缓存（模型请求热路径不每请求往返宿主），句柄解析/取消标记/终态判定走 `fresh` 直读；runtime 把索引挂到 `globalThis.__dshanaTaskBindings` 供 cordis 子插件 `@dshana/dsh-provider` 的身份判定读（两 bundle 同进程不能互相 import）。任务记录的终结/取消状态由宿主 `status` 承担，不另造结束标记。64KiB 任务 JSON 限制由宿主门强制——metadata/result 只放小定位键。callToken 不落盘不落日志。
- **决策 D（并发纪律）**：同 DSH session 的 create/send 由 App 进程内串行化（`packages/session/src/session-serialize.ts`；锁持有到任务终态——否则同一 session 两个任务会互吃对方的终态事件/映射）；不同 session 互不共享「当前任务」（绑定按 `metadata.dsh.sessionId` 归属）；一个 runtime 服务多会话时各请求自带 taskId（`models.stream.taskId`、task 记录 taskId、prompt 信封 rpcId 作 `jsonl data.source.rpcId` 关联键）。
- **工具接线**：open/reply → `submitDshTask`（fire 即回、终态投递来源会话、内容走 `action=get`）；close → `packages/session/src/cancel-chain.ts`；approve → `packages/session/src/approve-respond.ts`；get 走 `session/list` + `session/page`。
- 端口不设设置项：父进程在区间内随机选端口 + 占用则换端口重试，用户不需要配置端口。

**取消 / 超时 / 审批（决策 E–J）：**

- **决策 E（取消链分侧与顺序 = App 发起 RPC、DSH 真中止后宿主才 canceled）**：App 主进程（`packages/tools/src/actions/close.ts` / session-run 超时看门狗）经 loopback HTTP RPC 直调 DSH web `/api/session/cancel`（`lib/dsh-rpc.ts` rpcSessionCancel + rpc-envelope 复用——与 create/send 同一条指令面），并先写取消标记（宿主任务记录的 `metadata.dsh.cancel`）。受管 runtime task-bridge 在 DSH `turn/end(aborted)`（或自然终态但已有 cancel 标记）时把宿主任务结算成 `hana.tasks.cancel`——**canceled 只在 DSH 真中止后标记**（不能宿主标 canceled 而 DSH 还在跑）。宿主侧取消反向触发（Hana task canceled/aborted，来源会话停止按钮等）= task-bridge 对 running 任务经 `hana.tasks.watch(taskId)` SSE 观察，取消到达 → 本进程 DSH `session.cancel` + `cancelSessionModelRequests`（只停本会话 requestId；单例 runtime 不误停他人会话）。取消确认窗口（App 侧 `CANCEL_CONFIRM_MS=15s` 轮询 `tasks.get`）超窗未确认 → 升级 `ctx.tasks.cancel` 兜底并如实告知（残余风险：DSH 进程若真未响应，宿主已 canceled）。**窗口只在后台结算里走**：工具路径（requestCancel）写标记 + 发 RPC 后立即返回，终态结算丢后台；把 15s 等待放进工具回调就是占着宿主回调（多张卡同时取消会堵住宿主通道，SKILL 里那条 30s 回调上限就是这么撞的）。执行超时看门狗（cancelSessionWork）本就在后台，才等满窗口求收尾判断。
- **决策 F（watch SSE 消费侧 = 受管 runtime 子进程）**：需要「宿主审批 outcome → DSH approval/request 等待者」与「宿主 task 取消 → DSH session.cancel」的都是 runtime 内模块（approval-bridge / task-bridge）；App 主进程不消费 SSE（应答走 `ctx.tasks.respondApproval` 的返回值即权威，取消终态用轮询 `tasks.get`）。故 watch-SSE 解析/对账（`packages/shared/src/watch-sse.ts`）打进受管 runtime bundle（`packages/host/src` 与它同图内联），消费处只有子进程。SSE 与 NDJSON 分开解析：`models.stream` 是逐行 NDJSON（provider `lib/ndjson.ts`）；watch 是 `event:`/`data:` 多行块（createSseDecoder），snapshot 首条 + app-task 后续 + reset（缓冲溢出）与断线都要先 `get()` 对账（runWatchReconcile）。
- **决策 G（审批分侧 = runtime 创建与等待、App 应答）**：DSH 审批请求（sandbox 升级 `approval/policy=ask`）→ ApprovalService 走 `ctx.waterfall(scopeTarget(agent), 'approval/request')`——approval-bridge 以 `ctx.on('approval/request', …, { global: true, prepend: true })` 认领（无 scope 的 ctx.on 因 context filter 收不到 agent-scope 瀑布事件）。有绑定（dshana 发起的会话，见 `packages/shared/src/task-binding.ts`）→ `hana.tasks.requestApproval({taskId, label, details:{dshSessionId,rpcId,toolName,callId,reason,args}, timeoutMs})`（以父 taskId 为范围，不需 callToken；timeoutMs 快照随 `metadata.dsh` 下传，0=宿主不自动拒绝）→ 挂起 ApprovalOutcome 承诺 `watch(approvalId)` 等终态：allowed-once/rejected 原样投给该 approvalId 的 DSH 等待者（承诺闭包天然定向，不广播）；终态无 outcome（父任务结束/撤销/审批超时）→ rejected（fail closed，绝不隐式放行）。App 侧 `dshana(action=approve)` = `approve-respond.ts` 经宿主审批记录的 parentTaskId → 父任务 `metadata.dsh.sessionId` 校验归属（记录无 outcome 才允许应答）→ `ctx.tasks.respondApproval({approvalId,outcome})` → runtime watch 观察 outcome 投递给 DSH。DSH 请求侧 abort（回合取消）→ 宿主审批收尾应答 rejected（不留孤儿）+ resolve 'cancelled'（取消绝不当授权）。审批等待不计入执行超时：超时 cancel 链会让 `req.signal` 中止走此路径；宿主审批由 timeoutMs 独立自动拒绝。
- **决策 H（协调字段随宿主任务记录）**：timeoutSec/approvalTimeoutMs（提交快照，跨进程下传 App settings）、`cancel{at,reason}`（取消标记）都落在 `metadata.dsh`，写入方读-改-写全量 metadata（`dshMetadataFor`）；审批不另存清单——宿主审批记录（`approvalId`/`parentTaskId`/`outcome`）就是唯一决策事实源。DSH 侧事件单飞 + App 同会话串行化使并发写窗口极小；读取失败一律 fail-closed。callToken 依旧绝不落盘。
- **决策 I（执行超时 = 走 cancel 链，不是只 fail task）**：session-run 提交后台 `waitTaskTerminalWithTimeout`：timeoutSec（显式参数或 App defaultTimeoutSec，非法/0 回落到同一缺省 1800）超时 → `cancelSessionWork(reason='timeout')`（标记 + session.cancel + 确认窗口）→ DSH 真中止后宿主 canceled。审批等待期间不触发（DSH turn 未结束 + 宿主审批 timeoutMs 独立拒绝；DSH 回合中止经由 abort 信号路径）。
- **决策 J（活动模型 requestId 注册表 = globalThis，跨 bundle 共享）**：provider adapter 流开始把 requestId 记入 `globalThis.__dshanaActiveModelRequests`（Map&lt;sessionId,Set&gt;），流收尾注销；task-bridge 取消时按会话定向 `hana.models.cancel`（`lib/model-requests.ts` 只读消费）。provider（cordis bundle）与 task-bridge（dsh-host bundle）不能互相 import——globalThis 约定（与 `__dshanaHana` 同款），键名两侧字面一致。

**实现落点：**

- `packages/shared/src/task-binding.ts`：绑定归一 + 索引/TTL 缓存 + 取消标记写入（宿主任务记录）。
- `packages/shared/src/watch-sse.ts`：SSE 解码/帧解释（snapshot/app-task/reset/结构兜底）、终态判定、审批 outcome 映射（fail-closed）、`runWatchReconcile`（先 get 对账、reset/断线重连退避）。
- `packages/shared/src/dsh-rpc.ts` 与 `packages/runtime/src/service-base.ts`：注入式 `/api` RPC（App `ctx.network.fetch` 与 runtime Node fetch 共用）；`rpcSessionCancel` + `cancelAccepted`。
- `packages/session/src/cancel-chain.ts`：cancel 编排（planCancel / executeCancel / awaitCancelTerminal / cancelSessionWork）、任务与审批超时解析（App settings 注入）。
- `packages/session/src/approve-respond.ts`：dshana approve 应答（归属校验 + respondApproval + 回填）。
- `packages/host/src/model-requests.ts`：活动 requestId 注册表消费侧（运行时 bundle）。
- `packages/host/src/approval-bridge.ts`：DSH approval/request global+prepend 认领 → requestApproval → watch(approvalId) 对账 → outcome 只投正确等待者；tool-call 缓存供 args 证据；signal abort → 宿主 rejected 收尾 + DSH 'cancelled'。
- `packages/host/src/task-bridge.ts`：cancel 标记结算（DSH 中止后 canceled）；宿主任务 watch 反向 cancel（session.cancel + 定向 models.cancel，只本会话）；settle 幂等。
- `packages/host/src/main.ts`：挂 approval-bridge；task-bridge 传 serviceBaseUrl；shutdown 停两桥。
- `packages/dsh/provider/index.ts`：活动模型流注册/注销（globalThis 注册表）。

**宿主契约要点（在宿主 bundle 与 SDK 上核过）：**

- **受管服务代理 = 宿主自动暴露，App routes 不需要转发**：宿主 bundle 含 `const Uee = "hana_app_runtime"`、`u1e(appId, runtimeId) = /api/apps/<appId>/routes/_runtime/<runtimeId>/` 与代理 express 路由 `/apps/:appId/routes/_runtime/:runtimeId/*`：请求带 `upgrade: websocket` 走 upgradeWebSocket 转发（二进制/文本帧，缓冲上限 1MB），其余方法按 runtime 记录端口 fetch 到 `127.0.0.1:<port>`（重定向 Location 重写回代理前缀；剥离 authorization/cookie/host 等请求头；strip `appSurfaceSession`/iframe ticket/agentId 查询参）。首次携带 `?appSurfaceSession=` 或 `X-Hana-App-Surface-Session` 的响应会 Set-Cookie `hana_app_runtime=<surfaceToken>; Path=/api/apps/<id>/routes/_runtime/<rid>/; HttpOnly; SameSite=Strict` 供后续子请求。因此本 App 的 `ctx.routes` **只做壳页/诊断面**；DSH Web UI/API/SSE/WS 一律指向该前缀。
- **`ctx.routes.register`**：单 bundle 只能 register 一次；registrar 收到 Hono sub-app（`register(registrar:(app)=>unknown)`，可返回 Promise 由宿主 await 后发布）；公开 URL `/api/apps/<appId>/routes/<subpath>`，鉴权 app_route（宿主登录或本 App surface 会话）。处理函数在 App 进程内执行（与 `ctx.tools.execute` 同生命周期，共享 App 运行包/受管 runtime 单例——路由模块直接调 `packages/runtime/src/managed-runtime.ts` 是本设计前提）。
- **ui/ 静态树**：宿主 `GET/HEAD /apps/:appId/ui/*` 直接服务 App 安装目录 `ui/` 子树（防目录逃逸；scoped surface 路径 `/api/apps/<appId>/ui/_surface/<sessionToken>/...` 由 iframe-ticket 端点下发 uiBasePath——页面相对资源在此 base 下继承授权）。App 自身 ui/ 页面资源一律相对路径；face 映射 `/api/apps/<appId>/ui/<image>`。唯一例外是首帧主题片段里的宿主主题路由 `/api/apps/theme.css`（见「主题跟随」）：那是**宿主路由**（公开、无需凭据，`packages/ui/src/dsh-inject.ts` 的 `HOST_PATH_PREFIXES` 也把 `/api/apps/` 划为宿主前缀），不是本 App 自己的资源。
- **contributes.cards v2 字段白名单**：`id/title/description/route/embedUrl/cardForm/titlebar/realization/pageOf/siteNavEntry/fpFullPanel/functionPanel/face/formFactors`——`realization:"page"` 与 `siteNavEntry`、`pageOf` 均可用。route 值 = ui/ 相对路径（须对应真实文件，宿主按文件名服务，无扩展名推断）。

**路由与卡：**

- `packages/tools/src/routes/dshana-routes.ts` 是壳页/诊断面的唯一 registrar：`GET /dshana/boot-state`、`GET /dshana/health`、`GET /dshana/settings`、`POST /dshana/settings`（revision 不匹配回 409、值非法回 400，带来源字段一律 400）、`GET /dshana/models`、`GET /dshana/card-state`、`POST /dshana/start`（fire-and-forget，202 即回，壳页轮询跟进）、`POST /dshana/stop`。数据源切换链（`packages/runtime/src/source-switch.ts`）未在真机验证过，`POST /dshana/settings/restart` 因此只回 503 `SWITCH_DISABLED`（实现原地保留，不碰任何状态——它第一步就会停掉正在跑的 runtime，半成品被误触发代价太大）。依赖注入（getSnapshot / start / stop）可单测；`packages/app/src/app.ts` 的 apply 用 `defaultDshanaRouteDeps(ctx)` 接真实实现（读 managedRuntimeDetails）。`ctx.routes.register` 缺失（宿主过旧）→ warn 降级（DSH 仅 `dshana` 工具可用）；registrar 抛错 → 抬高中止 App 加载（显式失败优于静默残缺）；disposer 注销。
- `packages/runtime/src/boot-state.ts`：归一化快照 `{phase,ready,runtimeId,proxyPrefix,service,error,note,updatedAt}` 与 `runtimeProxyPrefix()`（前缀宿主契约单点）。**ready 门**：`service.state === ready` 才给 proxyPrefix（绝不因 runtimeId 存在就展示端点——宿主在 readyMarker 后才发布服务）。阶段文案覆盖 idle/starting/ready/error/stopped。
- manifest 单卡：id `dshana`（route `/main.html`，`realization:"page"` + `siteNavEntry` + `fpFullPanel`，`cardForm:"flush"`，`titlebar:"solid"`，`closable:false`，`detached.route` = `/default.html`），同卡 `functionPanel` `{ id: "sidebar", label: "DSHana", route: "/sidebar.html" }`——FP 由主卡自带（宿主 route 形态），不用 `pageOf` 同伴卡。
- 壳页按 boot-state 的 phase 渲染（免交互，无手动启动按钮）：idle（只报状态；打开卡页补一次 `POST /dshana/start`）、starting（轮询 boot-state，台面只有 loader + 状态行）、error / stopped（错误码 + 可读指引，装在一块 `<pre>` 里）、ready（同文档注入 DSH index，请求走宿主代理前缀）。**DSH UI 的 SPA base 适配**（资源/API/WS 前缀）宿主不代做，由 App 侧承担。

**ui/ 静态树与页面：**

- `packages/ui/src/{main.html, sidebar.html, app.ts}`（build:ui 出 `.cache/ui`，build:app 整树拷到 `dist/ui/`）：页面同层相对引用（`./app.js`），无根路径绝对 URL；appId/路由前缀由页面 location.pathname 推导（`/api/apps/<appId>/...` 段），不硬编码整 URL。壳页轮询 boot-state、POST start/stop；主题桥（同文档）best-effort。剪贴板由 `packages/ui/src/clipboard-shadow.ts` 在壳页层 shadow `navigator.clipboard.writeText`（注入 DSH 之前装，是全局最早的一层）：**桥优先**（`__DSHANA__.clipboardWrite` → 宿主能力 `app/ui/clipboard-write`），原生只作桥缺席/桥拒绝时的回落——嵌入场景里原生必然先被 Permissions-Policy 关死，若先试原生则每次复制都先撞一次已关的门。`write(items)` 也盖（宿主能力只有 writeText 一个词，只能取 ClipboardItem 的 text/plain；只有图像/富文本的 item 明确失败，不假装成功），`readText`/`read` 不盖（宿主没有对应的读能力词）。

**旧插件数据迁移：**

- `packages/runtime/src/legacy-migrate.ts`（纯 node 内置）+ `scripts/migrate/legacy.mts` CLI：`--check`（默认，只读计划）/`--apply`/`--force`/`--source|--hanako-home`/`--target`（缺省取 `DSHANA_LEGACY_HOME`/`DSHANA_DATA_DIR`）。流程 = 备份（目标数据区 `migration-backup/`，**已存在不覆盖唯一备份**）→ 复制 `dsh-home/{sessions,storages,settings.yaml,.anonymous-user-id}` 与 logs、config.json（参考拷贝 `legacy-config.json` + 设置建议输出；不代写宿主 preferences）→ 校验（会话数 / workspace.json 可解析 / marker 落位，`verifyMigration`）→ 幂等标记 `dataDir/dshana/migrated.json` `{source,at,stats,backupDir}`。**profiles/ 不迁移**（v2 的 profile 由壳自己建并维护：`<DSH_HOME>/profiles/dshana` 的层列钉在壳里，见 `packages/host/src/main.ts`；旧数据里那份同名目录不从源复制，也不替它清理）；`node_modules/.node` 不迁移（App 依赖随包物化在安装目录）。源只读不删（回退材料 = 旧插件数据原地保留）；`--apply` 打印停机指引（先停旧插件写入）。Windows：`path.join` 原生分隔符、junction 在跳过列表、reparse 不进复制。

**打包与版本线：**

- 版本线为单一 1.x 线（开发期停在最后已发布基线、发版经 `pnpm version` 推进、DSH 跟随策略）；cordis 子插件包与组合层包 `@dshana/dsh-app` **等值跟随**主版本（无独立版本线）；build metadata（`+dsh-<dsh 依赖>`）由 version 钩子发版时统一拼回再同步。版本线语义见 `scripts/shared/version.mts` 头注释。
- pack（`scripts/release/pack/index.mts`）：静态项补 THIRD_PARTY_NOTICES.md；cordis 产物断言按清单校验（名单派生自包现场 `packages/dsh/*/cordis.config.mjs`，不另写一份：加一个子插件自动纳入，下线一个不留永久失败的断言）；ui/ 静态树断言（route 资源 fail-closed）；zip 根级 = `manifest.json` + `bin/`（`app.mjs` / `dsh.mjs`）+ `icon.png` + `skills/` + `ui/` + `NOTICE`/`THIRD_PARTY_NOTICES.md` + 物化的 `node_modules/`（不带 package.json：入口以 `.mjs` 定 ESM）。

**子插件与组合层：**

| 包 | 职责 | 说明 |
|---|---|---|
| `@dshana/dsh-provider` | DSH 侧 LLM adapter | 推理经受管 runtime 内 `hana.models` 发起（决策 B） |
| `@dshana/dsh-session` | 五个会话操作的编排落点 | 与 DSH 同进程，cordis `inject` 直取 sessions / sessionQuery / sessionProjections，不经 DSH 的 HTTP 面 |
| `@dshana/dsh-theme` | 宿主主题注入 DSH Web UI | `tapIndex` 注入静态 fallback + 动态桥（见「主题跟随」） |
| `@dshana/dsh-app` | 组合层包（profile 层列里被选中的那一层） | 派生自上游 web-app，承载 roster 行、对官方行的取值与 `@dshana/*` insert；逐文件上游 sha256 见 `provenance.json` |

组合层跟着上游 web-app 走，每升一版内核就整层 rebase 一次：upstream 补丁与 presets 整份搬过来，我们的 delta 只留在 `cordis.patch.yml` 与 `presets/dshana*.patch.yml` 里（其余 presets 与上游逐字相同）；`provenance.json` 记着每一份所基于的上游 sha256，`verify:bundle` 漂了就拦。内核 0.2.1 起三件事要记住：

- **`{{cwd}}` 不再是提示词变量。** 会话工作目录改由 `dsh-working-directory` 以「必需的用户上下文快照」给出，循环里没有这个变量了，任何 persona 模板再写 `{{cwd}}` 都会在组装提示词时严格插值报错。所以我们的两个特调 preset 的 suffix 不再带那句 `Your working directory is …`，`system-prompt` 行也不再重述 `personaSuffix`。
- **信任栅栏的 authority 换源。** 上游把 `webRuntime` 那个依赖 bind 的服务收掉了：`connection` 行直接读 `webStartup.trustedHosts`（bind 地址另算），`web-runtime` 行只负责公告 URL（`publicUrl`，宿主不传就是 bind 地址）。我们照上游写，不再往 `webRuntime` 上挂东西。
- **`shell.bottom` 槽位回来。** `ui-layout` 恢复了三列下方的底部行，我们的覆盖层跟着挂上它（空内容不占高），面认（`data-dshana-surface`）与列排不变。

官方自带的两个 LLM adapter（`llm-deepseek` / `llm-pi-ai`）在组合层停用：它们各要自己的凭据段与凭据库，而凭据在宿主手里，永远拿不到 key，官方那条 `deepseek-official` 路由却照样出现在模型选择器里（base 层的缺省模型也正指向它），选中它就在提交时报 no API key。停用之后 llm 注册表里只剩宿主目录那几条路由，模型面单一事实源；设置里的「模型」页随之一并停用（它只编辑那两行的 settings 段）。目录选择器不动：官方 `directory-picker-auto` 在 win32 + loopback 下挑 native，而 native 的客户端半优先读页面里的目录桥——壳页在注入 DSH index 前把 `__DSH_DIRECTORY_PICKER__` 装上（照 `hana.resources.pick` 要目录，见 `packages/ui/src/dsh-inject.ts`）。

**测试与真机边界：**

- 单测在 `tests/`（分组见 `tests/README.md`），覆盖 shared 的纯函数与状态机（rpc-envelope、task-binding、watch-sse、session-serialize、mux-chunks）、provider adapter（identity/catalog/messages/ndjson/stream）、host 半（task-bridge、approval-bridge、mux-relay）、routes、ui 桥与主题规则（首帧片段、强制面、剪贴板影子）、build 与交付面约束（集成层漂移闸、依赖版本、产物清单与语法）。`node --test tests/` 是主入口；`tests/e2e/*.probe.mjs` / `*.smoke.mjs` 是真机探针，不进 `pnpm test`。
- 真机走过的链路：打包 win32-x64 → 卸旧版 → 装新版 → 等 runtime ready → `smoke:packed --preflight`（依赖 + 定位 + 产物在位）与 `smoke:packed`（完整 boot 到中继端口有 HTTP 应答）。
- 仍需真机对账的边界：① ui/ 壳页到 App routes 的 surface 授权形态（scoped uiBasePath / iframe ticket → cookie / hana.api，代码按同源相对 fetch 写）；② DSH Web UI 在代理前缀下 SPA 资源/API/WS 的 base 适配；③ `/dshana/start` fire-and-forget 的宿主 route 并发语义（boot 数分钟窗口内宿主对 App route 请求无超时回收）；④ 壳桥 theme vars 的 TOKEN_MAP 对齐与 clipboard 桥路径；⑤ 宿主审批通知形态与 watch SSE 事件名/载荷实测对账，`dshana(action=approve)` 是否被模型正确选用；⑥ 宿主取消 UI（来源会话停止按钮）端到端与取消确认窗口超窗升级的实测触发面；⑦ 执行超时走 cancel 链端到端（DSH agent 正跑工具/长推理时被中止，终态 canceled 且内容不误标成功）；⑧ DSH Web UI 直开会话的审批（无绑定 → 委托 → 无应答者 fail-closed）；⑨ 旧数据迁移 `--apply` 真机执行（含 Windows junction / 文件锁 / 旧插件停机协调）。
- 已知缺口：App 进程重启会丢掉同会话串行化的进程内队列（`session-serialize.ts` 是 module 级 Map）与后台 watcher 状态，重启后按绑定记录重建判定；manifest 的 `activation.mode`（on-demand 激活）尚未采用，仍是随 App 加载即注册。
