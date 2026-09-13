---
name: dshana-install-skill
description: "安装 DSHana 的执行手册：有人给出这个仓库（或它的 Release）链接、要你把 DSHana 装上或升级到某版本时，按这里的步骤从发行包安装（含按平台取件）。用 Release 里的 index.v2.json 与条目自留字段 x-dshana-targets 定位本机对应的平台包（win32-x64 / darwin-arm64 / darwin-x64 / linux-x64），没有匹配就回落 universal。触发场景：被要求安装或升级 DSHana、想避开体积最大的通用包、装 DSHana 失败要排查、要把本地包提交给宿主安装。装的是发行包，不是这份手册本身。不触发：与发行包无关的开发、日常问答。"
---

# 安装 DSHana（执行手册）

## 什么时候用

有人把这个仓库（或它的 Release）链接给你，要你把 DSHana 装上、或升级到某个版本时，照本手册执行。**装的是 Release 里的发行包**；这份手册是给你读的执行步骤，不需要、也不应该把它当技能装进你自己身上。

装 DSHana 有两条路，装的是同一份发行包：

- **手动**：把 `dshana-v<version>[-<target>].zip` 拖进 Hana 的 App 安装界面，在审阅卡上批准权限。不需要取索引。
- **走宿主端点**（本手册的流程）：适合交给 Agent 执行，且能按平台挑体积更小的包。

本手册写的是后者。按平台取件时，平台包只含本机所需的那套依赖，比通用包小得多（通用包把各平台的依赖树都带上）；索引格式本身不带平台维度，平台件只能自己按 target 取。

## 索引里的自留字段

`index.v2.json` 的每个条目多一块自留字段 `x-dshana-targets`：target 名 → 该 target 的发行包。

| 字段 | 含义 |
|---|---|
| `url` | 该包的 https 绝对地址，可直接下载 |
| `sha256` | 该包的 SHA-256，小写 64 位十六进制 |
| `size` | 该包的字节数（正整数） |
| `format` | 固定 `"zip"` |

target 名即产物名里 `-v<版本>` 之后那段（通用包没有后缀，记作 `universal`）。**具体取值以你手上那份索引的实际内容为准**——每版都不同，不要照抄任何写死的数字。

### 字段的 schema

```json
{
  "type": "object",
  "description": "target 名 → 该 target 的发行包；target 名即产物名里 `-v<版本>` 之后那段（通用包无后缀，记作 universal）",
  "additionalProperties": {
    "type": "object",
    "required": ["url", "sha256", "size", "format"],
    "properties": {
      "url":    { "type": "string", "pattern": "^https://", "description": "该包的 https 绝对地址" },
      "sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$", "description": "小写 64 位十六进制" },
      "size":   { "type": "integer", "minimum": 1, "description": "字节数（正整数）" },
      "format": { "const": "zip" }
    },
    "additionalProperties": false
  }
}
```

这四个约束就是宿主对 `archive` 的校验口径（url 必须 https、sha256 必须 64 位小写十六进制、size 必须是正整数、format 必须是 `"zip"`）；按这份 schema 构成的块，宿主将来若真收编这个维度也能直接通过。

要点：

- 宿主官方格式的条目只有 `archive` 一格地址（格式版本见索引顶部的 `schemaVersion`），`versions[]` 的键是**版本**；消费侧只按版本文本匹配，**没有平台维度**。这块字段是我们自留的，宿主不读它、也不拒它，所以拿平台件要自己按 target 取。
- 五个 target 的包体积各不相同（通用包最大），选件时按本机平台取，取到的 size 与索引记录对得上再往下走。
- 条目里的 `archive`（主地址）按约定始终指向 **universal**；平台件只在 `x-dshana-targets` 里。

## 平台对照

| 本机 | target |
|---|---|
| Windows x64 | `win32-x64` |
| macOS Apple Silicon | `darwin-arm64` |
| macOS Intel | `darwin-x64` |
| Linux x86_64（glibc） | `linux-x64` |
| 其它或不确定 | `universal`（通用兜底，体积最大） |

