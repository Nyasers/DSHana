// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/exclude.mts — 交付树里不出现的包（其他表层、私货，与剥离面）。
//
// 本 App 的 profile 层列只有两层：`@deepseek-ai/dsh-base` → `@dshana/dsh-app`。但交付树的依赖
// 真源是 host 声明的内核 `@deepseek-ai/dsh`（CLI），它自己的清单里还挂着 acp / headless / sdk
// 等表层 bundle 与 `dsh-skill-office`——照搬就会把用不到的包（含 Office 那 182MB 平台件）
// 一并装进产物。
//
// 保留名单**派生**而不是手写：只有 `@deepseek-ai/dsh-base`——共享底座。
// 注意上游 `OPTIONAL_BUNDLES` 那 12 个实验 bundle **不在**保留层：它们的语义是「随安装走、默认关」，
// 本形态把「默认关」推到底——包不进交付树，改成点了才装（见 on-demand.mts），于是它们也进了排除面。
// 排除名单分四层：
//   ① 派生的表层：vendor checkout 里所有声明 `dsh.bundle` 的包减去上面那份保留名单；
//   ② `STRAYS`：不声明 dsh.bundle 的私货（扫不到，但只被别的表层挂载）；
//   ③ `STRIPPED`：本形态不交付的产品面（账号 / 反馈 / 遥测 / 会话日志上传）——上游 base 自己的
//     依赖，必须显式列才挡得住；
//   ④ `ON_DEMAND`：本形态改成按需安装的实验性 bundle——包也不进树，但与 ③ 相反，用户能装回来。
// 上游新增表层时 ① 自动把它挡在门外，而不是等它悄悄进包。
//
// 两道用法：
//   1) 物化前：把名单 override 成一个极小 stub（`file:` 指向本模块生成的空包）——pnpm 不会去
//      下载真件，也不改锁文件的语义；stub 不声明依赖，所以它们的传递闭包（语音模型、DevTools
//      前端那一大块）同样进不来；
//   2) 组装时：把 stub 目录从交付树里删掉——产物里既没有真件也没有占位。
//
// ③④ 与组合层是成对的：包里不留件，packages/dsh/app/cordis.patch.yml 就必须把引用它的行按 id
// 关掉（loader 对 disabled 的行连 import 都不发），integrations/api-remotes 则把模块级 import
// 删干净。④ 另要摘内核 dependencies 并注入 app-boot 的离线 catalog（否则页面标「内置」或根本
// 列不出来）。细节见各自头注。
import fs from "fs-extra";
import { join } from "node:path";

import { CACHE_DIR, ROOT } from "../../shared/paths.mts";
import { cordisPkgDirs, cordisPkgFullName } from "../../shared/version.mts";
import { ON_DEMAND_BUNDLES } from "./on-demand.mts";

/** 保留的表层：只有共享底座（上游那 12 个可选 bundle 已改成按需，见文件头与 on-demand.mts）。 */
export function keptBundles(): string[] {
  return ["@deepseek-ai/dsh-base"];
}

/**
 * 非 bundle 的私货：它们不声明 `dsh.bundle`，因此派生扫不到，但只被别的表层挂载。
 *   dsh-skill-office — Office 写作技能提供方（sdk 表层挂载；本形态的 Office 转换走宿主）。
 */
const STRAYS = ["@deepseek-ai/dsh-skill-office"];

/**
 * 剥离面：本形态完全不交付的产品面（账号 / 反馈 / 遥测 / 会话日志上传 / 官方 LLM adapter）。
 *
 * 与 `STRAYS` 的区别是它们**不是**表层私货，而是 base / web-app 自己的依赖——所以只有显式
 * 列出来才挡得住。每一条都要求引用它的**行已经不在文档里**（不是 disabled，是删掉）：
 * `integrations/dsh-base` 删掉了 base 那十条，`packages/dsh/app/cordis.patch.yml` 不插
 * web-app 那五条，`integrations/api-remotes` 删掉了模块级 import。包不在树里而行还在，就是
 * boot 期 ERR_MODULE_NOT_FOUND；三者必须成对。
 *
 * 与 disabled 的区别是本质的：行留着、只标 disabled，loader 不 import 它，但包仍然装在交付
 * 树里、仍然占体积与依赖面。删行 + 不交付包，才是真的「不导入」。
 */
const STRIPPED = [
  "@deepseek-ai/dsh-deepseek-account",
  "@deepseek-ai/dsh-deepseek-account-platform",
  "@deepseek-ai/dsh-api-account-controller",
  "@deepseek-ai/dsh-client-ui-settings-account",
  "@deepseek-ai/dsh-message-feedback",
  "@deepseek-ai/dsh-command-feedback",
  "@deepseek-ai/dsh-client-ui-message-feedback",
  "@deepseek-ai/dsh-session-log-deepseek",
  "@deepseek-ai/dsh-session-log-export",
  "@deepseek-ai/dsh-client-ui-settings-session-log",
  "@deepseek-ai/dsh-deepseek-llm-api-extensions",
  "@deepseek-ai/dsh-plugin-package-inventory-deepseek",
  "@deepseek-ai/dsh-llm-deepseek",
  "@deepseek-ai/dsh-llm-deepseek-api-key",
  "@deepseek-ai/dsh-llm-deepseek-account",
  "@deepseek-ai/dsh-llm-pi-ai",
  "@deepseek-ai/dsh-client-ui-deepseek-model-label-1017",
  "@deepseek-ai/dsh-otel",
  "@deepseek-ai/dsh-session-telemetry",
  "@deepseek-ai/dsh-session-telemetry-otel",
  "@deepseek-ai/dsh-host-product-telemetry-otel",
  "@deepseek-ai/dsh-client-product-analytics",
];

