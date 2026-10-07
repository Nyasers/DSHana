// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/check/bundle.mts — 组合层包（packages/dsh/app）的两道闸。
//
// 为什么需要它们：本包是从上游 @deepseek-ai/dsh-web-app 派生的一份**组合文档 + 粘合插件**，
// 它替上游那一层。于是有两类静默漂移没人拦：
//   ① 上游动了我们派生过的文件（补丁文档、presets、粘合插件源码）——我们不跟就悄悄落后；
//   ② 文档里引用的名字与包清单对不上——带 name 的行没声明依赖 → 那一行不从此包解析；
//      只带 id 的行对不到任何上游行 → 那条停用永远静默无操作。
//
// 闸一（上游漂移）：provenance.json 逐份记着派生时的上游 sha256。用 pin 住 tag 的镜像（同一份
// vendor checkout）重算比对，不一致就指名要 rebase 哪一份、新哈希是多少；并报出上游新增/改名
// 而我们不认识的文件（那些要人做决定：纳入派生，还是记进忽略面）。
//
// 闸二（行→包自洽）：两个方向都查——
//   a) 带 name 的行：包名必须在**本包** dependencies 里（行由本包解析）；
//   b) 只带 id 的行：行名必须能在上游两层（dsh-base / 我们派生源那一层）的 patch 里反查到。
// 反方向（dependencies 里有行没引用的包）**不查**：粘合插件自己 import 的那几个（app-boot /
// host-frontend-static / launch-environment / subprocess / schemastery / web-frontend / open /
// commander）本来就没有对应行，列白名单只能养出一份要人工对账的名单，不如不查。
//
// 用法：node scripts/check/bundle.mts
// 退出码：0 通过；1 有漂移/不自洽；2 跑不起来（缺镜像 tag、缺清单）。
import fs from "node:fs";
import path from "node:path";

import * as YAML from "yaml";

import { ROOT } from "../shared/root.mts";
import { isDirectRun } from "../shared/run.mts";
import { errText } from "../shared/err-text.mts";
import { dshPin } from "../shared/version.mts";
import { listMirrorFiles, mirrorHasTag, readUpstreamFromMirror } from "../integrations/mirror.mts";
import { sha256 } from "../integrations/verify.mts";

/** 本包在仓内的位置（组合文档、presets、粘合源码与 provenance 都在这里）。 */
export const BUNDLE_PKG_REL = "packages/dsh/app";

/** 上游两层 patch（id 反查表与"行落点"的来源）。 */
const UPSTREAM_PATCH_DIRS = ["packages/bundle/base", "packages/bundle/web-app"];

/** 派生面之外的、上游同目录里我们不搬运的文件（文档/测试/配置，不属交付物）。 */
const IGNORED_UPSTREAM_FILES: (string | RegExp)[] = [
  "package.json", // 我们那份是改过的（名字、依赖、exports 都不同），自洽性由闸二守
  "tsconfig.json",
  /^README/,
  /^tests\//,
  /^lib\//,
];

/** 只做行级解析所需的 !!js 标签（值是一段 JS 表达式，原样保留）。 */
const DSH_JS_TAG = { tag: "tag:yaml.org,2002:js", resolve: (v: unknown) => v };

/** 一份 patch 源码里的行引用。 */
export interface PatchRefs {
  /** 带 name 的行引用的包名（已去重保序）。 */
  named: string[];
  /** 只带 id 的行名（已去重保序）。 */
  ids: string[];
  /** 全部行名（带 name 的也算；上游 id 反查表用）。 */
  allIds: string[];
}

/**
 * 从一份 patch 源码里抽引用。用 yaml 解析而非正则：patch 是数据不是文本，注释封存的上游行
 * 不能算生效行。
 * @param text - patch 文件内容。
 * @param docErrors - 解析错误收集（非空表示文件本身有问题）。
 */
export function readPatchRefs(text: string, docErrors: string[] = []): PatchRefs {
  const doc = YAML.parseDocument(text, { customTags: [DSH_JS_TAG] });
  for (const e of doc.errors) docErrors.push(e.message);
  const named: string[] = [];
  const ids: string[] = [];
  const allIds: string[] = [];
  const walk = (row: unknown): void => {
    if (row === null || typeof row !== "object") return;
    const r = row as Record<string, unknown>;
    if (Array.isArray(r.insert)) for (const child of r.insert) walk(child);
    if (typeof r.id === "string") allIds.push(r.id);
    const name = typeof r.name === "string" ? r.name : undefined;
    if (name !== undefined) {
      // cordis 虚拟行名（cordis:group 之类）不是包，不参与依赖对账。
      if (!name.includes(":") || name.startsWith("@")) named.push(name);
    } else if (typeof r.id === "string") {
      ids.push(r.id);
    }
  };
  for (const item of doc.contents?.items ?? []) walk((item as { toJSON?: () => unknown }).toJSON?.() ?? item);
  return { named: [...new Set(named)], ids: [...new Set(ids)], allIds: [...new Set(allIds)] };
}

/** 读本包清单与 provenance。 */
export function readBundleFacts() {
  const pkgDir = path.join(ROOT, BUNDLE_PKG_REL);
  return {
    pkgDir,
    pkg: JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")),
    prov: JSON.parse(fs.readFileSync(path.join(pkgDir, "provenance.json"), "utf8")),
  };
}

