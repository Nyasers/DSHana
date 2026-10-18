# dsh-base

剥离面（账号 / 反馈 / 遥测 / 官方 LLM adapter / 会话日志上传）在 dsh-base 这一处：它是共享底座，
那十条行都住在这里。组合层只能按 id 关掉（`disabled: true`），而关掉只是「装着不跑」，包还在树里、
还在依赖里。要真的不导入，只能删行。

## 删掉的十条

连带各自上方的注释块与 config 一起删：

| id | 是什么 |
|---|---|
| `session-log-deepseek` | 把会话日志随请求带给官方 API |
| `deepseek-account` | 账号服务（登录 / token / 余额 / 赠金） |
| `llm-deepseek` | 官方 API key adapter（`deepseek-official` 路由） |
| `llm-deepseek-account` | 账号路由 adapter（`deepseek-account` 路由） |
| `llm-pi-ai` | pi-ai 多 provider adapter（dormant，settings 段才激活） |
| `plugin-package-inventory-deepseek` | 把插件清单随官方请求带给 API |
| `deepseek-llm-api-extensions` | 上面两条的贡献点（`deepseekLlmApiExtensions` 服务） |
| `command-feedback` | `/feedback` 命令 |
| `otel`、`session-telemetry-otel` | 遥测 |

## 为什么这十条能删

本形态的推理一律走宿主：`@dshana/dsh-provider` 在受管 runtime 内经 `hana.models` 发起，路由集合
等于宿主目录的 `models.list`，DSH 侧一个 adapter 都不需要。那五个包在交付树里已被
`exclude.mts` 的 STRIPPED 挡掉，删行是让「包不在」与「行不加载」对齐。

## 验证方式

装好的树里把 base 的这十条整行删掉后跑 `runtime-boot.smoke --packed`，DSH 仍起到 `phase=ready`
（webserver 真实监听）。行留着只靠 `disabled` 时，loader 会报那几条 `failed to import`（包已不在树里）。

## halves 全 false

这个集成**不编译**任何半：补丁文档是纯数据，构建只把它原样盖回交付树。与其它集成的区别就在这里，
它们重打 `client.js`，我们只替换一份 YAML。

上游改了这份文档时，`verify` 的 `upstreamSha256` 闸会当场报，按报错 rebase 这 69 行的删除面。
