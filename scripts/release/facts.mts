// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/facts.mts — 产物事实（包名 / 字节数 / sha256）的记录与合并。
//
// 为什么事实要单独走一趟：市场清单的每个 entry 都要包的大小与 sha256，而清单作业与出包作业隔着
// 一个 job 边界，没有共享磁盘。让出包作业顺手记一份几百字节的事实文件当 artifact，清单作业合并
// 它即可——不必把上百 MB 的包搬第二遍。量 artifact 归档自身的 size 是不行的：那是外层 zip 的
// 大小，与包的字节数不是一个数。
import fs from "fs-extra";
import { join } from "node:path";

/** 一个包的产物事实：字节数与 sha256（小写）。 */
export interface PackageFact {
  size: number;
  sha256: string;
}

/** zip 文件名 → 事实。 */
export type PackageFacts = Record<string, PackageFact>;

/**
 * 读一个 releases 目录里每个 zip 与它旁边的 .sha256，记成事实表。
 * 缺 .sha256 的 zip 跳过（那不是本流程产出的完整件），目录不存在则视为空。
 * @param releases - 产物所在目录。
 */
export function recordFacts(releases: string): PackageFacts {
  const facts: PackageFacts = {};
  if (!fs.existsSync(releases)) return facts;
  for (const name of fs.readdirSync(releases)) {
    if (!name.endsWith(".zip")) continue;
    const shaFile = join(releases, `${name}.sha256`);
    if (!fs.existsSync(shaFile)) continue;
    facts[name] = {
      size: fs.statSync(join(releases, name)).size,
      sha256: fs.readFileSync(shaFile, "utf8").trim().split(/\s+/)[0].toLowerCase(),
    };
  }
  return facts;
}

/**
 * 合并一个目录下（含子目录）所有 `package-facts.json`。artifact 解下来的目录形状由下载动作决定，
 * 所以按名字递归找，不假定层级。
 * @param dir - 事实文件所在目录。
 */
export function mergeFacts(dir: string): PackageFacts {
  const merged: PackageFacts = {};
  if (!fs.existsSync(dir)) return merged;
  for (const rel of fs.readdirSync(dir, { recursive: true }).map(String)) {
    if (!rel.endsWith("package-facts.json")) continue;
    Object.assign(merged, fs.readJsonSync(join(dir, rel)) as PackageFacts);
  }
  return merged;
}

/** 写一份事实文件（带末尾换行，便于 diff 与人工查看）。 */
export function writeFacts(path: string, facts: PackageFacts): void {
  fs.writeFileSync(path, `${JSON.stringify(facts, null, 2)}\n`, "utf8");
}