/** vendor checkout 里声明 dsh.bundle 的包（表层）。 */
function upstreamBundles() {
  const packagesDir = join(ROOT, "vendor", "deepseek-harness", "packages");
  const out: { name: string; version: string }[] = [];
  for (const group of fs.readdirSync(packagesDir)) {
    const groupDir = join(packagesDir, group);
    if (!fs.statSync(groupDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(groupDir)) {
      const manifestPath = join(groupDir, entry, "package.json");
      if (!fs.pathExistsSync(manifestPath)) continue;
      let manifest: { name?: string; version?: string; dsh?: { bundle?: unknown } };
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch {
        continue;
      }
      if (typeof manifest.name !== "string" || manifest.dsh?.bundle === undefined) continue;
      out.push({ name: manifest.name, version: String(manifest.version ?? "0.0.0") });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** vendor checkout 里所有包的 name → version（stub 用真件的版本号，任何范围检查都成立）。 */
function mirrorPackageVersions(): Map<string, string> {
  const packagesDir = join(ROOT, "vendor", "deepseek-harness", "packages");
  const out = new Map<string, string>();
  for (const group of fs.readdirSync(packagesDir)) {
    const groupDir = join(packagesDir, group);
    if (!fs.statSync(groupDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(groupDir)) {
      const manifestPath = join(groupDir, entry, "package.json");
      if (!fs.pathExistsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        if (typeof manifest.name === "string") out.set(manifest.name, String(manifest.version ?? "0.0.0"));
      } catch {
        /* 读不动就跳过：版本号只影响 stub 的自述 */
      }
    }
  }
  return out;
}

/** 版本查表（stub 用真件的版本号，任何范围检查都成立）。 */
function versionOf(name: string): string {
  return mirrorPackageVersions().get(name) ?? "0.0.0";
}

/**
 * 交付树里不出现的包名（派生：上游表层 − 保留层；再加私货名单与剥离面）。
 * @returns 包名数组（已去重排序）。
 */
export function excludedPackages(): string[] {
  const keep = new Set(keptBundles());
  const names = upstreamBundles()
    .map((b) => b.name)
    .filter((n) => !keep.has(n));
  return [...new Set([...names, ...STRAYS, ...STRIPPED, ...ON_DEMAND_BUNDLES])].sort();
}

/** stub 目录（每个包一个子目录，包名里的 / 换成 __）。 */
function stubDirOf(name: string): string {
  return join(CACHE_DIR, "pkg-stubs", name.replace("/", "__"));
}

/**
 * 生成 stub 包并给出 pnpm overrides 表（`包名 → file:<绝对路径>`）。
 * @returns { overrides, stubs }：overrides 直接进工位的 pnpm-workspace.yaml。
 */
export function prepareStubs(): { overrides: Record<string, string>; stubs: string[] } {
  const overrides: Record<string, string> = {};
  const stubs: string[] = [];
  for (const name of excludedPackages()) {
    const dir = stubDirOf(name);
    fs.removeSync(dir);
    fs.ensureDirSync(dir);
    fs.writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name, version: versionOf(name), private: true }, null, 2) + "\n",
      "utf8",
    );
    overrides[name] = `file:${dir.replace(/\\/gu, "/")}`;
    stubs.push(name);
  }
  return { overrides, stubs };
}

/**
 * 把被排除的包从交付树里删掉（包括上面那些 stub）。
 *
 * 为什么要删而不是留着 stub：产物里不该有"装着但永远不加载"的槽位。删完之后树里既没有真件也
 * 没有占位，而 pnpm 的账本早已随工位一起清掉（装机器不执行 install），所以缺这几个目录不会让
 * 任何东西解析失败——DSH 的解析代只走"被选中 bundle 的依赖图"。
 * @param nodeModulesDir 组装台里的 node_modules
 * @param names 要删的包名（默认取 excludedPackages()）
 * @returns 实际删掉的包名
 */
export function pruneExcluded(nodeModulesDir: string, names: string[] = excludedPackages()): string[] {
  const pruned: string[] = [];
  for (const name of names) {
    const dir = join(nodeModulesDir, name);
    if (fs.pathExistsSync(dir)) {
      fs.removeSync(dir);
      pruned.push(name);
    }
  }
  // scope 目录空了就一并收掉（@deepseek-ai 还有别的包，通常不会触发）
  const scope = join(nodeModulesDir, "@deepseek-ai");
  if (fs.pathExistsSync(scope) && fs.readdirSync(scope).length === 0) fs.removeSync(scope);
  return pruned;
}

/** 交付树里必须出现的包（fail-closed 断言的正面清单）。
 * 子插件名单派生自包现场（packages/dsh 下带 cordis.config.mjs 的包）：加一个自动纳入，
 * 下线一个不会留一条永远失败的断言。 */
export function requiredPackages(): string[] {
  const plugins = cordisPkgDirs().map((rel) => cordisPkgFullName(rel));
  return ["@deepseek-ai/dsh-base", "@dshana/dsh-app", ...plugins];
}
