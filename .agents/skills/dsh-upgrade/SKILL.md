---
name: dsh-upgrade
description: "How to move DSHana onto a newer upstream @deepseek-ai/dsh: judging whether a version is followable, the exact command order (pin, vendor dependency ranges, mirror checkout, overlay rebase, derive, gates), how to resolve overlay conflicts, and what the follow-up PR must contain. Read when following an upstream DSH release, when the integration drift gate reports stale overlays, or when a CI run fails on derive:check / verify:integrations after a version bump."
---

# 跟进上游 DSH 版本

这条线的全貌：`packages/host` 声明内核版本 → 组合层 `packages/dsh/app` 有 120 多条精确钉住的
`@deepseek-ai/dsh-*` → `integrations/` 的 23 份 overlay 各自记录「上游该文件的 sha256」，上游一动
闸就红。机械部分有脚本，判断部分只能人做。

## 1. 判定能不能跟

```
node scripts/dev/dsh-sync-probe.mts <版本>
```

两侧都要 ✓：git 侧有 `dsh-v<版本>` tag（镜像、overlay 漂移闸、provenance 闸都以它为坐标），
npm 侧那一版能解成完整依赖树。只一侧就位时不要动 pin，改动没法验证也没法安装。

`node scripts/dev/dsh-release-watch.mts` 用来找「有没有比当前 pin 更新的版本」，它从 registry 的
版本全集取候选，不看 dist-tags（rc 通道经常 tag 已打、next 仍指旧版）。

## 2. 开工作树

```
git worktree add .hana/worktrees/dsh-<版本> -b hana/dsh-<版本> origin/<基线分支>
```

基线分支：**alpha 线走 `next`，rc 与正式版走 `master`**。后续验证和 PR 都在这个工作树里做，
不要碰主仓库的工作树。

## 3. 机械部分

按这个顺序，前一步成功再走下一步。

```
node scripts/dev/dsh-bump.mts --to <版本>
pnpm install
pnpm run sync:vendor:dsh
node scripts/dev/dsh-overlay-rebase.mts --to <版本>
pnpm run derive
pnpm run verify:integrations
```

- `dsh-bump` 换两类东西：值精确等于旧 pin 的条目（三份清单里共 129 条左右），以及 vendor 线
  （cordis / schemastery / loader / group / hmr / include / logger-console / timer / cosmokit）的范围串。
  后者按上游目标 tag 里 `vendor/<目录>/package.json` 的 version 定，保留原有 `^`/`~` 前缀、只换主次段。
  加 `--check` 只看不改。
- `sync:vendor:dsh` 把镜像 checkout 到新 tag 并 `git add` gitlink。镜像里没有该 tag 时它会先 fetch。
- `dsh-overlay-rebase` 对每份 overlay 做三方合并：`base` 是旧 tag 的上游文件，`ours` 是当前
  overlay，`theirs` 是新 tag 的上游文件。干净合并的直接写回并更新 `upstreamSha256`。

⚠ **base 侧取自当前 pin**（脚本用 `dshPin()` 当旧版本），而前三步已经把 pin 换成目标版本。照上面
的字面顺序跑会得到「`0.2.2-rc.2 → 0.2.2-rc.2`、上游变了 0 份」——看着像干净的 0 冲突，实际一份
都没重放。正确做法是让 base 侧看到旧 pin：

```
git checkout HEAD -- packages/host/package.json       # 只回退 host 这一处 pin
node scripts/dev/dsh-overlay-rebase.mts --to <版本>
node scripts/dev/dsh-bump.mts --to <版本>             # 把 pin 写回目标版本（会报「已写回 1 条」）
```

机械部分完成后 `verify:integrations` 应当只剩冲突项。

⚠ 上游若往 `OPTIONAL_BUNDLES` 里加了新 bundle（rc.3 的 `@deepseek-ai/dsh-deepseek-chat-import`
就是这样），根 `pnpm-workspace.yaml` 的 `excluded-on-demand` 段要跟着加一行：stub 通道、内核依赖
摘除、离线 catalog 注入三处都从那一段读，加一行三处同时生效。对账闸是 `pnpm run verify:on-demand`
（挂在 `build` 链上，CI 每次 PR 都跑），不跟就在构建阶段红，而不是等到出包。

## 4. 冲突

冲突的 overlay 不写回，脚本会列出集成名与文件。用 `--diff3` 标记看三方：中间那段是 base（旧上游），
上下分别是我们的版本与新上游。

