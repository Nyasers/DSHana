// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/assert.mts — 出包前的断言（产物不完整就拒包）+ 包根铭牌的产出。
//
// 都在 fail-closed 一侧：宁可不出包，也不出一个装了起不来的包。
import fs from "fs-extra";
import { join } from "node:path";

import { deltaContentHash } from "../../integrations/delta.mts";
import { patchVersionOf } from "../../shared/version.mts";
import { readBuildRecipe } from "../package-set.mts";
import { readIntegrationDecls } from "./stamp.mts";

/**
 * 交付树 package.json 允许出现的键（**铭牌形状**，T3 起物化输入走包集清单，不再读这份）。
 *
 * 为什么不留 dependencies：那份声明曾是安装输入（工位按它跑 pnpm install）。换源后物化输入由
 * packaging/dsh-package-set.json 派生，包根这份 dependencies 没有任何消费方——留着只会让人以为
 * 「改这里能换依赖」。装机侧不跑 pnpm，所以铭牌只需回答「是什么、什么版本」。
 * DSH pin 也随之迁到根 package.json#devDependencies（那份历来就有，且有一致性闸守着）。
 *
 * 三处来源：name / type 手写（packaging/package.json 实体），version 由 derive 的 product-package 任务同步。
 */
export const PRODUCT_PACKAGE_KEYS = ["name", "type", "version"];

/**
 * 交付树 package.json 校验：字段白名单（**写死**）+ 版本一致 + type: module + name 固定。
 *
 * 白名单是精确的（键集合必须逐字相等），不是「允许子集」：放宽成「任意 package.json 都行」会让
 * 构建面字段（scripts / devDependencies / packageManager）悄悄进包。
 *
 * @param outDir - 交付目录（dist 或组装树）
 * @param version - 本次出包的版本
 */
export function assertProductPackage(outDir, version) {
  const p = join(outDir, "package.json");
  if (!fs.pathExistsSync(p)) {
    throw new Error("交付树的 package.json 缺失（铭牌未写入）：拒绝出包");
  }
  const j = fs.readJsonSync(p);
  const keys = Object.keys(j).sort();
  const allowed = [...PRODUCT_PACKAGE_KEYS].sort();
  const extra = keys.filter((k) => !allowed.includes(k));
  const missing = allowed.filter((k) => !keys.includes(k));
  if (extra.length || missing.length) {
    throw new Error(
      "交付树 package.json 字段不对：只允许 " + allowed.join("/") +
        "（多出 " + (extra.join("/") || "无") + "，缺 " + (missing.join("/") || "无") + "）——构建面字段不进安装包",
    );
  }
  if (j.name !== "dshana") {
    throw new Error('交付树 package.json name 必须是 "dshana"（实际 ' + String(j.name) + "）");
  }
  if (j.version !== version) {
    throw new Error(
      "交付树 package.json version " + String(j.version) + " ≠ 本次出包版本 " + version + "（跑 node scripts/derive/index.mts 同步后再打包）",
    );
  }
  if (j.type !== "module") {
    throw new Error('交付树 package.json 必须 type: "module"（包根 index.js 是 ESM，缺了它宿主按 CommonJS 解析）');
  }
}

/**
 * cordis 子插件包 version 一致性校验（防回归，与 manifest 校验对称）：子插件（provider /
theme / clipboard）version 与主 package.json 同批由 derive/version（pnpm version 发版流程）
同步，pack 时读 dist 产物校验一致——手改/漏同步即出包版本漂移。
 * roster patch（dist/cordis.patch.yml）不是包，只校验在位。
 */
