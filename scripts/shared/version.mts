// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/shared/version.mts — 版本域共享模块（release/version、derive、changelog 复用）
// 布局原则：跨脚本共享/流程性构件放 scripts/shared/，领域特有随各自域或源码（src-cordis/build）。
// 提供 cordis 包清单（src-cordis 顶层 roster bundle + plugins/*）与派生同步目标
// （manifest + cordis 包）——版本号两个写手各管一段：主号归 `pnpm version`（唯一入口），
// build metadata 段（`+dsh-…`）归 derive 从 DSH pin 派生（见
// scripts/derive/version-metadata.mts；pin 现住根 package.json#devDependencies，见下；
// 派生同步见 scripts/derive/index.mts，git 收口见 scripts/release/version.mts）。
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./root.mts";

export { ROOT };

// \`@dshana/*\` 包清单（相对 ROOT；随我们整体发版，不独立发布）。
//
// 两种形状，别混：子插件是 \`src-cordis/plugins/<名>/package.json\`（plugins 下每个子目录一个包），
// 我们自己的 bundle 是 \`src-cordis/app/package.json\`（app 这个目录**本身就是**包，不是容器）。
// 行的变更住 bundle 里的 cordis.patch.yml（不是包），不在这里。
//
// 这份清单是"@dshana 一族是谁"的唯一真源：包集根集（scripts/release/package-set.mts）与版本同步
// 目标都读它——两处各写一份列举，迟早会出现一处认得新包、另一处不认。
export function dshanaPackageManifestRels() {
  const out: string[] = [];
  const plugins = path.join(ROOT, "src-cordis", "plugins");
  for (const name of fs.readdirSync(plugins)) {
    const p = path.join(plugins, name);
    if (!fs.statSync(p).isDirectory()) continue;
    const pj = path.join(p, "package.json");
    if (fs.existsSync(pj)) out.push(path.relative(ROOT, pj));
  }
  const appManifest = path.join(ROOT, "src-cordis", "app", "package.json");
  if (fs.existsSync(appManifest)) out.push(path.relative(ROOT, appManifest));
  return out.sort();
}

/** \`@dshana/*\` 包的 package.json 清单（相对 ROOT）；\`dshanaPackageManifestRels\` 的旧名。 */
export const cordisPkgPaths = dshanaPackageManifestRels;

// 派生同步目标（随主版本同步的文件）：src/manifest.json（src 域构件）+ src/product-package.json
//（交付树包根铭牌，derive 的 product-package 任务）+ @dshana 包（不含主 package.json——主是事实源，
// 由 bump 阶段改；这里指"跟随"它的文件）
export function derivedVersionTargets() {
  return ["src/manifest.json", "src/product-package.json", ...cordisPkgPaths()];
}

// 版本文件全集（含主 package.json——version-hook 提交范围用：pnpm version 已改主待收口）
export function versionCommitFiles() {
  return ["package.json", ...derivedVersionTargets()];
}

export const readPkg = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
export const writePkg = (p, data) => {
  fs.writeFileSync(path.join(ROOT, p), JSON.stringify(data, null, 2) + "\n", "utf8");
};

// 干净号（去 build metadata）：1.0.0-beta.5+dsh-0.1.5-rc.2 → 1.0.0-beta.5。
// 补丁包版本戳要用它（版本串里不能再嵌一个 "+"），所以与 derive/version-hook 同处一份实现。
export function cleanVersion(version) {
  return String(version).split("+")[0];
}

// 补丁包（集成覆盖产物）版本戳：<上游版本>+dshana-<主干净版本>。
// 形状与主版本互镜：主版本带上游 DSH 版本，补丁包带我们的版本，两侧互相点名。
// 版本段只有一个来源——主 package.json（与 derive/version-hook 同一份实现）；
// 不另设修订号：同一版本里改两次覆盖层应当由发版流程 bump 版本，而不是在这里编计数。
export function patchVersion(upstreamVersion) {
  return patchVersionOf(upstreamVersion, readPkg("package.json").version);
}

/**
 * 补丁包版本戳的**纯核**（与 patchVersion 同一份实现，只是把两个版本显式传入）。
 *
 * 拆出来是为了让"交付树版本式子"成为**可断言**的东西：pack 期写入用的算式与 assert 期判定用的
 * 算式必须是同一份，否则会出现"写了却判不过"或反过来的假绿灯。纯函数的另一个好处是可单测。
 *
 * @param upstreamVersion - 集成目标在包集清单里的版本（上游版本）。
 * @param appVersion - 我们自己的版本（主 package.json#version，可带 +dsh- 段）。
 */
export function patchVersionOf(upstreamVersion, appVersion) {
  return `${cleanVersion(upstreamVersion)}+dshana-${cleanVersion(appVersion)}`;
}

// 完整版号：主号（剥掉既有 build 段）+ build metadata 段 `+dsh-<pin>`。
// 这段 metadata 的来源只有一处——根 package.json#devDependencies 的 @deepseek-ai/dsh 声明（见下
// dshPin）；pnpm version 算号会把 build 段剥掉，所以 bump 时由 version 钩子拼回，平时由 derive 的
// version-metadata 任务守着（pin 一动版号就跟，不等到下次 bump）。pin 未声明时只剩主号。
export function fullVersion(version, dsh = dshPin()) {
  const base = cleanVersion(version);
  return dsh ? `${base}+dsh-${dsh}` : base;
}

// ---- 交付树包根铭牌（src/product-package.json → 交付树的 package.json）----
// 它是**铭牌**：物化输入由包集清单（缓存条目里的 dsh-package-set.json）派生，pack 不读它装依赖。
// 它只回答「这包是什么、什么版本」，字段是 name / type / version，整份由 derive 的 product-package
// 任务从根 package.json 派生。住源码域而不是 dist：dist 每次 build 被清空，写在那儿会被抹掉。
// 没有任何脚本读它的内容（version 同步走 versionFiles 的通用路径），所以这里不再导出读取器——
// 留着只会诱人再把它当依赖声明的真源。
export const SHIP_PKG_REL = "src/product-package.json";

// ---- DSH pin（唯一真源：根 package.json#devDependencies）----
// 为什么 pin 住在这里：它是**流水线的输入**（编哪份 DSH：vendor tag、集成漂移闸、产物版本串），
// 必须在任何构建之前可读。放 T2 的清单里不行——清单是 T1 的产物，会成先有鸡还是先有蛋。
// 更早的形态里 pin 住交付面那份 manifest 的 dependencies；那份退成铭牌（没有 dependencies）后归到
// 根 devDependencies——它**本来就有**这一条（开发侧要那棵树），且这条闸一直要求两处一致
// （见 scripts/integrations/index.mts），所以合并成一处是消除重复，不是新增约束。
/** 声明的 DSH 版本（根 devDependencies；未声明返回 null）。 */
export function dshPin() {
  const v = readPkg("package.json")?.devDependencies?.["@deepseek-ai/dsh"];
  return typeof v === "string" && v ? v : null;
}
