# integrations/ — hana 对官方 DSH 包的集成层（样例路线）

本目录承载「hana 对 DSH 的改动」，形态与官方样例 hana-dsh 一致：**薄集成贴上游版本**，
不是自研插件接管上游角色。

## 为什么要有这一层

我们曾在 `@dshana/view` 里 **vendor 了一份 0.1.2 的官方 ui-layout 源码**再改。
拷贝那一刻它就冻结了：0.1.5 把 root 子槽从 `conversation/details` 改成 `sidebar + main(keyed)`，
我们那份 frame 没跟上 → 官方 occupant 挂不上、根钩子无人提供 → **真机全页黑屏**。

结论：hana 的改动必须**贴着上游当前版本的源码**，并且**有版本戳、有构建期闸**。

## 形态

```
integrations/<短名>/
  integration.json          # 清单：对应官方包、上游目录、overlay 文件与其「基于的上游哈希」
  files/<上游相对路径>       # overlay：整文件拷贝 = 上游该文件 + 我们的 delta
```

`integration.json`：

```json
{
  "package": "@deepseek-ai/dsh-client-ui-layout",
  "upstreamVersion": "0.1.7-alpha.1",
  "upstreamDir": "packages/client/ui-layout",
  "files": [
    { "path": "src/client/index.ts", "upstreamSha256": "<写入时上游同名文件的 sha256>" }
  ]
}
```

## 闸怎么响

`node scripts/integrations/index.mts verify`（已接进 `pnpm run build`，在 build:src 之前）：

1. **镜像版本一致**：`vendor/deepseek-harness` 必须含 tag `dsh-v<版本>`。版本只有一个来源：
   根 `package.json#devDependencies["@deepseek-ai/dsh"]`（交付面清单退成铭牌后不再承载 pin，
   也不能放 T2 的包集清单里——那是 T1 的产物，会成先有鸡还是先有蛋）；
2. **overlay 未过期**：对每个 `files[].path`，重算**当前镜像该 tag 下同名文件**的 sha256，
   与清单里记录的比对。不一致 = 上游动过 → **构建失败**，并指出该 rebase 哪个文件、更新哪个哈希。
   注意闸读的是 **tag 坐标**（`git show <tag>:<路径>`），不是镜像的工作树——这与构建源
   （`git archive <tag>`）同一坐标，所以镜像工作树脏了既不影响闸也不影响产物。

于是"拷贝即冻结"在流程上不可能：上游一变，构建就停，rebase 是显式动作。
若上游新增了符号而我们用不上，不会报错；**我们引用了不存在的符号**则由该包的编译/类型检查拦下（第二道闸）。

## delta 在哪一刻进产物（T5 起）

overlay **不在 pack 期盖 `node_modules`**，而在**构建前铺进 scratch 检出**
（`scripts/vendor/build.mts` 调 `scripts/integrations/delta.mts`）。于是产物自带 delta、
包集清单的 sha512 描述的就是交付内容；pack 期不再有 `applyIntegrations`。顺序：

1. `git archive <tag>` 导出检出；
2. **过 `upstreamSha256` 闸**（上游动过就停在这里，点名要 rebase 哪个文件）；
3. 把 delta 整文件覆盖进 `<检出>/<upstreamDir>/<path>`；
4. 依赖安装 → host 生成（`dsh-typert-generator`）→ **生成物补丁**（`generatedPatches`，锚点定位）
   → client 面 → 打包。

版本戳 `+dshana-<干净版本>` **不**进检出，仍由 pack 期一处声明的元数据写入——否则每发一个
dshana 版本包集就变，缓存（跨度 ~15 分钟）再也跨不了版本。delta 的**内容哈希**进缓存键
（改了 overlay 就换键），而它不含版本号，故同一条目可被多个 dshana 版本复用。

### pack 期只剩两件事，都是闸

`applyIntegrations`（覆盖 `node_modules`）已退场。现在 pack 期是：

1. **盖版本戳**（`scripts/release/pack/stamp.mts`）：集成目标的 `package.json#version` 写成
   `<清单版本>+dshana-<干净版本>`。这是唯一的 pack 期内容写入，且它只改一个字段。
2. **判两条式子**（`scripts/release/pack/assert.mts`），不过就拒包：
   - `assertVersionEquation`——**交付树 = 清单闭包 + 已声明的戳**：集成目标的版本必须等于算出来的戳，
     其余包必须逐字等于清单版本。判据与盖戳共用 `shared/version.mts#patchVersionOf`，
     所以"写了却判不过"或反过来的假绿灯都不可能；
   - `assertRecipeBakedCurrentDelta`——**这份包集烤的 delta 就是当前 src-integrations 的 delta**。

第二条是"声明的补丁必须全部铺上"那条 fail-closed 语义的**新家**。它挪到了构建期
（`delta.mts#stageDelta`：声明了却没铺 = 构建失败），但那样会留一个洞：**声明改了而包集没重编**——
清单照旧指着旧缓存条目，pack 会拿一份不含新 overlay 的产物出包，而且它的 sha512 还会替它背书。
所以 pack 期把构建期的账（`build-recipe.json` 的 `integrations`）与当前声明对拍：
内容哈希不符、声明多一个/少一个集成、overlay 数不符，任一都拒包。