export function assertCordisDistVersions(outDir, version) {
  const cordisRoot = join(outDir, "cordis");
  // cordis 未组装 = 构建未跑/被清：fail-closed（校验放行空产物会让缺插件的包过包）
  if (!fs.pathExistsSync(cordisRoot)) {
    throw new Error("cordis 产物缺失（dist/cordis 不存在）：先跑 pnpm run build 再打包");
  }
  if (!fs.pathExistsSync(join(outDir, "cordis.patch.yml"))) {
    throw new Error("roster patch 缺失（dist/cordis.patch.yml 不存在）：先跑 pnpm run build 再打包");
  }
  // 完整性：子插件全部存在且 package.json 版本一致——缺失/部分产物（含 count=0）
  // 一律拒包，防 build 失败后残留部分 dist 被误打包。
  const required = [
    "clipboard", "provider", "theme",
  ];
  let count = 0;
  for (const name of required) {
    const pj = join(cordisRoot, name, "package.json");
    if (!fs.pathExistsSync(pj)) {
      throw new Error(
        `cordis 产物不完整：缺少 ${name}/package.json（dist/cordis 下）——先跑 pnpm run build 再打包`,
      );
    }
    const j = fs.readJsonSync(pj);
    if (j.version !== version) {
      throw new Error(
        `版本不一致：cordis 包 ${join("cordis", name, "package.json")} version ${j.version} ≠ package.json ${version}（跑 node scripts/derive/index.mts 同步后再打包）`,
      );
    }
    count += 1;
  }
  console.log(`[pack] cordis 子插件版本一致（${count} 个 = ${version}）+ roster patch 在位`);
}

/** App ui/ 静态树断言（cards route 资源面；相对资源契约）：缺失 = 卡片 404，拒包。 */
export function assertUiTree(outDir) {
  const uiDir = join(outDir, "ui");
  if (!fs.pathExistsSync(uiDir)) {
    throw new Error("App ui/ 静态树缺失（dist/ui 不存在）：src/ui 未随 build 拷贝——先跑 pnpm run build 再打包");
  }
  for (const rel of ["main.html", "sidebar.html", "app-shell.js"]) {
    if (!fs.pathExistsSync(join(uiDir, rel))) {
      throw new Error("App ui/ 缺 cards route 资源：" + rel + "（src/ui/" + rel + " 缺失或构建未跑）");
    }
  }
  console.log("[pack] ui/ 静态树完整（main/sidebar 壳页 + app-shell.js bundle）");
}

/**
 * **版本式子**（纯函数，T5 的硬约束①）：包内每个闭包包都满足
 *
 *   集成目标：version == `<清单版本>+dshana-<干净版本>`
 *   其余　　：version == 清单版本
 *
 * 为什么要有这道闸：T5 之前集成目标靠 pack 期覆盖 node_modules，交付树与清单在那 11 个包上本就
 * 不一致，只能"观察到"它们恰好等于集成目标。现在 delta 在构建期进产物、戳在 pack 期一处写，
 * 于是这句话是一条**可判定的式子**——写得进 assert，就挡得住"戳没盖""盖错""清单换了而戳没跟"
 * 这类漂移，不用靠人眼比对数。
 *
 * 为什么"其余包"也要判：只判集成目标会漏掉另一种漂移——某个普通包的版本被构建侧的什么改动
 * 带偏了。式子两侧都判，才是"交付树 = 清单闭包 + 已声明的戳"的完整表述。
 *
 * 为什么是纯函数：让判据可单测（两个分支各造一份数据即可），与 memoryGuardError 同一路子。
 * 判据与写入共用 shared/version.mts#patchVersionOf——"写了却判不过"或反过来的假绿灯都因此不可能。
 *
 * @param installed - 物化树里**清单内**的包（name/version）；清单外的 registry 三方包不在此列。
 * @param manifestVersions - 包集清单的 name -> version。
 * @param integrationTargets - 集成目标的包名集合。
 * @param appVersion - 我们的版本（主 package.json#version）。
 * @returns 差异描述（空数组 = 式子成立）。
 */
export function versionEquationError(installed, manifestVersions, integrationTargets, appVersion) {
  const problems: string[] = [];
  for (const pkg of installed) {
    const upstream = manifestVersions.get(pkg.name);
    if (upstream === undefined) continue; // 清单外的包不属本式子的作用域（由 verifyMaterializedModules 报）
    const isTarget = integrationTargets.has(pkg.name);
    const want = isTarget ? patchVersionOf(upstream, appVersion) : upstream;
    if (pkg.version !== want) {
      problems.push(
        `  - ${pkg.name}@${pkg.version} ≠ ${want}` +
          (isTarget ? "（集成目标：应为 <清单版本>+dshana-<干净版本>）" : "（非目标：应逐字等于清单版本）"),
      );
    }
  }
  return problems;
}

