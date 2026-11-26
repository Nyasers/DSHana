// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/shared/on-demand.mts — 「哪些可选 bundle 改成按需安装」这份名单及其与上游的对账。
//
// 名单只有一份事实源：根 `pnpm-workspace.yaml` 的 `excluded-on-demand` 标记段。打包工位用它做三件事
// （stub 通道、内核依赖摘除、离线 catalog 注入），闸用它跟上游 OPTIONAL_BUNDLES 对账。
//
// 为什么对账单独提到 shared 而不留在打包目录里：名单漂移的后果不是「包小一点」，而是打包直接红
// （`assertMatchesUpstreamOptional`）——那意味着上游往 OPTIONAL_BUNDLES 塞了新 bundle 而我们没跟。
// 这条闸得在 CI 的常规门里跑（`pnpm run verify:on-demand`，挂在 build 链上），不能等到出包才发现：
// 0.2.2-rc.3 那次就是先出不了包、再回头改名单。
import fs from "node:fs";
import { join } from "node:path";

import { readUpstreamFromMirror } from "../integrations/mirror.mts";
import { ROOT } from "./paths.mts";
import { dshPin } from "./version.mts";

/**
 * 改成按需安装的实验性 bundle，从根 `pnpm-workspace.yaml` 的 `excluded-on-demand` 标记段读。
 *
 * 名单必须与上游 OPTIONAL_BUNDLES 一一对应，少了或多了都在闸上当场报
 * （见 assertMatchesUpstreamOptional）。不声明 dsh.bundle / 不在上游可选名单里的包
 * 不该写在那个段里：它们没有装回路径。
 * @param rootDir - 仓库根（测试可换）
 * @returns 包名数组（保持 yaml 里的顺序）
 */
export function onDemandBundles(rootDir = ROOT): readonly string[] {
  const text = fs.readFileSync(join(rootDir, "pnpm-workspace.yaml"), "utf8");
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (/^\s*# >>> excluded-on-demand\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (/^\s*# <<< excluded-on-demand\s*$/.test(line)) break;
    if (!inBlock) continue;
    const entry = /^\s+"(@[^"]+)":\s*"-"\s*$/.exec(line);
    if (entry !== null) out.push(entry[1]);
  }
  return out;
}

/**
 * 上游那份 OPTIONAL_BUNDLES（判据来源，不另维护第二份名单）。
 *
 * 从**镜像 tag** 读，不读 checkout 工作树：工作树会被人改、被分支切走，而同一个文件在
 * `pnpm run package` 与直接跑 index.mts 两种姿势下可能读出不同答案。更要紧的是 catalog 注入
 * 按同一 tag 读 meta——两边必须同源，否则「名单里有、catalog 里没有」（或反之）的拼美会静默发生。
 *
 * 位置随上游变过：0.2.2-alpha.2 起这份名单从 `packages/boot/app-boot/src/profile.ts`
 * 挪到了 `@deepseek-ai/dsh-official-bundles`（`packages/util/official-bundles/src/bundles.ts`），
 * 与 PROFILE_TEMPLATES / RETIRED_BUNDLES 同处。找不到就是上游又挪了，不能静默当空。
 * @param tag 镜像 tag（默认取内核 pin）
 */
export function upstreamOptionalBundles(tag = `dsh-v${dshPin()}`): string[] {
  const rel = "packages/util/official-bundles/src/bundles.ts";
  const buf = readUpstreamFromMirror(rel, tag);
  if (buf === null) throw new Error(`镜像 ${tag} 里没有 ${rel}（pin 与镜像对不上？）`);
  const text = buf.toString("utf8");
  const block = /export const OPTIONAL_BUNDLES[^=]*=\s*\[([\s\S]*?)\]/u.exec(text);
  if (block === null) throw new Error(`${tag}:${rel} 里找不到 OPTIONAL_BUNDLES 的字面量（上游改了结构？）`);
  const names = [...block[1].matchAll(/'([^']+)'/gu)].map((m) => m[1]);
  if (names.length === 0) throw new Error(`${tag}:${rel} 里的 OPTIONAL_BUNDLES 解析为空（上游改了写法？）`);
  return names;
}

/**
 * 名单必须与上游 OPTIONAL_BUNDLES **完全一致**：少一个 = 那个 bundle 仍随包内置（漏改），
 * 多一个 = 我们造了个上游没有的按需项（catalog 里点安装会 404）。
 * @param rootDir - 仓库根（测试可换）
 * @param tag - 镜像 tag（默认取内核 pin）
 */
export function assertMatchesUpstreamOptional(rootDir = ROOT, tag = `dsh-v${dshPin()}`): void {
  const upstream = new Set(upstreamOptionalBundles(tag));
  const ours = new Set(onDemandBundles(rootDir));
  const missing = [...upstream].filter((n) => !ours.has(n));
  const extra = [...ours].filter((n) => !upstream.has(n));
  if (missing.length || extra.length) {
    throw new Error(
      "按需名单与上游 OPTIONAL_BUNDLES 不一致：\n"
        + (missing.length ? `  上游有而我们没改按需：${missing.join(", ")}\n` : "")
        + (extra.length ? `  我们有而上游没有：${extra.join(", ")}\n` : "")
        + "  名单在根 pnpm-workspace.yaml 的 excluded-on-demand 段（stub 通道、内核依赖摘除、"
        + "离线 catalog 注入三处都读它）",
    );
  }
}
