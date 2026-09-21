// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/bundle-deps.mts — 把随包发布的 @dshana/* 子插件声明进被选中 bundle 的依赖。
//
// 为什么必须声明：DSH 的 runtime 解析模式按「安装树 + **被选中 bundle 的依赖图**」算一份解析代
// （app-boot 的 profile-resolution），一行 loader 插件的 import 以这份解析代为基准解析。包内
// node_modules/@dshana/* 只解决「这份文件在不在」；进不了解析代，真机上下载面照旧报
//   Cannot find package '@dshana/provider' imported from <DSH_HOME>/profiles/web/
// 因为 profile 住在数据目录里，向上 node 解析永远走不到安装树的 node_modules。官方在
// healProfileModuleFallback / resolveModuleFallbackEntries 里给这种情况留了口子：**只被选中
// bundle 携带**的包按 profile 作用域补进解析代（并按需在 profile 下 reconcile 一条自有链接），
// 官方 bundle 声明的那些包走的就是这条路。于是子插件必须由某个**被选中**的 bundle 认领。
//
// 认领者选 @deepseek-ai/dsh-web-app：web profile 随附两层 bundle（dsh-base + dsh-web-app）里的
// 上层，已经被 profile 选中，声明在这里即随它进解析代。声明值用 file:../../@dshana/<名>（与它
// 同锚点的真实目录）：解析代只取依赖**名**做闭包遍历（packageDirFromAnchor 走 node 解析），
// 任何真去解析它的人（pnpm、DSH 的链接模式）也会命中包内那份真实目录。
//
// 因此不改 profile manifest、不建我们自己维护的链接、不碰数据目录：profile 侧的链接由 DSH 每轮
// boot 自己 reconcile，对任何安装一视同仁。
import fs from "fs-extra";
import { join } from "node:path";

/** 认领随包插件的被选中 bundle。 */
export const BUNDLE_PACKAGE = "@deepseek-ai/dsh-web-app";

/** 随包发布子插件的 scope 目录名。 */
const PLUGINS_SCOPE = "@dshana";

/**
 * 把交付树里 node_modules/@dshana/* 的每个包声明进认领 bundle 的 dependencies。
 *
 * fail-closed：认领者不在、它不声明 dsh.bundle.patch（不是 bundle 层）、子插件一个都没有，
 * 这些情况下的包装到真机都会在 boot 期报 ERR_MODULE_NOT_FOUND，宁可不打包。
 * @param {string} nodeModulesDir 组装台里的 node_modules（交付树，no-link 铺平形态）
 * @returns {string[]} 被声明的包名（日志用）
 */
export function declareInstallationPlugins(nodeModulesDir) {
  const scopeDir = join(nodeModulesDir, PLUGINS_SCOPE);
  if (!fs.pathExistsSync(scopeDir)) {
    throw new Error(`随包子插件目录不存在：${scopeDir}（先构建 cordis 插件再打包）`);
  }
  const plugins = fs
    .readdirSync(scopeDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  if (plugins.length === 0) throw new Error(`随包子插件目录为空：${scopeDir}（拒绝出包）`);

  const manifestPath = join(nodeModulesDir, BUNDLE_PACKAGE, "package.json");
  if (!fs.pathExistsSync(manifestPath)) {
    throw new Error(`认领 bundle 不在交付树里：${manifestPath}（物化树与该 DSH 版本不匹配？）`);
  }
  const manifest = fs.readJsonSync(manifestPath);
  if (manifest.dsh?.bundle?.patch === undefined) {
    throw new Error(`${BUNDLE_PACKAGE} 不声明 dsh.bundle.patch，不是 bundle 层：${manifestPath}`);
  }
  const dependencies = { ...(manifest.dependencies ?? {}) };
  const declared = [];
  for (const name of plugins) {
    const key = `${PLUGINS_SCOPE}/${name}`;
    const spec = `file:../../${key}`;
    const existing = dependencies[key];
    if (existing !== undefined && existing !== spec) {
      throw new Error(`${BUNDLE_PACKAGE} 已声明的 ${key} 是 ${existing}，与预期 ${spec} 不符`);
    }
    dependencies[key] = spec;
    declared.push(key);
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies }, null, 2) + "\n");
  console.log(
    `[pack] 随包插件已声明进 ${BUNDLE_PACKAGE} 依赖（${declared.length} 个）：${declared.join(", ")}` +
      "——它们由此随该 bundle 进 DSH 的解析代",
  );
  return declared;
}
