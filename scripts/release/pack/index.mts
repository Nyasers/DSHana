// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/index.mts — dshana 自包含打包（适配单 bundle 收敛架构；构建脚本不随源码编译）
// 交付物 = 代码 bundle（dist/）+ cordis 子插件包与组合层包（.cache/cordis/、.cache/bundle/）+ **物化后的生产依赖树**
// （含 win32/darwin/linux × x64/arm64 预编译资产），安装即用、无需 npm install。
// 依赖物化形态对齐样例 hana-dsh：hoisted 布局（顶层真实目录、无软链接——软链进 zip 跨机
// 解压即断）。物化在 .cache/pkg-root/ 隔离进行，不触碰仓库 node_modules。
// 流程：复制交付清单（prepackage 钩子已先行 build）→ 物化生产依赖 → 断言多平台资产 → zip → SHA256。
// 用法：pnpm run package --target <名字>（prepackage 自动前置 build；单独 node scripts/release/pack/index.mts 要求 dist 已构建）
// 产出：releases/dshana-v<version>[-<target>].zip。**zip 根 = 包根**：manifest.json、
//   bin/、node_modules/、ui/ 等全部在 zip 根级，不得套一层目录（宿主安装时在包根读 manifest.json）。
// 两个台子的分工（都在 .cache/ 下，起手清残留、用完即清、收尾由 postpackage 钩子清）：
//   · .cache/pkg-root/<target>：依赖物化**工位**。要跑一次真 install，就得有个像独立项目的目录——
//     工位三件都现生成（清单 + 按目标替换过 supportedArchitectures 的 pnpm-workspace.yaml +
//     以仓库锁文件为种子重解析出的锁）落进去跑 `pnpm install --prod --frozen-lockfile`。
//     隔离在独立目录下，仓库自身的 node_modules 与锁文件不被污染。
//   · .cache/pkg：交付**组装台**。只放要进包的东西（dist/ + .cache/cordis/ + .cache/bundle/ + 物化依赖树），
//     不带 pnpm 的中间物（lockfile、workspace yaml、.modules.yaml 这些是构建输入，不是交付物）。
//     把「工位」与「组装台」分开，就是不让构建输入混进安装包；组装出包后立即删。
//
// 分模块：目标表在 targets.mts，出包前断言在 assert.mts，依赖物化与精简在 materialize.mts，
// 集成补丁覆盖在 overlays.mts，静态件压缩在 minify.mts，交付面裁剪在 trim.mts；
// 本文件是主流程（校验 → 组装 → 裁剪 → zip）。
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ZipArchive } from "archiver";

import fs from "fs-extra";

import { errText } from "../../shared/err-text.mts";
import { BUNDLE_DIR, CORDIS_DIR, DIST_DIR, PKG_DIR, STAGING_ROOT } from "../../shared/paths.mts";
import { ROOT } from "../../shared/root.mts";
import { assertBundleArtifacts, assertCordisArtifacts, assertNoProductPackage, assertUiTree } from "./assert.mts";
import { declareInstallationBundle, declareInstallationPlugins } from "./bundle-deps.mts";
import { excludedPackages, pruneExcluded, requiredPackages } from "./exclude.mts";
import { materializeProdDeps } from "./materialize.mts";
import { minifyCordisStatics } from "./minify.mts";
import { applyIntegrations } from "./overlays.mts";
import { failUsage, targetSpec } from "./targets.mts";
import { describeTrim, trimDeliveryTree } from "./trim.mts";

// 版本单一事实源：package.json（唯一来源；不支持命令行传版本，显式传的版本会与 manifest 不同步）。
// 版本同步走 pnpm version 发版流程，由 scripts/release/version.mts 收口。
const repoPkg = fs.readJsonSync(join(ROOT, "package.json"));
const version = repoPkg.version;
if (!version) throw new Error("package.json version 缺失");
// 版本一致性校验：打包版本必须同时等于 manifest.json 的 version，只同步一处会出发布包版本与 tag 不一致的包。
const manifestVersion = fs.readJsonSync(join(ROOT, "manifest.json")).version;
if (version !== manifestVersion)
  throw new Error(
    `版本不一致：package.json ${version} ≠ manifest.json ${manifestVersion}（manifest 未同步，跑 node scripts/derive/index.mts 同步后再打包）`,
  );

