# packaging/ — 交付树里的静态件

这个目录放「装出来的包根上要有、但仓库自己的构建入口又不能是它」的东西。

## package.json

包根那份，也是**运行时依赖的唯一真源**。这个目录自持出包要用的三件：清单（`package.json`）、
它的锁文件（`pnpm-lock.yaml`，`scripts/derive` 的 package-lock 任务以仓库锁文件为种子派生）、
pnpm 配置（`pnpm-workspace.yaml`，授权 build、声明 supportedArchitectures）。`pack` 把清单与
锁文件拷进物化工位、按目标替换配置里的平台块，跑一次 `pnpm install --prod --frozen-lockfile`，
依赖即随包物化进安装树。仓库根那份 pnpm 配置只服务本地开发安装，不进工位。

四个键，来源分三类：

| 键 | 来源 | 为什么 |
| --- | --- | --- |
| `name` / `type` | 手写实体 | `type: module` 不能少：包根 `index.js` 是 ESM，Node 按「最近一份 package.json 的 type」判定模块类型，缺了它宿主 import entry 会按 CommonJS 解析 |
| `version` | 派生 | `scripts/derive` 的 `product-package` 任务按仓库版本重写 |
| `dependencies` | 手写实体 | 声明运行时依赖（`@deepseek-ai/dsh`），四条链路都读这里：工位物化、`vendor/deepseek-harness` 的 tag、集成漂移闸、产物版本串里的 `+dsh-…` |

仓库根那份 `package.json` 是**构建入口**（scripts / devDependencies / packageManager / imports
别名），装机侧一个都不消费：依赖已物化进包，安装不跑 pnpm；`imports` 别名在 build 期就解析掉了。
整份复制过去只会让人读出错觉，所以交付树只用这一份。

运行时依赖在根那边也留了一条同名 `devDependencies`：开发侧要那棵树（编辑器类型解析、覆盖层检查都
从本仓安装树取兜底），声明在根即照旧落进根 `node_modules`。两处的版本必须一致，由
`pnpm run verify:integrations` 这条闸守着，不靠人记得同时改。

`pack` 把清单复制到包根（`dist/package.json` → zip 根），出包前 `assertProductPackage` 校验字段白名单
与版本一致；锁文件与 pnpm 配置不随包——安装侧不执行任何 pnpm install。