/**
 * 版本式子的**驱动**：从物化树里读出清单内的包，交给 versionEquationError 判定，不过就拒包。
 *
 * 只读清单内的包（与 verifyMaterializedModules 同一作用域口径）：清单是"可发布的全部 318 个"，
 * 其中测试工具包不在生产闭包里、本就不该出现；而 registry 三方包（@deepseek-ai/cordis 一族）
 * 不在我们的包集里，不参与这条式子。
 *
 * @param modules - 组装台里的 node_modules。
 * @param set - 包集清单。
 * @param appVersion - 我们的版本。
 * @param integrationsDir - src-integrations 目录（集成目标从声明来，不从清单的类别猜）。
 * @returns 判定过的包数（清单内且已安装）。
 */
export function assertVersionEquation(modules, set, appVersion, integrationsDir) {
  const manifestVersions = new Map(set.packages.map((p) => [p.name, p.version]));
  const targets = new Set(readIntegrationDecls(integrationsDir).map((d) => d.packageName));
  const scopeDir = join(modules, "@deepseek-ai");
  if (!fs.pathExistsSync(scopeDir)) throw new Error("物化树里没有 @deepseek-ai/ 作用域：" + scopeDir);
  const installed: Array<{ name: string; version: string }> = [];
  for (const entry of fs.readdirSync(scopeDir)) {
    const manifestPath = join(scopeDir, entry, "package.json");
    if (!fs.pathExistsSync(manifestPath)) continue;
    const name = "@deepseek-ai/" + entry;
    if (!manifestVersions.has(name)) continue; // 清单外（registry 三方包）
    installed.push({ name, version: fs.readJsonSync(manifestPath).version });
  }
  const problems = versionEquationError(installed, manifestVersions, targets, appVersion);
  if (problems.length) {
    throw new Error(
      `交付树版本式子不成立（${problems.length} 个包，拒绝打包）：\n` +
        problems.join("\n") +
        "\n集成目标的戳由 pack 期 stamp.mts 写；其余包应逐字等于清单版本。" +
        "若清单换了版本，跑 node scripts/derive/index.mts 后重打。",
    );
  }
  return { checked: installed.length, targets: targets.size };
}

/**
 * **集成烘焙对账**（纯函数）：当前声明与"这份包集实际烤进去的 delta"是否同一份。
 *
 * 为什么需要它（这是 applyIntegrations 退场后 fail-closed 语义的关键一环）：delta 进了构建产物
 * 之后，pack 期不再有"声明的补丁必须全部盖上"这道现场检查——它挪到了构建期 stageDelta。但那样
 * 就出现一个新洞：**声明改了而包集没重编**。此时清单照旧指着旧缓存条目，pack 会拿一份"不含新
 * overlay"的产物出包，而且它的 sha512 还会替它背书。
 *
 * 所以这里把构建期的账（build-recipe.json 的 integrations）与当前 src-integrations 对拍：
 *   · deltaHash 必须等于现算的 delta 内容哈希（改了任一 overlay/声明 → 变）；
 *   · 声明里每个"有 overlay 的集成"都必须在账里，且 overlay 数一致（增删集成 → 变）。
 * 任一不符 = 这份包集不是对着当前 delta 编的 → 拒包，并说清"重编还是回滚"。
 *
 * @param declared - 当前 src-integrations 声明（readIntegrationDecls）。
 * @param baked - 构建期记的账（recipe.integrations；旧配方可能没有这个字段）。
 * @param currentDeltaHash - 现算的 delta 内容哈希（delta.mts#deltaContentHash）。
 * @returns 差异描述（空数组 = 对得上）。
 */
