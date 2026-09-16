// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/overlays.mts — 把集成层编译出的补丁包盖回物化树（单副本）。
//
// 机制见 src-integrations/README.md：每个集成是「上游某版文件的整文件拷贝 + 我们的 delta」，
// 编译产物在 _tmp/integrations-built/<短名>/，这里按 integration.json 的 package 字段覆盖进
// 交付树的对应包目录。版本戳（<上游>+dshana-<干净版本>）由 integrations build 写进补丁包的
// package.json，此处只原样覆盖。
import fs from "fs-extra";
import { join } from "node:path";

import { ROOT } from "../../shared/root.mts";

/**
 * fail-closed：声明了 overlay 却没产物 = 构建没跑全——宁可不打包，也不出「没打补丁」的包。
 * @param {string} nodeModulesDir 组装台里的 node_modules（交付树，已是 no-link 铺平形态）
 */
export function applyIntegrations(nodeModulesDir) {
  const integrationsDir = join(ROOT, "src-integrations");
  // fail-closed：目录缺失会让整包官方包回退成上游原版（role 对、主题对，但 ui-layout /
  // ui-sidebar / ui-settings-general 的补丁全丢），而打包照旧成功。任何“声明的补丁没盖上”
  // 都必须让打包失败。
  if (!fs.pathExistsSync(integrationsDir)) {
    throw new Error(`集成目录不存在：${integrationsDir}（预期 src-integrations/；拒绝产出未打补丁的包）`);
  }
  const builtRoot = join(ROOT, "_tmp", "integrations-built");
  const pending: any[] = [];
  let applied = 0;
  for (const ent of fs.readdirSync(integrationsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const manifestPath = join(integrationsDir, ent.name, "integration.json");
    if (!fs.pathExistsSync(manifestPath)) continue;
    const decl = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const files = Array.isArray(decl.files) ? decl.files : [];
    if (files.length === 0) continue; // 尚无 overlay：不算缺口
    const builtDir = join(builtRoot, ent.name);
    if (!fs.pathExistsSync(builtDir)) {
      pending.push(ent.name);
      continue;
    }
    const target = join(nodeModulesDir, decl.package);
    if (!fs.pathExistsSync(target)) throw new Error(`集成 ${ent.name}：物化树里没有 ${decl.package}`);
    fs.copySync(builtDir, target, { overwrite: true });
    const stamped = JSON.parse(fs.readFileSync(join(target, "package.json"), "utf8")).version;
    applied += 1;
    console.log(`[pack] 集成覆盖：${decl.package}@${stamped}（${ent.name}，${files.length} 个 overlay）`);
  }
  if (pending.length) {
    throw new Error(`集成产物缺失（${pending.join(", ")}）：先跑 pnpm run build（含 integrations build）再打包`);
  }
  // 声明了补丁却一个也没盖上 = 目录/清单出了问题；宁可不出包。
  if (applied === 0) {
    throw new Error(`没有应用任何集成补丁（${integrationsDir} 下无有效 integration.json）：拒绝产出未打补丁的包`);
  }
}
