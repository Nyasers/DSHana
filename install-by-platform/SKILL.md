---
name: install-by-platform
description: "按平台安装 DSHana 发行包的手册。用 Release 里的 index.v2.json 与条目自留字段 x-dshana-targets 定位本机对应的平台包（win32-x64 / darwin-arm64 / darwin-x64 / linux-x64），没有匹配就回落 universal。触发场景：装或升级 DSHana、想避开 98MB 的通用包、想知道 x-dshana-targets 怎么用、装 DSHana 失败要排查、要把本地包提交给宿主安装。不触发：日常问答、与发行包无关的开发。"
---

# 按平台安装 DSHana 发行包

## 什么时候用这个流程

装或升级 DSHana 时，如果按平台取件，拿到的包是 40MB 上下；通用包（universal）是 98MB。索引格式本身不带平台维度，平台件只能自己按 target 取——这份手册就是取件与安装的完整流程。

## 索引里的自留字段

`index.v2.json` 的每个条目多一块自留字段：

```json
"x-dshana-targets": {
  "universal":    { "url": "…/dshana-v<ver>.zip",             "sha256": "…", "size": 98582734, "format": "zip" },
  "win32-x64":    { "url": "…/dshana-v<ver>-win32-x64.zip",   "sha256": "…", "size": 41318833, "format": "zip" },
  "darwin-arm64": { "url": "…", "sha256": "…", "size": 0, "format": "zip" },
  "darwin-x64":   { "url": "…", "sha256": "…", "size": 0, "format": "zip" },
  "linux-x64":    { "url": "…", "sha256": "…", "size": 0, "format": "zip" }
}
```

要点：

- 宿主官方格式（`schemaVersion` 2）的条目只有 `archive` 一格地址，`versions[]` 的键是**版本**；消费侧只按版本文本匹配，**没有平台维度**。这块字段是我们自留的，宿主不读它、也不拒它，所以拿平台件要自己按 target 取。
- 字段里的 url 是**绝对地址**，sha256 是小写 64 位十六进制，size 是字节数。
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

1. **取索引**。两种取法，任选：

   ```
   gh release download <tag> -R Nyasers/DSHana -p index.v2.json
   ```

   或直接下 `https://github.com/Nyasers/DSHana/releases/download/<tag>/index.v2.json`（tag 里的 `+` 在 URL 中需写成 `%2B`）。

2. **选条目与 target**。在 `items[]` 里找 `kind=app` 且 `id` 等于目标 App 的那条（DSHana 只有一个 item），再取 `["x-dshana-targets"][<本机 target>]`。该键不存在时回落 `universal`，并说明通用包体积大。

3. **下载并核对**。下 `url`，核对 sha256 与索引记录一致（大小写不敏感）、size 对得上，再往下走。

4. **先卸载旧版**。宿主对同 id 的重装会失败，卸载必须在前面：

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

7. **验证**。`GET <host>/api/extensions` 看该扩展的 `record.version`；再取 App 自己的启动状态路由（DSHana 是 `/api/apps/dshana/routes/dshana/boot-state`），`state.phase` 应为 `ready`。

## 宿主端点怎么拿

- 端口与 token：读 `<HANA_HOME>/server-info.json`（`HANA_HOME` 默认 `~/.hanako`）。
- 认证：`Authorization: Bearer <token>`。
- 为什么不用 `extension_manager` 工具：本版本的宿主上，该工具的 kind 级动作（install / list 等）会被 capability 校验拒绝，只有不带 kind 的 confirm / discard 能过；上面这些 HTTP 端点与 UI 用的是同一套通道。

## 已知坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 装同 id 的新版失败 | 宿主对同 id 重装的处理有缺陷 | 先 `DELETE` 卸载旧版，再 install |
| 卸载重装后，本会话里该 App 的工具报 `RPC peer closed; cannot call callback.tools.execute` | 会话引擎在建立时捕获了旧 App 实例的工具对象，实例换掉后不会重建 | 开新会话或重启宿主；App 本身是好的（路由与 runtime 正常） |
| `index.v2.json` 的主 `archive.url` 指向某个平台包 | 生成期把不该进清单的 entry 喂给了构建器 | 索引按约定只该指 universal，见 `scripts/market-index.mts` 的目标选择 |
| 索引构建报体量超限 | 单条目 archive 有 50MB 上限（宿主与本仓库同款校验） | 平台件都在 41MB 以下，按平台取件可避开 |
| 拿不到 `x-dshana-targets` | 该版本的索引由旧版脚本产出 | 用主 `archive`（universal）即可，功能等同，只是体积大 |

## 这个目录不进发行包

打包是从构建产物组装的（`scripts/pack.mts` 里 `fs.copySync(distDir, pkgDir)`），仓库根目录下的目录都在包外。这份手册只给人读，运行时不依赖它。
