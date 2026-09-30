// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/index.mts — dshana 自包含打包（适配单 bundle 收敛架构；构建脚本不随源码编译）
// 交付物 = 代码 bundle（dist/）+ cordis 插件 + ui/ 静态树 + **物化后的生产依赖树**
// （含 win32/darwin/linux × x64/arm64 预编译资产），安装即用、无需 npm install。
// 依赖物化形态对齐样例 hana-dsh：hoisted 布局（顶层真实目录、无软链接——软链进 zip 跨机
// 解压即断）。物化的安装发生在 .cache/pkg-root/<键>（缓存节点，不触碰仓库 node_modules、与
// target 无关），组装台在 .tmp/pkg/。
// 流程：复制交付清单（prepackage 钩子已先行 build）→ 从物化节点拷进组装台并按目标剪枝 →
// 断言多平台资产 → zip → SHA256。
// 用法：pnpm run package --target <名字>（prepackage 自动前置 build；单独 node scripts/release/pack/index.mts 要求 dist/ 已构建）
// 产出：releases/dshana-v<version>[-<target>].zip + .sha256。**zip 根 = 包根**：manifest.json、
//   index.js、node_modules/、ui/ 等全部在 zip 根级，不得套一层目录（宿主安装时在包根读 manifest.json）。
// 两处中间产物的分工（口径见 DESIGN.md：\`.cache/\` 住带键可复用的，\`.tmp/\` 住每次重来的草稿）：
//   · .cache/pkg-root/<键>：依赖**物化节点**。装一次全叉乘超集，键不含 target（见 materialize.mts），
//     各目标共用；命中即复用，不重装。隔离在缓存区，仓库自身的 node_modules 与锁文件不被污染。
//   · .tmp/pkg：交付**组装台**。只放要进包的东西（dist/ + 物化依赖树剪枝后 + cordis + ui + manifest），
//     不带 pnpm 的中间物（lockfile、workspace yaml、.modules.yaml 这些是构建输入，不是交付物）。
//     把「物化节点」与「组装台」分开，就是不让构建输入混进安装包；组装出包后立即删。
//
// 分模块：目标表在 targets.mts，出包前断言在 assert.mts，依赖物化与精简在 materialize.mts，
// 我们自己的 bundle 的闸在 app-bundle.mts，集成版本戳在 stamp.mts，静态件压缩在 minify.mts；
// 本文件是主流程（校验 → 组装 → zip）。
//
// 集成层在 T5 的落点（别在这里找"覆盖补丁"那一步，它没有了）：delta 在**构建期**铺进 scratch 检出、
// 烤进产物（scripts/integrations/delta.mts）；pack 期只剩两件事——盖版本戳（stamp.mts）与对账式子
// （assert.mts 的 assertVersionEquation / assertRecipeBakedCurrentDelta）。
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ZipArchive } from "archiver";

import fs from "fs-extra";

import { errText } from "../../shared/err-text.mts";
import { ROOT } from "../../shared/root.mts";
import { extractTar } from "../../vendor/tar-extract.mts";
import { readPackageSet, assertRootSetMatchesManifest } from "../package-set.mts";
import { assertDeliveryPnpmVersion, assertLockfilesUnchanged, assertPnpmChainsUnified, lockfileSnapshot, readPnpmDeclaration } from "../pnpm.mts";
import { assertAppBundle } from "./app-bundle.mts";
import { assertAppEntryLayout, assertCordisDistVersions, assertProductPackage, assertRecipeBakedCurrentDelta, assertUiTree, assertVersionEquation } from "./assert.mts";
import { MATERIALIZE_ROOT, materializeProdDeps } from "./materialize.mts";
import { minifyDistStatics } from "./minify.mts";
import { stampIntegrationVersions } from "./stamp.mts";
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
  // （构建入口），包根要的那份铭牌由 derive 的 product-package 任务从根 package.json 派生。
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