### 改了 overlay 之后要做什么

改 `src-integrations/**` 会让 delta 的内容哈希变 → 缓存键变 → **必须重编包集**
（`node scripts/vendor/build.mts`，~15 分钟）。忘了重编不会静默出包：
`assertRecipeBakedCurrentDelta` 会在打包时当场拦下。

同样的道理，包集重编后**锁文件也要跟**（`node scripts/derive/index.mts package-lock`）：
文件名与 spec 都没变，只是 tarball 字节变了，所以 `pnpm install --frozen-lockfile` 不重新哈希、
照旧放行。`packaging/pnpm-lock.yaml` 的 `derive --check` 因此额外做一道本地 tarball integrity
与清单的对拍（用 pack 的同一份实现），否则这处漂移要等到出包才爆。

## 我们的预设（`dshana`）：随包一个模板条目（spec §6.6）

这个集成声明为 `sourceOnly: true`：它**没有自己编的产物**，只改上游源码，由上游的构建
（`tsc -b`）把它编进 `@deepseek-ai/dsh-app-boot`。默认的集成是"重打 client/server 半"，缺了这个
标记，`build:integrations` 会拿 `profile.ts` 当浏览器入口去 bundle（或报找不到原版 `lib/client.js`）。

`app-boot-profile` 这个集成做的事与 `web` 完全同一条路：给 `PROFILE_TEMPLATES` 加一条
`dshana: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] }`（与 `web` 逐字相同），
然后 **DSH 自己在首次 `--profile dshana` 时建 `$DSH_HOME/profiles/dshana`**。我们一行 DSH_HOME 都不写。

买到的：清单里记的根集就是我们的预设（不再从上游模板名推断），上游改 `web` 不再悄悄改变我们装什么。

**一处要接受的边界**：dshana 的 DSH_HOME 可能是**用户自己的**，那 `profiles/dshana` 就建在他那儿。
实测那目录是**可移植的惰性产物**——`initProfile` 只写 `package.json`（纯 bundle 名字列表）、
`cordis.patch.yml` 模板、`pnpm-workspace.yaml`，**不含 `@dshana/*`、不含绝对路径**；用他自己的 dsh
载它照样两层解析成功。所以不会解析失败，只是"别人 boot 我们的预设名会退化成纯 web 组成"（我们的
roster 只存在于我们的安装树）。不轻量地避免它：避免的两条路（往用户 home 写我们的路径；给预设名塞
私有语义）都比这个边界更糟。卸载也不收口——那是 DSH 自己的目录，删不删都不影响任何一方。

### 贴 overlay 的新约束：你改的是**源码**，会在上游的 composite 工程图里被编译

时机前移的一个真实代价：overlay 不再"在装好的包上单独编"，而是在上游的
`tsc -b` 工程图里参与编译。上游的 composite 工程是**按 project reference 维系的**——
一个包 import 了另一个包的源码，它的 `tsconfig.json` 就必须声明对那个包的 reference，
否则聚合的 `tsc -b` 会报 TS6059/TS6307（"文件不在 rootDir 下"/"未列入本项目"）。

所以**不要**在 overlay 里凭空加一条跨包 `import`：
- 真需要那个包的类型 → 该包的 reference 得先存在，而它未必存在；
- 更要紧的是**别造成环**（`ui-workspace` 引用 `ui-session`，若后者反过来 import 前者，
  就是环，聚合编译当场失败）。

实践：overlay 里只 import 上游**已有**依赖边的东西；跨包契约若只在运行期通过
`ctx.inject` 动态到场（本目录的 `ui-session` 就是这样），就用**结构类型**表达你用到的那一小部分
（见 `ui-session/files/src/client/index.ts` 的 `UiWorkspaceNavigator`），而不是 import 对面的完整类型。

## 加一个集成

1. `integrations/<短名>/integration.json` 写好包名、上游目录；
2. 把「上游该文件 + 我们的 delta」整文件拷进 `files/<相对路径>`；
3. 记录上游同名文件的 sha256（`node scripts/integrations/index.mts hash packages/client/ui-layout/src/client/index.ts` 打印）；
4. `pnpm run build` —— 闸会替你验证镜像与哈希。

## 边界

- **只写 delta**：overlay 文件里除必要改动外不留私货，便于上游升级时人工比对。
- **不改上游未涉及的包**。
- 产物版本号带 `<上游版本>+dshana-<我们的干净版本>`（例 `0.1.7-alpha.1+dshana-1.0.0-rc.18`）：
  安装树里一眼可见“这包被改过”、被哪个 dshana 版本改的。版本段只有一个来源——主
  `package.json`（合成在 `scripts/shared/version.mts`，与 derive/version 同一份）；
  清单里不写任何手写版本字段。
- 不做运行时 shim：与"贴上游 + 构建期有闸"的路线相悖。
