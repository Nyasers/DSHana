# api-remotes

剥离面（账号 / 反馈 / 产品埋点）在 api-remotes 这一处：它的 client 半是**唯一还在 import 那些包
的地方**，把 account / messageFeedback / sessionFeedback / productAnalytics 四个 Remote 贡献挨个
`$mount`。包不进交付树，这里就必须连 import 一起删。只删 `$mount` 调用不够（模块图仍要解析那四条
specifier），只关 loader 行也不够（这一处不是行，是普通模块 import）。

delta：4 条 import + 4 条 type-only re-export + 挂载数组里 4 个贡献项，共 −10 行 / +1 行（数组字面量
换行）。其余装配一字不动。

## 为什么不能整包剥离

它是**客户端 Remote 的装配面**，不是账号专用包。上游 24 个 UI 包（ui-chat / ui-session /
ui-workspace / ui-settings / ui-plugin-manager / ui-schedule / ui-sidebar-files / ui-cordis …）都从
这里取 `ctx.remote` 的类型面与 `$on` 的事件键面，宿主侧 `remote.<namespace>` 的 22 个贡献也全靠它
`$mount`。剥掉整包等于整个 Web UI 没有 Remote 层。所以剥的是它里面那四条 import。

## 另一半不在这份 overlay 里

base roster 的六行（`deepseek-account` / `llm-deepseek-account` / `command-feedback` /
`session-log-deepseek` / `otel` / `session-telemetry-otel`）在 `packages/dsh/app/cordis.patch.yml`
里按 id 关掉；web-app 那几行（`account-controller` / `ui-settings-account` / `message-feedback` /
`ui-message-feedback` / `ui-settings-session-log`）本层根本不插。

loader 对 `disabled` 的行连 import 都不发，于是「包不在树里」与「行不加载」两边成对；缺一半就是
boot 期 `ERR_MODULE_NOT_FOUND`。

## 不动的部分

`remote-events.ts`（宿主转发白名单）**不改**。api-remotes 的宿主半 `lib/index.js` 是上游发布时打好
的单文件 ESM，本集成只重建 client 半（halves 未声明 server），白名单在宿主半里已经编译进去；改源码
只会让 overlay 多一份不起作用的 delta。那两条 `deepseek-account` 事件留着也不发，因为发出它们的服务
不在了。