判断依据在两处：`git log integrations/<集成>/files/<路径>` 看这份 delta 是谁、为什么加的；
新上游那一侧 `git -C vendor/deepseek-harness diff dsh-v<旧> dsh-v<新> -- <上游路径>` 看它改了什么。

手工重放后 `deltaSha256` 要重算。不要自己算：直接跑 `pnpm run verify:integrations`，它会把期望值
打在报错里，照抄进 `integration.json`。

`deltaSha256` 只由 +/- 行内容算出、不含行号，所以干净的 rebase 不需要改它，这是判断「delta 有没有
在 rebase 里被弄丢」的唯一信号。

## 5. 组合层（bundle）

`packages/dsh/app` 派生自上游 `packages/bundle/web-app`，`provenance.json` 逐份记上游 sha256，
`pnpm run verify:bundle` 会报出哪几份漂移。跟 overlay 一样做三方合并：

```
git -C vendor/deepseek-harness show dsh-v<旧>:packages/bundle/web-app/<文件> > base
git -C vendor/deepseek-harness show dsh-v<新>:packages/bundle/web-app/<文件> > theirs
git merge-file -p --diff3 packages/dsh/app/<文件> base theirs
```

重放完把 `provenance.json` 的 `upstreamSha256` 换成新上游文件的哈希（顺手把 `upstreamVersion` /
`mirrorTag` 也改成目标版本）。

上游会在 patch 里新增行，而组合层只装了交付面那 133 个包：新行引用了不进的包（MCP 管理器、
Agent Team、Office 一整套、账号通知面板，以及预置里的 `tool-office`），本地 `verify:bundle`
会报「带 name 的行引用了…但本包 dependencies 里没有它」。按现有惯例把这几行**注释掉**并留一句
与上游对账的说明，不要直接删（下次跟进对不上号）。

## 6. 验收

```
pnpm run verify:integrations   # 23 份 overlay 全部对得上
pnpm run verify:bundle          # 组合层 12 份派生面对得上、行→包自洽
pnpm run verify:on-demand       # 按需名单与上游 OPTIONAL_BUNDLES 一一对应（build 链已含）
pnpm run derive:check           # 派生文件没有漂移（gitlink 一项要等 commit 后才绿）
pnpm run check:type
node --test tests/
pnpm run build
```

真机环节（`package:win:x64` → `install:local` → `smoke:packed`）会把当前宿主里的运行时换掉，
属于要人点头的动作，不放在自动流程里。

## 7. PR

分支从基线分支开，PR 面向同一个基线分支，先开 draft。正文写清：

- 版本跨度与基线分支，旧 pin 与新 pin
- 机械改动：换掉的精确版本串条数、vendor 线是否有变、derive 重写了哪些文件
- overlay：干净重放了几份、哪几份有冲突以及怎么解的
- 未完成项：还没处理的代码适配、upstream-guide 里相关但本次没动的变更
- 验收结果：上一步每条命令的实际输出，不要只写「通过」

## 8. 坑

- pin 在三份清单里必须一致（`packages/host`、根 `package.json` 的 devDependencies、组合层）。
  不一致时 `verify:integrations` 第一条就拒，报「DSH pin 不一致」。
- 不要用 `pnpm run verify:integrations` 代替 `node scripts/integrations/index.mts verify` 做预演：
  pnpm 会先跑 install，目标版本还没发时失败点会落在安装上，看不到镜像与 overlay 的真实状态。
- 镜像的 tag 没 fetch 时 `dsh-overlay-rebase` 与 derive 的 vendor 任务都会红，先跑 `sync:vendor:dsh`。
- 新开的工作树里 `vendor/deepseek-harness` 是个**空目录**（子模块不会跟着 worktree 初始化），
  于是 `git -C vendor/deepseek-harness` 默默落到外层仓，`sync:vendor:dsh` 报「取不到该 tag」。
  别去 fetch 外层仓：从主仓已 clone 的子模块对象库里现拉一份，再把 origin 指回上游。
  ```
  rm -rf vendor/deepseek-harness
  git clone <主仓>/.git/modules/vendor/deepseek-harness vendor/deepseek-harness
  git -C vendor/deepseek-harness remote set-url origin https://github.com/deepseek-ai/deepseek-harness.git
  ```
- overlay 是整文件拷贝，`.ts` 里大部分是上游原文。审 PR 时用 `integrations delta` 打出来的区间定位
  我们的改动，不要整份读。
