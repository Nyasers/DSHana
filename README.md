# DSHana

> Hana App ID：`dshana`

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接入 [HanaAgent](https://github.com/liliMozi/openhanako)，作为**受管子代理执行器**：App 加载后拉起一个受管 Node runtime（`ctx.runtime.start`），DSH web 服务跑在里面；DSH 前端以同文档注入方式挂进 DSHana 卡。DSH 及其依赖树随包分发，**运行时不需要安装任何东西**。

## 安装

### 人类版

1. **拖入 zip 包**：把发行包 zip（`dshana-v<version>.zip`，从 GitHub Releases 下载）拖进 HanaAgent 的 App 安装界面；**批准安装审阅卡上的权限**（运行、本机运行、联网、资源读取；其中本机运行档位无文件系统隔离，审阅卡会如实标注）。

2. **打开 DSHana 卡**：App 加载后自动拉起受管 runtime，卡上按三态渲染：**未启动 / 启动中（阶段时间线 + 日志尾滚动）/ 就绪（装载 DSH Web UI）**。失败会进入「需要处理」态，卡上给出原因与原始错误；点「启动 DSH」可重试，端口占用会自动换端口。

### Agent 版

1. **安装**：Release 里除通用包（`dshana-v<version>.zip`）外，还有各平台包（`dshana-v<version>-<target>.zip`，体积明显更小）。按平台取件与安装的完整流程见 [`dshana-install-skill/SKILL.md`](dshana-install-skill/SKILL.md)：取 `index.v2.json` → 选本机 target → 核 sha256 → 先卸旧版 → 走宿主端点安装 → 验证。

2. **验证**：跑一次 `dshana(action="open", task="…", cwd="<工作目录>")`，任务正常回投即安装成功。

## 设置

App 级设置由 App 自绘设置页承载，在宿主设置区渲染，不依赖 DSH 运行；页面分「常规」与「默认模型」两节：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 审批超时（秒） | `30` | 审批无人应答即自动拒绝；填 `0` 禁用 |
| 任务默认超时（秒） | `1800` | 单次任务默认超时；填 `0` 按缺省 `1800` 兜底 |
| 模型 | 跟随 DSH | 新建会话使用的模型（DSH 的 `agent-default-model`） |
| 推理强度 | 跟随 DSH | 所选模型支持的档位；留空沿用 DSH 当前设置 |

DSH 数据固定落在 App 内置独立目录，开箱即用；共享或切换已有 DSH 目录暂不提供。

**无需配置 API Key / 模型**：推理经受管 runtime 内宿主 `ctx.models` 发起，provider 凭据不进 DSH 进程。默认模型读 DSH 自身配置（`DSH_HOME/settings.yaml` 的 `agent-default-model`），也可在 DSH 内直接改；`dshana` 的 `provider` / `model` / `reasoningEffort` 参数可显式覆盖单次任务。

## 主题

DSH 主题偏好为 `system` 时跟随宿主配色；在 DSH 内显式选 light/dark 时完全用 DSH Web UI 自己的主题。宿主切主题后已打开的页面实时跟随。

## 排错

把现象丢给 Agent 即可（技能 `dshana` 里有按三态组织的排错表）。也可以直接看：

- 卡上状态与原始错误（`需要处理` 态会展开）
- 宿主日志面：本 App 的日志一律走 `ctx.logger`（不另写文件日志），DSH 子进程的 stdout/stderr 由宿主受管 runtime 捕获

## License

This project is licensed under the **Mozilla Public License 2.0**.
See the [LICENSE](LICENSE) file for details.

This Source Code Form is "Incompatible With Secondary Licenses", as defined by the Mozilla Public License, v. 2.0.
