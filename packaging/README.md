# packaging/ — 交付树里的静态件

这个目录放「装出来的包根上要有、但仓库自己的构建入口又不能是它」的东西。

## package.json

包根那份。这个目录自持出包要用的三件：清单（`package.json`）、它的锁文件（`pnpm-lock.yaml`，
`scripts/derive` 的 package-lock 任务以仓库锁文件为种子派生）、pnpm 配置（`pnpm-workspace.yaml`，
授权 build、声明 supportedArchitectures）。`pack` 把清单与锁文件拷进物化工位、按目标替换配置里的
平台块，跑一次 `pnpm install --prod --frozen-lockfile`，依赖即随包物化进安装树。仓库根那份 pnpm
配置只服务本地开发安装，不进工位。

四个键，来源分两类：

| 键 | 来源 | 为什么 |
| --- | --- | --- |
| `name` / `type` | 手写实体 | `type: module` 不能少：包根 `index.js` 是 ESM，Node 按「最近一份 package.json 的 type」判定模块类型，缺了它宿主 import entry 会按 CommonJS 解析 |
| `version` | 派生 | `scripts/derive` 的 `product-package` 任务按仓库版本重写 |
| `dependencies` | 派生 | 同一个 `product-package` 任务从 `packages/host/package.json#dependencies` 派生，剔除 `workspace:` 在仓项。四条链路读它：工位物化、`vendor/deepseek-harness` 的 tag、集成漂移闸、产物版本串里的 `+dsh-…` |

**运行时依赖的真源是 `packages/host/package.json#dependencies`**（内核 `@deepseek-ai/dsh` 声明在
那里，壳不声明内核）。这份清单的 `dependencies` 是它的派生物：仓内包（`@dshana/*`）在构建期被
rspack 内联进各自 bundle，也解析不了 `workspace:` 协议，因此不进交付清单；交付清单只列能物化的
registry 依赖。`pack` 物化、镜像 tag、集成漂移闸都照旧读这份清单。

仓库根那份 `package.json` 是**构建入口**（scripts / devDependencies / packageManager / imports
别名），装机侧一个都不消费：依赖已物化进包，安装不跑 pnpm；`imports` 别名在 build 期就解析掉了。
整份复制过去只会让人读出错觉，所以交付树只用这一份。

运行时依赖在根那边也留了一条同名 `devDependencies`：开发侧要那棵树（编辑器类型解析、覆盖层检查都
从本仓安装树取兜底），声明在根即照旧落进根 `node_modules`。两处的版本必须一致，由
`pnpm run verify:integrations` 这条闸守着（比的是 `packages/host/package.json` 与根），不靠人记得
同时改。

`pack` 把清单复制到包根（`.cache/dist/package.json` → zip 根），出包前 `assertProductPackage` 校验字段白名单
与版本一致；锁文件与 pnpm 配置不随包——安装侧不执行任何 pnpm install。
