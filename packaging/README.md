# packaging/ — 交付树的包根铭牌

这个目录放「装出来的包根上要有、但仓库自己的构建入口又不能是它」的东西。

## package.json（铭牌）

包根那份，只回答「这包是什么、什么版本」。**T3 起它不再作安装输入**：物化输入由包集清单
（`dsh-package-set.json`）派生（见 `scripts/release/pack/install-source.mts`），装机侧也不跑
pnpm（依赖已随包物化进安装树）。

三个键：

| 键 | 来源 | 为什么 |
| --- | --- | --- |
| `name` | 手写实体 | 包根身份 |
| `type` | 手写实体 | `type: module` 不能少：包根 `index.js` 是 ESM，Node 按「最近一份 package.json 的 type」判定模块类型，缺了它宿主 import entry 会按 CommonJS 解析 |
| `version` | 派生 | `scripts/derive` 的 `product-package` 任务按仓库版本重写 |

T3 之前这里还有一个 `dependencies: { "@deepseek-ai/dsh": ... }`：它曾是**运行时依赖的唯一真源**
（工位按它装、vendor tag、集成漂移闸、版本串的 `+dsh-...` 都读它）。换源后物化输入改由包集清单
派生，这份声明没有消费方了，于是 **DSH pin 迁到根 `package.json#devDependencies`**——那份历来就有
（开发侧要那棵树），且一直有一致性闸守着，合并成一处是消除重复。`scripts/derive` 的
`version-metadata` 任务守着版本串的 `+dsh-` 段。

`pack` 把这份复制到包根，出包前 `assertProductPackage` 按**写死**的白名单校验（键集合逐字相等 +
`name` 固定 + 版本一致 + `type: module`），不放宽成「任意 package.json 都行」。

## dsh-package-set.json（包集清单）

T2 的产物：T1 编出的 318 个 `@deepseek-ai/*` 包的 `name / version / file / bytes / sha512`，加根集
（我们的 `dshana` 预设模板 ∪ `OPTIONAL_BUNDLES` ∪ `@dshana/*`）与构建身份（tag / commit / 缓存键 /
node / 构建链 pnpm / 交付链 pnpm）。
物化时按它把 tarball 拷进工位并逐个校 sha512；构建期另有一道闸拿现算根集与它比对。

`build.pnpm` 与 `build.deliveryPnpm` 是**两条链各自的 pnpm**（前者检出/vendor 那份上游 pin，后者本仓
`packageManager` 声明那份），故意分开记；同一个字段说不清哪条链用了哪个版本。清单格式版本 2 起有这一格。

## 交付链的 pnpm（机器准备与首次使用）

**本仓用哪个 pnpm，由 `packageManager` 声明决定**（corepack 与 pnpm 自带的版本管理都是这套机制的
提供者）——构建链跟检出的上游声明，交付链（派生锁文件 + 物化）跟本仓声明。所以**换一台机器第一次
跑，先让这份声明能被满足**（pnpm 能取到该版本，例如 `pnpm install` 一次）；取不到时交付链会当场
报「实际版本 ≠ 声明版本」并拒绝出包，而不是退回手边那份。

**干净克隆上 `pnpm run derive:check` 会 fail-closed**：包集清单与锁文件都派生自 T1 缓存条目，
没有条目就报「T1 缓存条目不存在」。先跑一次 `pnpm run build:dsh` 把包集编出来（此后 `derive:check`
才有东西可校）。

## pnpm-lock.yaml（物化锁文件）

由 `scripts/derive` 的 `package-lock` 任务派生：以包集清单派生出的工位为唯一 manifest 重解析。
工位里每个 `@deepseek-ai/*` 包名 override 到 `file:./packages/<file>`，pnpm 为这些本地 tarball 写下
`resolution: {integrity: sha512-..., tarball: file:...}`——**那份 integrity 与清单里的 sha512 是同一种值**
（实测 278 个逐一对拍，0 处不符）。三方依赖（koffi / node-pty / @img/sharp / @octokit ...）仍从
registry 取，与今天一致。

## pnpm-workspace.yaml（工位配置源）

工位只吃这份（allowBuilds 授权 build、supportedArchitectures 声明平台）。`pack` 按目标替换平台块，
并把包集 overrides 注进去（`scripts/release/pack/install-source.mts`）。仓库根那份只服务本地开发安装。

注：依赖经 override 落到本地 tarball 后，`allowBuilds` 的键要写成 `name@file:packages/<file>` 形状
才被 pnpm 11.24 认出来（裸包名会报 `[ERR_PNPM_IGNORED_BUILDS]`）；这条改写由 `install-source.mts`
的 `rewriteAllowBuilds` 做。