// 1.2) 交付树的 package.json：**铭牌**，不是安装输入（T3 换源后物化输入由包集清单派生，见
//      materialize.mts / install-source.mts）。它只回答「这包是什么、什么版本」，装机侧不跑 pnpm，
//      所以只留 name / type / version 三个键（原来的 dependencies 声明已迁走——pin 现住根
//      package.json#devDependencies）。
//      字段白名单按这个新形状**写死并断言**（assertProductPackage），不放宽成「任意 package.json」。
//      内容整份由 derive 的 product-package 任务从根 package.json 派生（源文件 src/product-package.json，
//      不再有手写实体）；这里把它作为包根 package.json 复制进交付树。dist 每次 build 被清空，
//      所以不能把派生目标放 dist——先派生、再由 pack 组装。
const productManifestSource = join(ROOT, "src", "product-package.json");
if (!fs.pathExistsSync(productManifestSource)) {
  throw new Error("包根铭牌源缺失（src/product-package.json）：先跑 node scripts/derive/index.mts product-package");
}
fs.copySync(productManifestSource, join(distDir, "package.json"));

// 1.5 / 1.6) 产物断言：cordis 包版本与完整性、交付树 package.json、App ui/ 静态树（缺失即拒包）
assertCordisDistVersions(distDir, version);
assertProductPackage(distDir, version);
assertUiTree(distDir);
assertAppEntryLayout(distDir);
// 1.7) 包集闸：根集在构建期现算（上游 app-boot 的 dshana 模板 ∪ OPTIONAL_BUNDLES ∪ @dshana/*），
//      与缓存条目里的清单比对。上游改了名单而清单没跟，出包前就在这里断。
await assertRootSetMatchesManifest();

// 1.8) 集成烘焙对账：这份包集烤的 delta 必须就是当前 src-integrations 的 delta。
//      delta 进构建产物后，"声明的补丁全部盖上"这道现场检查挪到了构建期（delta.mts#stageDelta），
//      于是留下新洞：声明改了而包集没重编。这里把构建期的账与当前声明对拍，堵住它。
//      放在物化之前：对不上就该在花掉一次安装之前停。
const manifestSet = readPackageSet();
if (manifestSet === null) {
  throw new Error("找不到缓存条目里的 dsh-package-set.json：先跑 node scripts/derive/index.mts package-set");
}
const baked = assertRecipeBakedCurrentDelta(manifestSet, join(ROOT, "src-integrations"));
console.log("[pack] 集成烘焙对账：档案 " + baked.packages + " 个集成 / " + baked.stagedFiles + " 个文件，与当前声明一致");

