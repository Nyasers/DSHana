// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/integrations/verify.mts — 集成清单的漂移校验（纯函数，导出供单测）。
//
// 闸的意义：overlay 是「上游某版文件 + 我们的 delta」的整文件拷贝，清单记下当时上游文件的
// sha256。构建时用**当前镜像**重算比对；不一致 = 上游动过 → 构建失败并指名要 rebase 的文件。
// 于是"拷贝即冻结"在流程上不可能发生。
//
// 纯函数：上游文件由调用方以 readUpstream 提供，便于单测喂假数据。
import { createHash } from "node:crypto";

import { codedError, errText } from "../shared/err-text.mts";

/** DSH 版本 → 上游 git tag（release 线形如 dsh-v0.1.5-rc.2）。 */
export function tagForVersion(version) {
  return "dsh-v" + String(version ?? "").trim();
}

/** sha256（hex 小写）。 */
export function sha256(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), "utf8");
  return createHash("sha256").update(b).digest("hex");
}

/** 从 package.json 取 pin 的 DSH 版本。 */
export function dshVersionOf(pkgJson) {
  const v = pkgJson && pkgJson.dependencies && pkgJson.dependencies["@deepseek-ai/dsh"];
  return typeof v === "string" && v ? v : null;
}

/**
 * 校验一组集成清单（纯函数：上游文件由 readUpstream 提供，便于单测）。
 * 任一处不成立就抛错，错误信息给出「该 rebase 哪个文件、哈希改成什么」。
 * @param {Array<{dir?:string,package?:string,upstreamDir?:string,files?:Array<{path:string,upstreamSha256:string}>}>} integrations
 * @param {(repoRelPath:string)=>Buffer|null} readUpstream 读上游文件（仓库相对路径 → 内容；不存在返回 null）
 * @returns {{packages:number, files:number, empty:string[]}}
 */
export function verifyIntegrations(integrations, readUpstream) {
  const problems: string[] = [];
  const empty: string[] = [];
  let files = 0;
  for (const it of Array.isArray(integrations) ? integrations : []) {
    const name = it && (it.dir || it.package) ? String(it.dir || it.package) : "(未命名)";
    const pkg = String((it && it.package) || "");
    if (!pkg) problems.push(`integration ${name}: 缺少 package`);
    const upstreamDir = String((it && it.upstreamDir) || "");
    if (!upstreamDir) problems.push(`integration ${name}: 缺少 upstreamDir`);
    const list = Array.isArray(it && it.files) ? it.files : [];
    if (list.length === 0) empty.push(name);
    for (const f of list) {
      const rel = f && typeof f.path === "string" ? f.path : "";
      if (!rel) {
        problems.push(`integration ${name}: files[] 项缺少 path`);
        continue;
      }
      const recorded = String((f && f.upstreamSha256) || "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(recorded)) {
        problems.push(`integration ${name}: ${rel} 未记录合法的 upstreamSha256（64 位 hex）`);
        continue;
      }
      const upstreamRel = upstreamDir + "/" + rel;
      let content;
      try {
        content = readUpstream(upstreamRel);
      } catch (e) {
        problems.push(`integration ${name}: 读上游 ${upstreamRel} 失败：${errText(e)}`);
        continue;
      }
      if (content === null || content === undefined) {
        problems.push(
          `integration ${name}: 上游不存在 ${upstreamRel}（路径被移动/删除？请核对 upstreamDir 与 files[].path）`,
        );
        continue;
      }
      const actual = sha256(content);
      if (actual !== recorded) {
        problems.push(
          `integration ${name}: overlay ${rel} 已过期 —— 上游 ${upstreamRel} 变了` +
            `（记录 ${recorded.slice(0, 12)}…，实得 ${actual.slice(0, 12)}…）。` +
            `请把我们的 delta rebase 到 src-integrations/${name}/files/${rel}，` +
            `并把 upstreamSha256 更新为 ${actual}`,
        );
        continue;
      }
      files++;
    }
  }
  if (problems.length) {
    throw codedError(
      "集成层漂移校验未通过：\n" + problems.map((p) => "  - " + p).join("\n"),
      { problems },
    );
  }
  return { packages: (integrations || []).length, files, empty };
}
