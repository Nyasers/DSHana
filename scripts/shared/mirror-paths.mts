// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/shared/mirror-paths.mts — 从源码镜像生出「DSH 包名 → 源入口」表（类型解析用）。
//
// 为什么单独一处：这张表有两个读者——覆盖层检查（在暂存树里解析上游声明）与 derive 的 paths
// 任务（编辑器用的 tsconfig.paths.json），口径必须只有一份。
//
// 口径：**只补本仓 .pnpm 里没装的那些包**。覆盖层会用到 DSH 自己那批包（且它们 `declare module`
// 增强 cordis 的 `Context`），这些包对本仓构建而言是运行时外部、不一定装，于是不映射就解析不到
// 声明；而**混用**（一部分取本仓已装的 lib/types/*.d.ts、一部分取镜像源）会把插槽契约聚合成
// 两套、反过来报我们的文件“属性不存在”。所以口径定死：**一律以上游源为准**（我们改的就是那份
// 源），也即镜像优先，本仓产物只当兵底。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const mirrorCache = new Map<string, Record<string, string[]>>();

export function mirrorPathEntries(mirrorDir, hiddenDir): Record<string, string[]> {
  const key = `${mirrorDir}|${hiddenDir}`;
  const hit = mirrorCache.get(key);
  if (hit) return hit;
  const out: Record<string, string[]> = {};
  const groupsDir = join(mirrorDir, "packages");
  if (existsSync(groupsDir)) {
    for (const group of readdirSync(groupsDir, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const gDir = join(groupsDir, group.name);
      for (const pkg of readdirSync(gDir, { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue;
        const dir = join(gDir, pkg.name);
        const pj = join(dir, "package.json");
        if (!existsSync(pj)) continue;
        let meta: Record<string, any> | null = null;
        try {
          meta = JSON.parse(readFileSync(pj, "utf8"));
        } catch {
          continue;
        }
        const name = String((meta && meta.name) || "");
        if (!name) continue;
        const installed = join(hiddenDir, name);
        const fallback = existsSync(installed) ? [installed] : [];
        const entry = join(dir, "src", "index.ts");
        if (existsSync(entry)) out[name] = [entry, ...fallback];
        const clientEntry = join(dir, "src", "client", "index.ts");
        if (existsSync(clientEntry)) out[`${name}/client`] = [clientEntry, ...fallback];
        // 子路径导出（pkg/types、pkg/remote、pkg/surface…）：按 package.json exports 的
        // types 字段反推源文件（lib/types/<x>.d.ts → src/<x>.ts）。缺这条时这类 import
        // 在暂存树里解析不到（TS2307），覆盖层文件与上游 contract 会连片报红。
        const exportsMap = meta && meta.exports && typeof meta.exports === "object" ? meta.exports : {};
        for (const [subKey, val] of Object.entries(exportsMap)) {
          if (subKey === "." || subKey === "./package.json" || subKey.startsWith("./src/")) continue;
          const sub = subKey.replace(/^\.\//, "");
          if (!sub || sub.includes("*")) continue;
          const v: any = val;
          const spec = typeof v === "string" ? v : String((v && (v.types || v.default)) || "");
          const m = spec.match(/lib\/types\/(.+)\.d\.ts$/) || spec.match(/lib\/(.+)\.js$/);
          if (!m) continue;
          const srcFile = join(dir, "src", m[1] + ".ts");
          if (existsSync(srcFile) && out[`${name}/${sub}`] === undefined) {
            out[`${name}/${sub}`] = [srcFile, ...fallback];
          }
        }
      }
    }
  }
  mirrorCache.set(key, out);
  return out;
}