// 1.9) pnpm 的两道闸（都在物化之前：版本不对就该在花掉一次安装之前停）：
//      ① 各自自洽——交付链**实际**解析到的版本 == 本仓 packageManager 声明的那一份（不是「手边那份」）；
//      ② 跨链统一——它 == 清单里构建链用的那份（build.pnpm，检出/vendor 的上游 pin）。
//      ② 是「统一」的**被检查不变量**：上游 pin 一动、本仓声明也得跟，否则在这里被拒（代价写在
//      assertPnpmChainsUnified 的注释里）。放在这份清单读出来之后——对账要用它。
//      同时取锁文件基线：整条 pack 跑完，仓根那份必须原样（派生的交付锁住缓存区、归 derive 写）。
const deliveryPnpm = assertDeliveryPnpmVersion();
const unifiedPnpm = assertPnpmChainsUnified(manifestSet.build.pnpm, deliveryPnpm);
const packLockBaseline = lockfileSnapshot();
console.log(
  "[pack] pnpm 统一：构建链 " + unifiedPnpm + "（清单 build.pnpm）== 交付链 " + deliveryPnpm +
    "（本仓声明 " + readPnpmDeclaration().version + "）；锁文件基线已取",
);

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
//   · 用完即清（铺平目录）；收尾全清由 package.json 的 postpackage 钩子承担
//     （scripts/release/clean-tmp.mts），CI 里也可单独调。
// 真正的产物只有 releases/ 下的 zip + sha256。
//
// 依赖树**不在**这里再装一次：物化是一个与 target 无关的缓存节点（.cache/pkg-root/<键>，
// 见 materialize.mts），各目标只是把它拷进组装台再就地剪枝。
const pkgRoot = join(ROOT, ".tmp", "pkg");
fs.removeSync(pkgRoot);
fs.removeSync(join(ROOT, ".tmp", "pkg-root")); // 旧形态（逐目标工位）的残留，只清不建
{
  // 命名：通用包无后缀（既有 CI/脚本按 dshana-v<ver>.zip 取件），平台包带目标后缀
  const base = spec.name === "universal" ? `dshana-v${version}` : `dshana-v${version}-${spec.name}`;
  const pkgDir = join(pkgRoot, base); // 组装暂存目录（内容原样进 zip 根，此目录名不出现在包里）
  fs.removeSync(pkgDir);
  fs.copySync(distDir, pkgDir);
  // 依赖树从物化节点拷进组装台并就地按本目标剪枝（物化节点本身保持完整，下一个目标照旧从它剪）。
  materializeProdDeps(spec, pkgDir);
  // T5：pack 期不再覆盖任何内容（delta 已在构建期进产物）。只盖版本戳——`<清单版本>+dshana-<干净版本>`，
  // 由清单版本算出（见 stamp.mts 与 shared/version.mts#patchVersionOf）。
  const stamped = stampIntegrationVersions(join(pkgDir, "node_modules"), manifestSet.packages, version, join(ROOT, "src-integrations"));
  console.log("[pack] 集成版本戳：" + stamped.length + " 个目标 → <清单版本>+dshana-" + version.split("+")[0]);
  // 式子闸：交付树 = 清单闭包 + 已声明的戳（集成目标带戳、其余逐字等于清单版本）。这是**断言**不是观察。
  const equation = assertVersionEquation(join(pkgDir, "node_modules"), manifestSet, version, join(ROOT, "src-integrations"));
  console.log("[pack] 版本式子成立：" + equation.checked + " 个闭包包（其中集成目标 " + equation.targets + " 个带戳）");
  // @dshana 一族落进安装树的 node_modules（与 @deepseek-ai/* 同锚点）：DSH 的 runtime 解析模式
  // 从安装树 + bundle 依赖图算解析代、不建链接，所以它们不能住在 cordis/ 那种安装树外的位置。
  // dist/ 那份原样拷贝已在包根留下 cordis/，这里把它换成 node_modules/@dshana/。
  // 含我们自己的 bundle @dshana/app：dshana 预设的 bundles 末层点它，profile 的层解析按安装树锚点
  // 找它、按它的 dependencies 把 @dshana/* 子插件带进解析代（所以不再需要改上游 web-app 的 manifest）。
  const cordisDist = join(distDir, "cordis");
  if (!fs.pathExistsSync(cordisDist)) throw new Error("dist/cordis 缺失：先跑 pnpm run build 再打包");
  fs.removeSync(join(pkgDir, "cordis"));
  fs.copySync(cordisDist, join(pkgDir, "node_modules", "@dshana"));
  for (const rel of [
    join("node_modules", "@dshana", "app", "package.json"),
    join("node_modules", "@dshana", "app", "cordis.patch.yml"),
    join("node_modules", "@dshana", "provider", "index.js"),
  ]) {
    if (!fs.pathExistsSync(join(pkgDir, rel))) throw new Error(`包内产物缺失：${rel}（拒绝出包）`);
  }
  // 旧形态的负向：包根不该再有 cordis.patch.yml（那是启动器 overlay，已被 @dshana/app 取代）。
  if (fs.pathExistsSync(join(pkgDir, "cordis.patch.yml"))) {
    throw new Error("包根还有 cordis.patch.yml：启动器 overlay 形态已退场（行变更住 node_modules/@dshana/app/cordis.patch.yml）");
  }
  console.log("[pack] @dshana 子插件与 bundle @dshana/app 落进 node_modules/@dshana，包根不再有 cordis/ 与 cordis.patch.yml")
  // @hana/app-sdk 随包：受管 runtime 把它当**外部依赖**（不再构建期内联），运行时从安装树
  // 的 node_modules/@hana/app-sdk 解析。它是我们 vendored 的官方 SDK 包（Apache-2.0，见
  // THIRD_PARTY_NOTICES.md），与 DSH 包集、@dshana/* 同一路子：依赖随包物化，安装即用。
  // 包本身只依赖 node:crypto（无运行时包解析），所以解出来放到位就够了。
  const sdkTgz = join(ROOT, "vendor", "hana-app-sdk", "hana-app-sdk.tgz");
  if (!fs.pathExistsSync(sdkTgz)) throw new Error("vendored SDK 缺失：" + sdkTgz + "（拒绝出包）");
  const sdkTmp = join(pkgDir, ".sdk-unpack");
  fs.removeSync(sdkTmp);
  extractTar(sdkTgz, sdkTmp);
  const sdkRoot = join(sdkTmp, "package");
  if (!fs.pathExistsSync(join(sdkRoot, "package.json"))) throw new Error("vendored SDK 的 tar 不是 package/ 根结构（拒绝出包）");
  fs.removeSync(join(pkgDir, "node_modules", "@hana", "app-sdk"));
  fs.moveSync(sdkRoot, join(pkgDir, "node_modules", "@hana", "app-sdk"));
  fs.removeSync(sdkTmp);
  for (const rel of [join("node_modules", "@hana", "app-sdk", "package.json")]) {
    if (!fs.pathExistsSync(join(pkgDir, rel))) throw new Error("包内产物缺失：" + rel + "（拒绝出包）");
  }
  console.log("[pack] @hana/app-sdk 随包落 node_modules/@hana/app-sdk（受管 runtime 的外部依赖）");
  // 只躺在 node_modules 里不够：DSH 按「安装树 + 被选中 bundle 的依赖图」算解析代，真机上
  // profile 在数据目录里向上解析走不到安装树，得由被选中 bundle 认领才进解析代。
  // 认领者就是我们自己的 @dshana/app——它的 dependencies 里写了那三个子插件（随源码一份），
  // 所以这里不需要再改上游 web-app 的 manifest（bundle-deps.mts 已退场）。
  const appBundle = assertAppBundle(join(pkgDir, "node_modules"), join(ROOT, "vendor", "deepseek-harness"));
  console.log(
    "[pack] @dshana/app：认领随包插件 " + appBundle.claimed.length + " 个（" + appBundle.claimed.join(", ") + "）" +
      "· 覆盖官方行 " + appBundle.overridden.length + " 条（" + appBundle.overridden.join(", ") + "）" +
      "· insert 行 " + appBundle.named.length + " 条——声明与落点都对得上",
  );
  console.log(`[pack] ${spec.name}：代码 + 依赖树已就位（${base}）`);
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
  // 铺平目录已入包，即用即清（物化节点是缓存，留着给下一个目标复用）
  fs.removeSync(pkgDir);
  // 1.10) 锁文件护栏收尾：整条交付链跑完，仓根那份必须一字未动。
  //       历史上正是「pnpm 被隐式自换、目标落到仓里」把仓根锁文件改掉的；这道闸让那种事当场可见。
  //       （派生出来的交付锁住缓存区、本来归 derive 写，故不在护栏内。）
  assertLockfilesUnchanged(packLockBaseline, "pack " + spec.name);
  console.log("[pack] 仓根锁文件未动（pnpm-lock.yaml）");
}
// 收尾全清 → postpackage 钩子（scripts/release/clean-tmp.mts）