// 1. 静态项补齐交付目录。构建阶段（build:app / build:cordis）已写出安装态骨架
//    （bin/（入口 + app 主体 + runtime）+ manifest.json / icon.png / skills/ / ui/），
//    这里只补清单外的文本件；包根即 App 安装目录，不套 dist 这层目录。不在清单里的东西各有其宿主：
//    · routes/ —— v2 走 ctx.routes.register，route 在 index.mjs 里注册，无目录产物；
//    · app/（卡片脚本与样式）—— 构建时内联进 index.mjs bundle；
//    · manifest.json / assets/ / skills/ —— 都从仓库根取（App 契约与随包静态件）：manifest/skills 原样拷，
//      assets/ 下的相对路径就是产物里相对包根的路径（`icon.png` 到产物根、`ui/cover.png` 到产物 `ui/`）；
//    · package.json —— 不生成也不随包：入口是 index.mjs，Node 按扩展名判 ESM，安装树不需要包清单；
//      仓库那份带 scripts / devDependencies / packageManager / imports，是构建入口（上面的断言拒收）。
//    · pnpm-workspace.yaml / pnpm-lock.yaml —— 不随包：装机侧不执行 pnpm install（依赖已物化进包）。
const staticItems = ["NOTICE", "THIRD_PARTY_NOTICES.md"];
const distDir = DIST_DIR;
for (const item of staticItems) {
  const src = join(ROOT, item);
  if (!fs.pathExistsSync(src)) throw new Error(`静态项不存在：${item}`);
  // dereference: true —— 静态项都是真实文件，无符号链接，该选项不改变复制结果。包内不含 pnpm
  // 二进制：依赖在打包时物化进安装树，装机侧不执行 pnpm。
  fs.copySync(src, join(distDir, item), {
    dereference: true,
    filter: (srcPath) => {
      if (srcPath.includes("node_modules/.bin")) return false;
      if (/__tests__|\.test\.|\.spec\./.test(srcPath)) return false;
      return true;
    },
  });
}

// 1.5 / 1.6) 产物断言：cordis 包与组合层包的版本/完整性、交付树无包清单、App ui/ 静态树（缺失即拒包）
assertCordisArtifacts(CORDIS_DIR, version);
assertBundleArtifacts(BUNDLE_DIR, version);
assertNoProductPackage(distDir);
assertUiTree(distDir);

// 目标选择：`--target <名字>`（必须显式给，无默认）。
// 用 node:util 的 parseArgs 结构化解析（strict + 禁位置参数）：未知选项、缺值、多余位置参数
// 由它直接报错。手写字符串扫描会把 `--targets=x` 这类拼错的选项漏成合法值，静默回落去跑通用包。
const spec = (() => {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: { target: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    failUsage(`参数解析失败：${errText(e)}`);
  }
  const raw = parsed.values.target;
  if (raw === undefined) failUsage("未指定 --target");
  const name = String(raw).trim();
  const found = targetSpec(name);
  if (!found) failUsage(`未知打包目标：${name}`);
  return found;
})();

// 2. 静态资产压缩（terser JS 纯语法级，覆盖写回交付目录副本）
await minifyCordisStatics(CORDIS_DIR);