export function integrationBakeError(declared, baked, currentDeltaHash) {
  const problems: string[] = [];
  if (baked === undefined || baked === null) {
    problems.push("  - 这份包集的构建档案里没有 integrations 记录（旧配方？）：无法确认它烤的是哪版 delta");
    return problems;
  }
  if (baked.deltaHash !== currentDeltaHash) {
    problems.push(
      "  - 包集烤的 delta 与当前工作树不一致：档案 " + String(baked.deltaHash).slice(0, 12) +
        "… ≠ 现算 " + currentDeltaHash.slice(0, 12) + "…（改了 overlay/声明而没重编包集？）",
    );
  }
  const bakedList = Array.isArray(baked.packages) ? baked.packages : [];
  const bakedByDir = new Map(bakedList.map((p) => [p.dir, p]));
  for (const d of declared) {
    if (d.files === 0) continue; // 尚无 overlay：构建期也不算缺口（与 stageDelta 同口径）
    const got = bakedByDir.get(d.dir);
    if (got === undefined) {
      problems.push("  - 集成 " + d.dir + "（" + d.packageName + "）声明了 " + d.files + " 个 overlay，但构建档案里没有它——包集没含这次声明");
      continue;
    }
    if (got.package !== d.packageName) {
      problems.push("  - 集成 " + d.dir + " 的目标包：声明 " + d.packageName + " ≠ 档案 " + String(got.package));
    }
    if (got.files !== d.files) {
      problems.push("  - 集成 " + d.dir + " 的 overlay 数：声明 " + d.files + " ≠ 档案 " + String(got.files));
    }
  }
  for (const p of bakedList) {
    if (!declared.some((d) => d.dir === p.dir)) {
      problems.push("  - 构建档案里的集成 " + p.dir + " 已不在 src-integrations 里（声明删了而包集没重编？）");
    }
  }
  return problems;
}

/**
 * 集成烘焙对账的**驱动**：读这份包集的构建档案并与当前 src-integrations 对拍，不符即拒包。
 *
 * 需要 T1 缓存（readBuildRecipe）。这在 pack 里不是额外要求——materialize 的 verifyTarballs 本来就
 * 要从缓存条目取 tarball，没有它连物化都做不了。
 *
 * @param set - 包集清单（提供 build.cacheKey）。
 * @param integrationsDir - src-integrations 目录。
 * @returns 账里的集成数（日志用）。
 */
export function assertRecipeBakedCurrentDelta(set, integrationsDir) {
  const recipe = readBuildRecipe(set.build.cacheKey);
  const declared = readIntegrationDecls(integrationsDir);
  const problems = integrationBakeError(declared, recipe.integrations, deltaContentHash());
  if (problems.length) {
    throw new Error(
      "包集与当前集成声明不一致（拒绝打包，先 node scripts/vendor/build.mts 重编或回滚声明）：\n" +
        problems.join("\n"),
    );
  }
  const baked = recipe.integrations;
  return { packages: Array.isArray(baked.packages) ? baked.packages.length : 0, stagedFiles: baked.stagedFiles };
}
/** 同步睡一会（打包脚本内部的顺序流程，不用事件循环）。 */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * 物化完成后先确认集成目标包齐备，再进组装。物化是外部进程（pnpm），它退出与文件完全落盘
 * 之间有时差；没有这道闸时，残树会一路跑到覆盖阶段才报“物化树里没有 px”，看起来像是集成层的问题。
 * 有界等待（≤30s）只是给那个时差留窗口，等了还是缺就是真的缺，当场失败并点名。
 */
export function assertIntegrationTargets(modules, integrationsDir) {
  // 声明读取与 stamp.mts 同一份实现（readIntegrationDecls）：两处各写一份，改了格式就会一处认得、
  // 一处认不得——那种不一致比"多一层 import"贵得多。
  const targets = readIntegrationDecls(integrationsDir);
  const missingOf = () => targets.filter((t) => !fs.pathExistsSync(join(modules, t.packageName, "package.json")));
  let missing = missingOf();
  if (missing.length > 0) {
    console.log(`[pack] 等物化落盘（缺 ${missing.length} 个集成目标包，最多等 30s）…`);
    const deadline = Date.now() + 30000;
    while (missing.length > 0 && Date.now() < deadline) {
      sleepSync(1000);
      missing = missingOf();
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `物化树缺少集成目标包（${missing.length}/${targets.length} 个，拒绝打包）：\n  - `
      + missing.map((t) => t.packageName).join("\n  - "),
    );
  }
  return targets.length;
}
