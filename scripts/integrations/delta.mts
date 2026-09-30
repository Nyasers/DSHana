// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/integrations/delta.mts — 把集成 delta 铺进**构建期**的 scratch 检出。
//
// 时机前移（spec §6.7）：overlay 以前在 pack 期盖 node_modules，于是交付树与包集清单在集成目标上
// 不一致——清单记的是我们编出的 tarball 字节，pack 再覆盖就把那句声明变成了谎。现在 delta 在构建前
// 铺进检出，产物自带 delta，清单的 sha512 描述的就是交付内容。
//
// 版本戳**不**在这里写：`+dshana-<干净版本>` 仍是 pack 期一处声明的元数据写入。若把它也烤进检出，
// 每发一个 dshana 版本包集就变，缓存（scripts/vendor/build.mts）整条失效——而包集是 ~15 分钟级的
// 产物，跨版本复用是硬约束。所以这里只铺**内容**，不碰版本号。
//
// 闸的位置：铺之前用 verify.mts 的 upstreamSha256 闸校**上游**文件哈希（不是我们的 delta），
// 上游动过就当场失败并点名要 rebase 哪个文件。这条闸以前只在 repo 级的 integrations verify 里，
// 现在构建本身也过它——否则构建会拿一份过期 delta 悄悄编出产物。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ROOT } from "../shared/root.mts";
import { patchGeneratedRequestModel } from "./build.mts";
import { loadIntegrations, readUpstreamFromMirror } from "./mirror.mts";
import { verifyIntegrations } from "./verify.mts";

/** 按集成短名排序读声明（哈希与铺盘的顺序都靠它固定下来，免得随 readdir 顺序漂）。 */
export function sortedIntegrations(rootDir: string = ROOT): any[] {
  return loadIntegrations(rootDir)
    .slice()
    .sort((a, b) => String(a.dir).localeCompare(String(b.dir)));
}

/**
 * 集成 delta 的**内容哈希**——进 T1 缓存键的那一半。
 *
 * 为什么进键：delta 是产物字节的一部分。改了 overlay 而键不变，就会命中一份「没有这次改动」的
 * 包集，且清单的 sha512 还会替它背书。键里必须有它。
 *
 * 为什么不含版本戳：`+dshana-<干净版本>` 写在 pack 期（见文件头）。把它算进来等于每发一版就换键，
 * 缓存再也跨不了 dshana 版本——那正是这条改动要避免的。
 *
 * 为什么连 upstreamSha256 一起哈希：它钉住「这份 delta 是对着哪一版上游 rebase 的」。rebase 之后
 * 上游段变了，键也该变（即便我们的文件字节恰好没动）。
 */
export function deltaContentHash(rootDir: string = ROOT): string {
  const h = crypto.createHash("sha256");
  for (const it of sortedIntegrations(rootDir)) {
    h.update("integration\0" + String(it.dir) + "\0");
    h.update(fs.readFileSync(path.join(it.root, "integration.json")));
    for (const f of Array.isArray(it.files) ? it.files : []) {
      h.update("file\0" + String(f.path) + "\0" + String(f.upstreamSha256) + "\0");
      h.update(fs.readFileSync(path.join(it.root, "files", String(f.path))));
    }
    for (const g of Array.isArray(it.generatedPatches) ? it.generatedPatches : []) {
      const schemas = Array.isArray(g.requestSchemas) ? g.requestSchemas.join(",") : "";
      h.update("generated\0" + String(g.path) + "\0" + schemas + "\0");
    }
  }
  return h.digest("hex");
}

/**
 * 校上游哈希闸，返回可铺的集成清单。
 *
 * @param tag - 上游 git tag（闸按它读上游文件，与检出同源）。
 * @param mirrorDir - 镜像目录（默认 vendor/deepseek-harness）。
 * @throws 任一 overlay 的上游哈希对不上、或上游路径不存在时（点名 rebase 哪个文件）。
 */
export function verifiedIntegrations(tag: string, mirrorDir?: string): { integrations: any[]; result: any } {
  const integrations = sortedIntegrations();
  const result = verifyIntegrations(integrations, (rel) => readUpstreamFromMirror(rel, tag, mirrorDir));
  return { integrations, result };
}

