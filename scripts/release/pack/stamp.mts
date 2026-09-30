// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/stamp.mts — pack 期给集成目标盖上版本戳（**唯一**的 pack 期内容写入）。
//
// T5 起 delta 已在**构建期**铺进检出、烤进产物，所以 pack 期不再覆盖任何内容——只剩下这一处
// 元数据写入：把集成目标的版本写成 `<清单版本>+dshana-<干净版本>`。
//
// 为什么戳不烤进构建产物（spec §6.7）：烤进去意味着每发一个 dshana 版本包集就变，T1 缓存整条
// 失效（~15 分钟/版）。戳只由我们的版本号决定，与 delta 内容无关，所以留在 pack 期一处写。
// 于是 delta 的内容哈希进缓存键、戳不进；同一条目可被多个 dshana 版本复用。
//
// 与旧 applyIntegrations 的区别（退场的那个）：它从 .tmp/integrations-built/ 覆盖**整个包目录**
// （lib/client.js、package.json 等），于是交付树与包集清单在集成目标上不一致——清单记的是我们
// 编出的 tarball 字节，pack 再覆盖就让那句声明成了谎。现在只写一个 version 字段，且它的值是
// 从清单版本算出来的（见 shared/version.mts#patchVersionOf），式子成立。
import fs from "fs-extra";
import { join } from "node:path";

import { patchVersionOf } from "../../shared/version.mts";

/**
 * 读集成声明（短名、目标包名、overlay 数）。
 *
 * 与 assert.mts 的 integrationDecls 同源同义：那边用它做存在性/对账，这里用它定位要盖章的包。
 * 只解析我们关心的字段，不校验结构——结构由构建期的闸（delta.mts#stageDelta）与 verify:integrations 负责。
 *
 * @param integrationsDir - src-integrations 目录。
 * @returns 按短名排序的声明（顺序固定，日志与写入都稳定）。
 */
export function readIntegrationDecls(integrationsDir: string): Array<{ dir: string; packageName: string; files: number }> {
  if (!fs.pathExistsSync(integrationsDir)) {
    throw new Error(`集成目录不存在：${integrationsDir}（预期 src-integrations/；拒绝产出未打 delta 的包）`);
  }
  const out: Array<{ dir: string; packageName: string; files: number }> = [];
  for (const e of fs.readdirSync(integrationsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const manifest = join(integrationsDir, e.name, "integration.json");
    if (!fs.pathExistsSync(manifest)) continue;
    const decl = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (typeof decl.package !== "string" || decl.package === "") {
      throw new Error(`集成 ${e.name}: integration.json 缺少 package（无从知道要盖哪个包）`);
    }
    out.push({ dir: e.name, packageName: decl.package, files: Array.isArray(decl.files) ? decl.files.length : 0 });
  }
  if (out.length === 0) {
    throw new Error(`没有有效的集成声明（${integrationsDir}）：拒绝产出未打 delta 的包`);
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * 给物化树里的集成目标盖版本戳（写 package.json#version）。
 *
 * fail-closed：声明了集成而目标包不在树里 = 物化没装全，当场拒包（旧 applyIntegrations 的语义）。
 * 注意这里**不**检查 .tmp/integrations-built/——那批产物不再被 pack 消费（delta 已在构建期进产物），
 * 再要求它存在就成了"为已退场的机制守门"，而它恰恰是"交付面与清单不一致"的来源。
 *
 * @param nodeModulesDir - 组装台里的 node_modules（交付树）。
 * @param packages - 包集清单的包记录（提供每个目标的上游版本）。
 * @param appVersion - 我们的版本（主 package.json#version）。
 * @param integrationsDir - src-integrations 目录。
 * @returns 盖了章的目标（名字与写入的版本），供后续 assert 与日志复用。
 */
export function stampIntegrationVersions(
  nodeModulesDir: string,
  packages: Array<{ name: string; version: string }>,
  appVersion: string,
  integrationsDir: string,
): Array<{ dir: string; packageName: string; version: string }> {
  const byName = new Map(packages.map((p) => [p.name, p.version]));
  const stamped: Array<{ dir: string; packageName: string; version: string }> = [];
  for (const decl of readIntegrationDecls(integrationsDir)) {
    const target = join(nodeModulesDir, decl.packageName, "package.json");
    if (!fs.pathExistsSync(target)) {
      throw new Error(`集成 ${decl.dir}: 物化树里没有 ${decl.packageName}（物化没装全？拒绝产出未打 delta 的包）`);
    }
    const upstreamVersion = byName.get(decl.packageName);
    if (upstreamVersion === undefined) {
      throw new Error(`集成 ${decl.dir}: 包集清单里没有 ${decl.packageName}（清单与集成声明不同步）`);
    }
    const version = patchVersionOf(upstreamVersion, appVersion);
    const manifest = fs.readJsonSync(target);
    manifest.version = version;
    // 2 空格 + 末尾换行：与仓库里所有 package.json 的写回形状一致（derive 的 writePkg 同款）。
    fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    stamped.push({ dir: decl.dir, packageName: decl.packageName, version });
  }
  return stamped;
}
