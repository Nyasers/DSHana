// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/package-facts.mts — 出包作业记录产物事实的入口。
//
// 出包作业跑完 pack 之后调用一次：把 releases/ 里本目标的 zip（字节数 + sha256）记成
// package-facts.json，作为小 artifact 交给下游的清单作业合并（见 scripts/release/facts.mts）。
//
// 用法：
//   node scripts/release/package-facts.mts                       # releases/ → package-facts.json
//   node scripts/release/package-facts.mts --dir <目录> --out <文件>
import { join } from "node:path";
import { parseArgs } from "node:util";

import { ROOT } from "../shared/root.mts";
import { errText } from "../shared/err-text.mts";
import { recordFacts, writeFacts } from "./facts.mts";

/** 参数问题（退出码 2）与运行失败（退出码 1）。 */
function fail(code: number, message: string): never {
  console.error(`[package-facts] ${message}`);
  process.exit(code);
}

const parsed = (() => {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      options: { dir: { type: "string" }, out: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    fail(2, `参数解析失败：${errText(error)}（用法：--dir <目录> --out <文件>）`);
  }
})();

const releases = parsed.values.dir ?? join(ROOT, "releases");
const out = parsed.values.out ?? "package-facts.json";

const facts = recordFacts(releases);
if (Object.keys(facts).length === 0) fail(1, `${releases} 里没有带 .sha256 的 zip`);
writeFacts(out, facts);
console.log(`[package-facts] 记下 ${Object.keys(facts).length} 份事实 → ${out}`);
for (const [name, fact] of Object.entries(facts)) {
  console.log(`  ${name}  ${fact.size} 字节  ${fact.sha256.slice(0, 12)}…`);
}