// 3+4) 组装 → zip → SHA256（单目标；发布产物归档 releases/）
//    archiver 纯 Node 跨平台 zip（对齐 hana-remote-dev）：不用 tar -a -cf——
//    GNU tar（Linux）不认 .zip 后缀会静默产出 tar 伪 zip
const relDir = join(ROOT, "releases");
fs.ensureDirSync(relDir);
// 打包台纪律（多目标连跑会堆积数 GB）：
//   · 起手清残留（上次运行/中途崩溃留下的）；
//   · 用完即清（物化工位 + 组装台）；
//   · 收尾全清由 package.json 的 postpackage 钩子承担（scripts/release/clean-cache.mts），CI 里也可单独调。
// 两处台子都可再生，真正的产物只有 releases/ 下的 zip + sha256。
const pkgRoot = PKG_DIR;
for (const stale of [pkgRoot, STAGING_ROOT]) fs.removeSync(stale);
{
  const modules = materializeProdDeps(spec, version);
  // 命名：通用包无后缀（既有 CI/脚本按 dshana-v<ver>.zip 取件），平台包带目标后缀
  const base = spec.name === "universal" ? `dshana-v${version}` : `dshana-v${version}-${spec.name}`;
  const pkgDir = join(pkgRoot, base); // 组装暂存目录（内容原样进 zip 根，此目录名不出现在包里）
  fs.removeSync(pkgDir);
  fs.copySync(distDir, pkgDir);
  // 依赖树拷进包时剔掉 node_modules 下的点号条目——pnpm 自己的账本，不是依赖：
  //  · .bin —— 内容全为可执行入口软链，进 zip 跨机解压即断，宿主装机时以 INSTALL_ARCHIVE_SYMLINK
  //    直接拒收；仓库内无消费方（runtime 经 createRequire 解析包，不经 .bin）。
  //  · .pnpm —— hoisted 布局下不生成虚拟存储，仅剩 lock.yaml 残留；@deepseek-ai/dsh-app-boot 在顶层
  //    node_modules，createRequire 直接命中，不触发 .pnpm 回退。
  //  · .pnpm-workspace-state-v1.json / .modules.yaml —— pnpm 的安装状态，里面记着**构建机的绝对
  //    路径**（工位目录）与当次 allowBuilds 决定，只对装它的那台机器有意义。
  // 依赖名不会以点开头，按这个口径一刀切比逐个列举稳。
  fs.copySync(modules, join(pkgDir, "node_modules"), {
    filter: (srcPath) => !/[\/\\]node_modules[\/\\]\./.test(srcPath),
  });
  applyIntegrations(join(pkgDir, "node_modules"));
  // 被排除的表层 bundle 与它们的私货：物化时已 override 成 stub（不下载真件），这里把占位也从
  // 产物里删掉——交付树里既没有真件也没有槽位。断言两端：名单必须命中，且删干净。
  const pruned = pruneExcluded(join(pkgDir, "node_modules"));
  if (pruned.length === 0) {
    throw new Error("排除名单一个都没命中（工位 overrides 没生效？）：拒绝产出带全量表层的包");
  }
  const leftover = excludedPackages().filter((n) => fs.pathExistsSync(join(pkgDir, "node_modules", n)));
  if (leftover.length > 0) throw new Error(`被排除的包仍在产物里：${leftover.join("、")}`);
  console.log(`[pack] 排除表层/私货包 ${pruned.length} 个（产物里不留槽位）：${pruned.join(", ")}`);
  // 交付面裁剪：依赖树里运行时不读的东西（测试目录、包内源码与类型声明、构建元数据、文档与夹具）。
  // 规则与判据见 trim.mts 头注；只动 node_modules，跳过 @dshana。放在必需产物断言之前，
  // 断言因此检查的是裁完的树（裁过头会当场抛错）。
  const trim = trimDeliveryTree(pkgDir);
  console.log(describeTrim(trim));
  // @dshana 的两个 scope 内容落进安装树的 node_modules（与 @deepseek-ai/* 同锚点）：DSH 的 runtime
  // 解析模式从安装树 + bundle 依赖图算解析代、不建链接，它们因此不能住在安装树外的位置。两者本来
  // 都不在交付面里（产物在 .cache/cordis 与 .cache/bundle），到这一步才按交付布局落进
  // node_modules/@dshana：子插件 + 组合层包（dsh-app，profile 层列里被选中的那一层）。
  if (!fs.pathExistsSync(CORDIS_DIR)) throw new Error(".cache/cordis 缺失：先跑 pnpm run build 再打包");
  if (!fs.pathExistsSync(BUNDLE_DIR)) throw new Error(".cache/bundle/dsh-app 缺失：先跑 pnpm run build 再打包");
  fs.copySync(CORDIS_DIR, join(pkgDir, "node_modules", "@dshana"), { overwrite: true });
  fs.copySync(BUNDLE_DIR, join(pkgDir, "node_modules", "@dshana", "dsh-app"));
  for (const rel of [
    join("node_modules", "@dshana", "dsh-provider", "index.js"),
    join("node_modules", "@dshana", "dsh-session", "index.js"),
    join("node_modules", "@dshana", "dsh-app", "lib", "index.js"),
  ]) {
    if (!fs.pathExistsSync(join(pkgDir, rel))) throw new Error(`包内产物缺失：${rel}（拒绝出包）`);
  }
  // 层列要的那两层必须在：缺 base 或少我们的组合层包，boot 都起不来，宁可不打包。
  const absent = requiredPackages().filter((n) => !fs.pathExistsSync(join(pkgDir, "node_modules", n, "package.json")));
  if (absent.length > 0) throw new Error(`产物缺必需的包：${absent.join("、")}（拒绝出包）`);
  console.log("[pack] @dshana 产物就位（4 子插件 + 组合层包 dsh-app -> node_modules/@dshana），必需包齐备")
  // 只躺在 node_modules 里不够：DSH 按「安装树 + 被选中 bundle 的依赖图」算解析代，真机上
  // profile 在数据目录里向上解析走不到安装树，得由被选中 bundle 认领才进解析代（见 bundle-deps.mts）。
  declareInstallationPlugins(join(pkgDir, "node_modules"));
  // 只躺在 node_modules 里不够：DSH 按「安装树 + 被选中 bundle 的依赖图」算解析代，而**被选中
  // bundle 自己的名字会被从 profile 作用域里删掉**（按设计从安装图解析）。所以组合层包必须进安装图
  // ——声明进安装锚点（内核包）的依赖（见 bundle-deps.mts 的说明）。
  declareInstallationBundle(join(pkgDir, "node_modules"));
  // 暂存树用完即删
  fs.removeSync(join(STAGING_ROOT, spec.name));
  console.log(`[pack] ${spec.name}：代码 + 依赖树已就位（${base}），暂存树已清理`);
  const zipPath = join(relDir, `${base}.zip`);
  fs.removeSync(zipPath);
  const tmpZip = join(relDir, `.${base}.zip.tmp`); // 先写临时文件，rename 原子落位
  const output = fs.createWriteStream(tmpZip);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  // resolve 要包一层：它带 (value) 参数，而 'close' 的 listener 签名是 () => void，
  // 直接传在 @types/node 26 下会被判「目标签名参数太少」。
  const done = new Promise<void>((resolve, reject) => {
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
  });
  archive.pipe(output);
  // 第二参数必须为 false：把 pkgDir 的**内容**放在 zip 根。传 base 会把整包套进一层 `<base>/`，
  // 宿主安装时在包根读 manifest.json 读不到（落在 `<base>/manifest.json`），报 INVALID_MANIFEST 拒装：
  // 宿主校验器 `validate-app.mjs --archive <zip>` 会判 "ENOENT ... '<app>\\manifest.json'"。
  // 参照物：装得上的样例包 zip 根级就是 manifest.json / node_modules / ui / dist。
  archive.directory(pkgDir, false);
  await archive.finalize();
  await done;
  fs.moveSync(tmpZip, zipPath, { overwrite: true });
  const buf = fs.readFileSync(zipPath);
  const sha = createHash("sha256").update(buf).digest("hex").toUpperCase();
  console.log(`[pack] ${zipPath}`);
  console.log(`[pack] zip ${(buf.length / 1048576).toFixed(1)} MB · SHA256 ${sha}`);
  // 铺平目录已入包，即用即清
  fs.removeSync(pkgDir);
}
// 收尾全清 → postpackage 钩子（scripts/release/clean-cache.mts）