interface StageOptions { log?: (m: string) => void; mirrorDir?: string }

/**
 * 把 delta 铺进 scratch 检出（整文件覆盖上游源码）。
 *
 * 目标路径 = <检出>/<upstreamDir>/<files[].path>，与 pack 期旧实现同一套坐标，只是落点从
 * node_modules 换成源码树。检出缺该包目录就失败——那意味着 upstreamDir 要 rebase，而不是"没打
 * 补丁也能出包"。
 *
 * @param checkoutDir - scratch 检出根。
 * @param tag - 上游 tag。
 * @param options.log - 逐包日志。
 * @returns 铺了多少文件、哪些包，以及闸的结果。
 */
export function stageDelta(
  checkoutDir: string,
  tag: string,
  options: StageOptions = {},
): { files: number; packages: any[]; integrations: any } {
  const log = options.log ?? (() => {});
  const { integrations, result } = verifiedIntegrations(tag, options.mirrorDir);
  let files = 0;
  const packages: any[] = [];
  for (const it of integrations) {
    const list = Array.isArray(it.files) ? it.files : [];
    if (list.length === 0) continue;
    const pkgDir = path.join(checkoutDir, String(it.upstreamDir));
    if (!fs.existsSync(path.join(pkgDir, "package.json"))) {
      throw new Error(
        `集成 ${it.dir}: 检出里没有上游包 ${it.upstreamDir}（目录被改名/移动？upstreamDir 要 rebase）`,
      );
    }
    for (const f of list) {
      const src = path.join(it.root, "files", String(f.path));
      if (!fs.existsSync(src)) throw new Error(`集成 ${it.dir}: delta 文件缺失 ${src}`);
      const dst = path.join(pkgDir, String(f.path));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      files += 1;
    }
    packages.push({ dir: it.dir, package: it.package, upstreamDir: it.upstreamDir, files: list.length });
    log(`[build-dsh]   铺 ${it.package} ← ${it.dir}（${list.length} 个 overlay）`);
  }
  // fail-closed：一个也没铺 = 声明/目录出了问题；宁可不出包集，也不编一份"没打 delta"的产物。
  if (files === 0) {
    throw new Error("没有任何集成 delta 可铺（src-integrations 下无有效声明）：拒绝产出未打 delta 的包集");
  }
  return { files, packages, integrations: result };
}

/**
 * 应用 generatedPatches（生成物补丁），在**生成之后、打包之前**调用。
 *
 * `lib/typert.host.js` 是上游发布时由 dsh-typert-generator 从 FaceModel 生成的：从源码构建后它由
 * 我们的构建产出，所以补丁必须跟在生成步之后。实测即使把我们的 src/types.ts 铺进源码树，生成器
 * **仍然**不会把 request 级 model 字段写进 schema（它不是从那个类型面推的），所以这一手不能省。
 *
 * @param checkoutDir - scratch 检出根（生成物此刻已就位）。
 * @param options.log - 逐条日志。
 * @returns 打了多少处。
 */
export function applyGeneratedPatches(
  checkoutDir: string,
  options: { log?: (m: string) => void } = {},
): number {
  const log = options.log ?? (() => {});
  let applied = 0;
  for (const it of sortedIntegrations()) {
    for (const g of Array.isArray(it.generatedPatches) ? it.generatedPatches : []) {
      const rel = String(g.path ?? "");
      const target = path.join(checkoutDir, String(it.upstreamDir), rel);
      if (!fs.existsSync(target)) {
        throw new Error(
          `集成 ${it.dir}: 生成物补丁目标不存在（${it.upstreamDir}/${rel}）——生成步没跑，或上游改了输出路径`,
        );
      }
      const schemas = Array.isArray(g.requestSchemas) ? g.requestSchemas : [];
      if (schemas.length === 0) throw new Error(`集成 ${it.dir}: 生成物补丁没声明 requestSchemas（${rel}）`);
      fs.writeFileSync(target, patchGeneratedRequestModel(fs.readFileSync(target, "utf8"), schemas, it.package));
      applied += 1;
      log(`[build-dsh]   ${it.package} ${rel} 补上请求级模型字段（${schemas.join(", ")}）`);
    }
  }
  return applied;
}
