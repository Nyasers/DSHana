// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/index.mts — dshana 自包含打包（适配单 bundle 收敛架构；构建脚本不随源码编译）
// 交付物 = 代码 bundle（dist/）+ cordis 插件 + ui/ 静态树 + **物化后的生产依赖树**
// （含 win32/darwin/linux × x64/arm64 预编译资产），安装即用、无需 npm install。
// 依赖物化形态对齐样例 hana-dsh：hoisted 布局（顶层真实目录、无软链接——软链进 zip 跨机
// 解压即断）。物化在 _tmp/pkg-root/ 隔离进行，不触碰仓库 node_modules。
// 流程：复制交付清单（prepackage 钩子已先行 build）→ 物化生产依赖 → 断言多平台资产 → zip → SHA256。
// 用法：pnpm run package --target <名字>（prepackage 自动前置 build；单独 node scripts/release/pack/index.mts 要求 dist/ 已构建）
// 产出：releases/dshana-v<version>[-<target>].zip + .sha256。**zip 根 = 包根**：manifest.json、
//   index.js、node_modules/、ui/ 等全部在 zip 根级，不得套一层目录（宿主安装时在包根读 manifest.json）。
// 两个临时目录的分工（都在 _tmp/ 下，起手清残留、用完即清、收尾由 postpackage 钩子清）：
//   · _tmp/pkg-root/<target>：依赖物化**工位**。要跑一次真 install，就得有个像独立项目的目录——
//     交付面自带的三件（packaging/package.json + packaging/pnpm-lock.yaml + 按目标替换过
//     supportedArchitectures 的 pnpm-workspace.yaml）落进去跑 `pnpm install --prod --frozen-lockfile`。
//     隔离在 _tmp 下，仓库自身的 node_modules 与锁文件不被污染。
//   · _tmp/pkg：交付**组装台**。只放要进包的东西（dist/ + 物化依赖树 + cordis + ui + manifest），
//     不带 pnpm 的中间物（lockfile、workspace yaml、.modules.yaml 这些是构建输入，不是交付物）。
//     把「工位」与「组装台」分开，就是不让构建输入混进安装包；组装出包后立即删。
//
// 分模块：目标表在 targets.mts，出包前断言在 assert.mts，依赖物化与精简在 materialize.mts，
// 集成补丁覆盖在 overlays.mts，静态件压缩在 minify.mts；本文件是主流程（校验 → 组装 → zip）。
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ZipArchive } from "archiver";

import fs from "fs-extra";

import { errText } from "../../shared/err-text.mts";
import { ROOT } from "../../shared/root.mts";
import { assertCordisDistVersions, assertProductPackage, assertUiTree } from "./assert.mts";
import { declareInstallationPlugins } from "./bundle-deps.mts";
import { STAGING_ROOT, materializeProdDeps } from "./materialize.mts";
import { minifyDistStatics } from "./minify.mts";
import { applyIntegrations } from "./overlays.mts";
import { failUsage, targetSpec } from "./targets.mts";

// 版本单一事实源：package.json（唯一来源，不支持命令行传版本——显式传版本容易与
// manifest 不同步（历史教训）；版本同步走 pnpm version 发版流程，scripts/release/version.mts 收口）
const repoPkg = fs.readJsonSync(join(ROOT, "package.json"));
const version = repoPkg.version;
if (!version) throw new Error("package.json version 缺失");
// 防回归：版本一致性强制校验（历史曾手改只 bump package.json，manifest.json version 停在
// 旧值，发布包内版本与 tag 不一致）。打包版本必须同时等于 manifest.json 的 version。
const manifestVersion = fs.readJsonSync(join(ROOT, "src", "manifest.json")).version;
if (version !== manifestVersion)
  throw new Error(
    `版本不一致：package.json ${version} ≠ manifest.json ${manifestVersion}（manifest 未同步，跑 node scripts/derive/index.mts 同步后再打包）`,
  );

// 1. 静态项复制进 dist —— dist 即完整交付目录（bundle + manifest + skills + cordis 插件），
//    包根结构 = 标准插件形态（根 index.js + routes/ 壳，无 dist 这层目录）。
//    app/（card.js/css 已 asset/source 内联进 bundle）与 routes/（壳由 build 生成）不再复制。
const staticItems = [
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  // manifest.json 与 skills 已随 src 域（src/manifest.json、src/skills/，build:src 产出
  // dist 副本），不再经根级静态复制
  // 注：package.json 也不在清单里：仓库那份带 scripts/devDependencies/packageManager/imports
  // （构建入口），交付面那份（packaging/package.json，单独复制）才是包根要的——见 packaging/README.md。
  // 注：pnpm-workspace.yaml / pnpm-lock.yaml 不随包——安装侧不执行任何 pnpm install
  // （依赖已物化进包），两份文件在本流程里没有消费方
];
const distDir = join(ROOT, "dist");
for (const item of staticItems) {
  const src = join(ROOT, item);
  if (!fs.pathExistsSync(src)) throw new Error(`静态项不存在：${item}`);
  // dereference: true —— 历史为内置 pnpm 的符号链接复制（node_modules/pnpm →
  // .pnpm/pnpm@…/node_modules/pnpm，zip 内置 pnpm）；现版本起 pnpm 改运行时引导
  // （tools/lib/pnpm.js ensurePnpm 下载单文件到数据目录 pnpm-dist/），不再打包
  // node_modules/pnpm——其余静态项（NOTICE/package.json/manifest/pnpm-workspace/
  // pnpm-lock/skills）均为真实实体，dereference 恒为 no-op，保留无害。
  fs.copySync(src, join(distDir, item), {
    dereference: true,
    filter: (srcPath) => {
      if (srcPath.includes("node_modules/.bin")) return false;
      if (/__tests__|\.test\.|\.spec\./.test(srcPath)) return false;
      return true;
    },
  });
}