/** 闸一：逐份对上游 sha256，并报出上游新增/改名。 */
export function checkProvenance(prov: any, tag: string): string[] {
  const problems: string[] = [];
  const carried = new Set<string>();
  for (const f of prov.files ?? []) {
    const rel = `${prov.upstreamDir}/${f.path}`;
    carried.add(String(f.path));
    const buf = readUpstreamFromMirror(rel, tag);
    if (buf === null) {
      problems.push(`上游已无 ${rel}（被改名或删除？请决定：跟随改名，或把这一份记进忽略面）`);
      continue;
    }
    const actual = sha256(buf);
    const recorded = String(f.upstreamSha256).toLowerCase();
    if (actual !== recorded) {
      problems.push(
        `派生面已过期：${f.path}（上游 ${rel} 变了；记录 ${recorded.slice(0, 12)}…，实得 ${actual.slice(0, 12)}…）。`
          + `把 delta rebase 进 ${BUNDLE_PKG_REL}/${f.path}，并把 provenance.json 的 upstreamSha256 更新为 ${actual}`,
      );
    }
  }
  for (const rel of listMirrorFiles(tag, prov.upstreamDir)) {
    const local = String(rel).slice(String(prov.upstreamDir).length + 1);
    if (carried.has(local)) continue;
    if (IGNORED_UPSTREAM_FILES.some((p) => (typeof p === "string" ? p === local : p.test(local)))) continue;
    problems.push(`上游新增/改名而本包未派生：${rel}（决定：纳入派生并记进 provenance，或补进忽略面）`);
  }
  return problems;
}

/**
 * 闸二（纯函数）：行引用与本包声明、与上游行表是否自洽。
 * @param ourRefs - 本包文档与 presets 的行引用。
 * @param dependencies - 本包 package.json 的 dependencies。
 * @param upstreamIds - 上游两层 patch 的全部行名。
 * @param selfName - 本包自己的名字（补丁里引用自己的入口是正常形态，不算缺声明）。
 */
export function checkRows(
  ourRefs: PatchRefs[],
  dependencies: Record<string, string>,
  upstreamIds: Set<string>,
  selfName: string,
): string[] {
  const problems: string[] = [];
  const declared = new Set(Object.keys(dependencies));
  for (const refs of ourRefs) {
    for (const name of refs.named) {
      // 带子路径的引用（如 @deepseek-ai/dsh-tool-cordis/host）落到包本身。
      const pkg = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
      if (pkg === selfName) continue; // 引用自己的入口（web-runtime / web-startup 两行）
      if (!declared.has(pkg)) {
        problems.push(`带 name 的行引用了 ${name}（包 ${pkg}），但本包 dependencies 里没有它——该行不从此包解析`);
      }
    }
    for (const id of refs.ids) {
      if (!upstreamIds.has(id)) {
        problems.push(`只带 id 的行 ${id} 在上游两层里反查不到——这条覆盖/停用永远静默无操作`);
      }
    }
  }
  return problems;
}

function main(): void {
  const pin = dshPin();
  if (!pin) {
    console.error("[bundle] packages/host/package.json 未声明 @deepseek-ai/dsh，无法定位上游 tag");
    process.exit(2);
  }
  const tag = `dsh-v${pin}`;
  if (mirrorHasTag(tag) === null) {
    console.error(`[bundle] 镜像里没有 tag ${tag}（vendor checkout 没跟到这个版本？）`);
    process.exit(2);
  }
  const { pkgDir, pkg, prov } = readBundleFacts();
  const problems: string[] = [];

  problems.push(...checkProvenance(prov, tag));

  // 本包文档 + presets 的行引用
  const presetRels: string[] = (pkg.dsh?.bundle?.patch ?? []).filter((p: string) => p.startsWith("./presets/"));
  const ourFiles = [path.join(pkgDir, "cordis.patch.yml"), ...presetRels.map((p: string) => path.join(pkgDir, p))];
  const docErrors: string[] = [];
  const ourRefs = ourFiles.map((f) => readPatchRefs(fs.readFileSync(f, "utf8"), docErrors));
  if (docErrors.length) problems.push(...docErrors.map((e) => `patch 解析失败：${e}`));

  // 上游两层的行名表
  const upstreamIds = new Set<string>();
  for (const dir of UPSTREAM_PATCH_DIRS) {
    const buf = readUpstreamFromMirror(`${dir}/cordis.patch.yml`, tag);
    if (buf === null) {
      problems.push(`读上游 ${dir}/cordis.patch.yml 失败（tag ${tag}）`);
      continue;
    }
    for (const id of readPatchRefs(buf.toString("utf8")).allIds) upstreamIds.add(id);
  }

  problems.push(...checkRows(ourRefs, pkg.dependencies ?? {}, upstreamIds, String(pkg.name ?? "")));

  if (problems.length) {
    console.error("[bundle] 组合层闸未通过：\n" + problems.map((p) => "  - " + p).join("\n"));
    process.exit(1);
  }
  const rows = ourRefs.reduce((n, r) => n + r.named.length + r.ids.length, 0);
  console.log(
    `[bundle] 通过：派生面 ${(prov.files ?? []).length} 份对上游 ${tag} 一致；行 ${rows} 条与 dependencies`
      + `（${Object.keys(pkg.dependencies ?? {}).length} 个）自洽`,
  );
}

if (isDirectRun(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`[bundle] 闸本身跑不起来：${errText(e)}`);
    process.exit(2);
  }
}