发布矩阵只出这四个平台 + universal。`linux-arm64` / `win32-arm64` 不在矩阵内，需要时在本仓库点名自出：`pnpm run package --target=<名字>`。

## 步骤

1. **取索引**。首选 `latest`（索引文件名固定，不必知道版本号）：

   ```
   https://github.com/Nyasers/DSHana/releases/latest/download/index.v2.json
   ```

   `latest` 只指向**未标 prerelease** 的发布。流水线默认把新发布标为 prerelease（稳定版由人工标 latest），所以目标版本是 prerelease 时 `latest` 不会指向它，改用带 tag 的地址（tag 里的 `+` 写成 `%2B`）或 gh：

   ```
   https://github.com/Nyasers/DSHana/releases/download/v<版本>/index.v2.json
   gh release download <tag> -R Nyasers/DSHana -p index.v2.json
   ```

   包名带版本（`dshana-v<版本>[-<target>].zip`），所以 `latest` 只能省掉索引这一步；取包先拿索引，再从索引里的地址下载。

2. **选条目与 target**。在 `items[]` 里找 `kind=app` 且 `id` 等于目标 App 的那条（DSHana 只有一个 item），再取 `["x-dshana-targets"][<本机 target>]`。该键不存在时回落 `universal`，并说明通用包体积大。

3. **下载并核对**。下 `url`，核对 sha256 与索引记录一致（大小写不敏感）、size 对得上，再往下走。

4. **先卸载旧版**。同一 id 的覆盖安装不受支持，这一步不能省：

   ```
   DELETE <host>/api/extensions/app:<id>
   ```

5. **安装（提交 staging）**：

   ```
   POST <host>/api/extensions/install
   { "kind": "app", "source": { "type": "local", "path": "<zip 绝对路径>" } }
   ```

   返回 `awaiting_confirmation` 与 `stagedId`。

6. **确认**：

   ```
   POST <host>/api/extensions/staged/<stagedId>/confirm
   ```

   返回 `{"status":"installed", ...}`；`record.approval` 里是本次授予的能力清单。

7. **验证**。`GET <host>/api/extensions` 看该扩展的 `record.version`；再轮询 App 自己的启动状态路由（DSHana 是 `/api/apps/dshana/routes/dshana/boot-state`）。刚装完首次启动要等一会儿，不要要求立即就绪：轮询到 `state.phase === "ready"` 且 `state.ready === true` 才算成功；`error` / `stopped` 视为失败，按 `state.error` 与 runtime 日志排查。

## 宿主端点怎么拿

- 端口与 token：读 `<HANA_HOME>/server-info.json`（`HANA_HOME` 默认 `~/.hanako`）。
- 认证：`Authorization: Bearer <token>`。
- 为什么优先用这些 HTTP 端点：它们与 UI 是同一套通道；`extension_manager` 工具的 kind 级动作（install / list 等）可能被 capability 校验拒掉（confirm / discard 不带 kind，不受影响）。

## 已知坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 卸载重装后，本会话里该 App 的工具报 `RPC peer closed; cannot call callback.tools.execute` | 会话引擎在建立时捕获了当时那个 App 实例的工具对象，实例被替换后旧对象失效 | 开新会话或重启宿主；App 本身是好的（路由与 runtime 正常） |
| `index.v2.json` 的主 `archive.url` 指向某个平台包 | 生成期把不该进清单的 entry 喂给了构建器 | 索引按约定只该指 universal，见 `scripts/market-index.mts` 的目标选择 |
| `latest` 指向的不是你以为的版本 | `latest` 跳过 prerelease，而流水线默认把新发布标为 prerelease | 目标版本是 prerelease 时用带 tag 的地址，或 `gh release download <tag>` |
| 拿不到 `x-dshana-targets` | 该索引没带这块字段 | 用主 `archive`（universal）兜底，功能等同，只是体积更大 |

## 这个目录不进发行包

打包是从构建产物组装的（`scripts/pack.mts` 里 `fs.copySync(distDir, pkgDir)`），仓库根目录下的目录都在包外。这份手册只在仓库里给读它的人或 Agent 读，运行时不依赖它。
