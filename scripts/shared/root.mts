// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/shared/root.mts — 仓库根，以及脚本入口的 Node 版本断言（脚本域共用一份）。
//
// 为什么不数 ".." 的层数：脚本按域分在 scripts/<域>/ 下，各自到根的深度不再一致，
// 数层数会随下一次搬家再错一遍。这里向上找最近的 package.json。
// 脚本只会待在 scripts/ 下（其子目录不含 package.json），所以第一个命中的就是仓库根。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 从给定文件向上找最近的含 package.json 的目录。 */
export function findRepoRoot(from: string): string {
  let dir = path.dirname(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`找不到仓库根：${from} 向上没有 package.json`);
    dir = up;
  }
}

export const ROOT = findRepoRoot(fileURLToPath(import.meta.url));

type Version = [number, number, number];

function parseVersion(text: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Node 版本范围判断（纯函数，导出供单测）。
 *
 * 只认本仓会写的三种子句，`||` 连接：`^x.y.z`、`>=x.y.z`、`x.y.z`。遇到别的写法一律抛错：
 * 范围是断言与 package.json 之间唯一的契约，认识不了就当场失败，绝不静默放行——静默放行
 * 会让「声明支持、运行期却拒绝」在无人察觉的时候发生。
 */
export function satisfiesNodeRange(range: string, version: string): boolean {
  const current = parseVersion(version);
  if (!current) throw new Error(`无法解析 Node 版本号：${version}`);
  const clauses = String(range).split("||").map((c) => c.trim()).filter(Boolean);
  if (!clauses.length) throw new Error("engines.node 是空范围");
  return clauses.some((clause) => {
    const caret = /^\^(\d+\.\d+\.\d+)$/.exec(clause);
    if (caret) {
      const base = parseVersion(caret[1])!;
      // ^x.y.z：>=x.y.z 且不跨大版本（本仓只会用 x > 0 的写法）
      return compare(current, base) >= 0 && current[0] === base[0];
    }
    const atLeast = /^>=\s*(\d+\.\d+\.\d+)$/.exec(clause);
    if (atLeast) return compare(current, parseVersion(atLeast[1])!) >= 0;
    const exact = parseVersion(clause);
    if (exact) return compare(current, exact) === 0;
    throw new Error(
      `engines.node 含本仓解析器不支持的写法：${clause}。` +
        "支持集只有 ^x.y.z / >=x.y.z / x.y.z 与 || 连接（见 DESIGN.md「工具链前提」）。" +
        "要放宽就改 scripts/shared/root.mts 的 satisfiesNodeRange 并补测试，不要只改 package.json。",
    );
  });
}

/** 不满足就抛出可读错误；范围取自 package.json 的 engines.node，不在代码里抄第二份。 */
export function assertSupportedNode(enginesNode: unknown, version: string = process.versions.node): void {
  if (typeof enginesNode !== "string" || !enginesNode.trim()) {
    throw new Error("package.json 缺 engines.node：本仓脚本以 .mts 直跑，下界必须显式声明。");
  }
  if (!satisfiesNodeRange(enginesNode, version)) {
    throw new Error(
      `本仓脚本需要 Node ${enginesNode}（当前 ${version}）：scripts 与 src 的构建入口以 TypeScript 直跑，依赖 Node 原生类型剥离。`,
    );
  }
}

// 本仓脚本全部以 `node <file>.ts|.mts` 直跑（package.json 的 scripts 都这么调），靠 Node 原生
// 类型剥离，22.18 / 23.6 起默认启用。低于下界时报错发生在运行期，typecheck 管不到，所以在
// 共享入口断言一次：入口 import 本模块即拿到可读失败，而不是 TypeScript 的语法错。
//
// package.json 的 engines.node 是同一份声明的机器可读面；pnpm 对**根项目**的 engines 不做强制
// （实测即便 --engine-strict 也照常安装），所以真正的拦在这里。
assertSupportedNode(
  JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).engines?.node,
);
