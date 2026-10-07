// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/trim.mts — 交付面裁剪：从依赖树里删掉运行时不读的文件。
//
// 为什么单独成一层：包体积直接影响能不能进市场（市场索引对单条归档有上限），而依赖树里
// 带着一批运行时不读的东西。以 universal 包为样本（12,453 条）统计，测试目录与包内源码/
// 类型声明两项合计约 4 MB（压缩后），去掉它们不经过任何一条运行路径。
//
// 判据而不是名单：规则只按路径形态与「包内是否存在编译产物」判断，不写包名。样本里带 .ts 的
// 18 个包全部同时带 .js/.mjs/.cjs，所以「有产物即源码」这条派生判据对样本内每个包都成立；
// 真出现只发源码的包，该包的源码会被整包保留（判据不成立就不裁）。
//
// 只动依赖树：本模块只扫 `node_modules/`，并跳过 `node_modules/@dshana/`（我们自己的产物）。
// 因此 App 交付面（manifest.json / bin / ui / skills / 图标 / NOTICE）与每个包的 package.json、
// 许可文件都不在裁剪范围内，不需要额外豁免名单。
import fs from "fs-extra";
import { join } from "node:path";

/** 一条裁剪规则：只看相对 `node_modules/` 的路径形态。 */
export interface TrimRule {
  name: string;
  test: (rel: string) => boolean;
}

/** 包内源码/类型声明（仅在包内有编译产物时裁）。 */
const SOURCE_RE = /\.(ts|mts|tsx)$/;
/** 编译产物：判据用它决定同一个包里的源码是不是可以裁。 */
const PRODUCT_RE = /\.(js|mjs|cjs)$/;
/** 包根级的许可与清单文件，永远保留（合规与包解析都依赖）。 */
const KEPT_FILE_RE = /(^|\/)(package\.json|LICENSE|LICENCE|license|NOTICE|NOTICE\.md|THIRD_PARTY_NOTICES\.md)$/;

/** 默认规则表。顺序无关，命中即裁。 */
export const TRIM_RULES: TrimRule[] = [
  {
    name: "测试目录",
    test: (p) => /(^|\/)(test|tests|__tests__)(\/|$)/i.test(p),
  },
  {
    name: "构建与仓库元数据",
    test: (p) =>
      /(^|\/)(\.yarn|\.github)(\/|$)/.test(p) ||
      /(^|\/)(tsconfig[^/]*\.json|\.npmignore|\.gitignore|\.eslintrc[^/]*|\.editorconfig|\.npmrc|\.babelrc[^/]*)$/.test(p),
  },
  {
    name: "文档与示例",
    test: (p) => /(^|\/)(doc|docs|example|examples)(\/|$)/i.test(p),
  },
  {
    name: "快照与夹具",
    test: (p) => /\.snap$/.test(p) || /(^|\/)(__fixtures__|__snapshots__)(\/|$)/.test(p),
  },
];

/** 裁剪报告：总量与按规则明细，供日志与测试断言。 */
export interface TrimReport {
  files: number;
  bytes: number;
  byRule: Record<string, { files: number; bytes: number }>;
}

/** 相对 `node_modules/` 的包名（`@scope/name` 或 `name`）。 */
function packageOf(rel: string): string | null {
  const m = /^(@[^/]+\/[^/]+|[^/]+)\//.exec(rel);
  return m ? m[1] : null;
}

/** 递归列出目录下的普通文件，返回相对 `root` 的路径（统一用 `/`）。 */
function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const rel of fs.readdirSync(root, { recursive: true }).map(String)) {
    const abs = join(root, rel);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.isFile()) out.push(rel.split("\\").join("/"));
  }
  return out;
}

/**
 * 裁剪交付树里的依赖目录。
 *
 * 只处理 `node_modules/`，且跳过 `node_modules/@dshana/`。删掉的文件由规则表与源码判据决定，
 * 返回值给出总量与按规则明细（便于断言「确实裁掉了」与「裁的量在预期量级」）。
 *
 * @param pkgDir 组装台里的包根。
 * @returns 裁剪报告。
 */
export function trimDeliveryTree(pkgDir: string): TrimReport {
  const modules = join(pkgDir, "node_modules");
  const report: TrimReport = { files: 0, bytes: 0, byRule: {} };
  if (!fs.pathExistsSync(modules)) return report;

  const files = listFiles(modules).filter((rel) => !rel.startsWith("@dshana/"));

  // 先扫一遍：哪些包带编译产物。带产物的包，其 .ts/.d.ts 才是可裁的源码。
  const hasProduct = new Set<string>();
  for (const rel of files) {
    if (!PRODUCT_RE.test(rel)) continue;
    const pkg = packageOf(rel);
    if (pkg) hasProduct.add(pkg);
  }

  const bump = (rule: string, bytes: number) => {
    const slot = (report.byRule[rule] = report.byRule[rule] ?? { files: 0, bytes: 0 });
    slot.files += 1;
    slot.bytes += bytes;
    report.files += 1;
    report.bytes += bytes;
  };

  for (const rel of files) {
    if (KEPT_FILE_RE.test(rel)) continue;
    const pkg = packageOf(rel);
    const rule = TRIM_RULES.find((r) => r.test(rel));
    const isSource = SOURCE_RE.test(rel) && pkg !== null && hasProduct.has(pkg);
    if (!rule && !isSource) continue;
    const abs = join(modules, rel);
    let bytes = 0;
    try {
      bytes = fs.statSync(abs).size;
    } catch {
      continue;
    }
    fs.removeSync(abs);
    bump(rule ? rule.name : "包内源码与类型声明", bytes);
  }

  return report;
}

/** 人类可读的裁剪摘要（日志用）。 */
export function describeTrim(report: TrimReport, prefix = "[pack]"): string {
  const lines = [`${prefix} 交付面裁剪：${report.files} 个文件，${(report.bytes / 1048576).toFixed(2)} MiB（压缩前）`];
  for (const [rule, v] of Object.entries(report.byRule).sort((a, b) => b[1].bytes - a[1].bytes)) {
    lines.push(`${prefix}   ${rule}：${v.files} 个，${(v.bytes / 1048576).toFixed(2)} MiB`);
  }
  return lines.join("\n");
}