// 1.2) 交付树的 package.json：复制 packaging/package.json（手写实体，只有 version 由 derive 的
//      product-package 任务同步；不复制仓库根那份——它是构建入口，见 packaging/README.md）。
//      字段白名单与版本一致由下面的 assertProductPackage 把关。
fs.copySync(join(ROOT, "packaging", "package.json"), join(distDir, "package.json"));

// 1.5 / 1.6) 产物断言：cordis 包版本与完整性、交付树 package.json、App ui/ 静态树（缺失即拒包）
assertCordisDistVersions(distDir, version);
assertProductPackage(distDir, version);
assertUiTree(distDir);

// 目标选择：`--target <名字>`（必须显式给，无默认）。
// 用 node:util 的 parseArgs 结构化解析（strict + 禁位置参数）：未知选项、缺值、多余位置参数
// 由它直接报错，不再手写字符串扫描——上一版手扫以 startsWith("--target") 判「认识的参数」，
// 把 `--targets=x` 漏成了合法值，静默回落跑了一整次通用包。
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

// 2. 静态资产压缩（terser JS 纯语法级，覆盖写回 dist 副本）
await minifyDistStatics(distDir);

// 3+4) 组装 → zip → SHA256（单目标；发布产物归档 releases/）
//    archiver 纯 Node 跨平台 zip（对齐 hana-remote-dev）：不用 tar -a -cf——
//    GNU tar（Linux）不认 .zip 后缀会静默产出 tar 伪 zip
const relDir = join(ROOT, "releases");
fs.ensureDirSync(relDir);
// 临时目录纪律（曾因多目标连跑堆积 2.2 GB 把宿主压崩）：
//   · 起手清残留（上次运行/中途崩溃留下的）；
//   · 用完即清（暂存树 + 铺平目录）；
//   · 收尾全清由 package.json 的 postpackage 钩子承担（scripts/release/clean-tmp.mts），CI 里也可单独调。
// 中间原料与暂存树都可再生，真正的产物只有 releases/ 下的 zip + sha256。
const pkgRoot = join(ROOT, "_tmp", "pkg");
for (const stale of [pkgRoot, STAGING_ROOT]) fs.removeSync(stale);
{
  const modules = materializeProdDeps(spec);
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
  // @dshana 子插件落进安装树的 node_modules（与 @deepseek-ai/* 同锚点）：DSH 的 runtime 解析模式
  // 从安装树 + bundle 依赖图算解析代、不建链接，所以插件不能住在 cordis/ 那种安装树外的位置。
  // dist/ 那份原样拷贝已在包根留下 cordis/，这里把它换成 node_modules/@dshana/。
  // roster patch（dist/cordis.patch.yml）已随 dist 复制到包根，runtime 经 patchFiles 传它。
  const cordisDist = join(distDir, "cordis");
  if (!fs.pathExistsSync(cordisDist)) throw new Error("dist/cordis 缺失：先跑 pnpm run build 再打包");
  fs.removeSync(join(pkgDir, "cordis"));
  fs.copySync(cordisDist, join(pkgDir, "node_modules", "@dshana"));
  for (const rel of ["cordis.patch.yml", join("node_modules", "@dshana", "provider", "index.js")]) {
    if (!fs.pathExistsSync(join(pkgDir, rel))) throw new Error(`包内产物缺失：${rel}（拒绝出包）`);
  }
  console.log("[pack] @dshana 子插件落进 node_modules/@dshana，包根不再有 cordis/")
  // 只躺在 node_modules 里不够：DSH 按「安装树 + 被选中 bundle 的依赖图」算解析代，真机上
  // profile 在数据目录里向上解析走不到安装树，得由被选中 bundle 认领才进解析代（见 bundle-deps.mts）。
  declareInstallationPlugins(join(pkgDir, "node_modules"));
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
  // 第二参数必须为 false：把 pkgDir 的**内容**放在 zip 根。
  // 曾写成 archive.directory(pkgDir, base)，于是整包被套进一层 `<base>/`，宿主安装时在包根读
  // manifest.json 读不到（manifest.json 落在 `<base>/manifest.json`），报 INVALID_MANIFEST 拒绝安装：
  //   宿主校验器 `validate-app.mjs --archive <zip>` 会明确判 "ENOENT ... '<app>\\manifest.json'"。
  // 参照物：装得上的样例包 zip 根级就是 manifest.json / node_modules / ui / dist。
  archive.directory(pkgDir, false);
  await archive.finalize();
  await done;
  fs.moveSync(tmpZip, zipPath, { overwrite: true });
  const buf = fs.readFileSync(zipPath);
  const sha = createHash("sha256").update(buf).digest("hex").toUpperCase();
  console.log(`[pack] ${zipPath}`);
  console.log(`[pack] zip ${(buf.length / 1048576).toFixed(1)} MB · SHA256 ${sha}`);
  fs.writeFileSync(`${zipPath}.sha256`, sha, "utf8");
  // 铺平目录已入包，即用即清
  fs.removeSync(pkgDir);
}
// 收尾全清 → postpackage 钩子（scripts/release/clean-tmp.mts）
