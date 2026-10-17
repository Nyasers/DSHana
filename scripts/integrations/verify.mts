// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/integrations/verify.mts — 集成清单的漂移校验（纯函数，导出供单测）。
//
// 闸的意义：overlay 是「上游某版文件 + 我们的 delta」的整文件拷贝，清单记下当时上游文件的
// sha256。构建时用**当前镜像**重算比对；不一致 = 上游动过 → 构建失败并指名要 rebase 的文件。
// 于是"拷贝即冻结"在流程上不可能发生。
//
// 第二道检查（deltaSha256）：上游哈希只能证明「贴的是这一版上游」，证明不了「我们的 delta 还在」。
// rebase 时整份拿上游覆盖、或三方合并把 delta 弄丢，哈希闸一点都不响。于是清单里另记一个
// delta 指纹（由改动的行内容算出、不含行号），每次用同一个口径重算，对不上就是 delta 漂了。
//
// 纯函数：上游文件由调用方以 readUpstream 提供，delta 由 computeDelta 提供，便于单测喂假数据。
import { createHash } from "node:crypto";

import { codedError, errText } from "../shared/err-text.mts";
import { deltaOf } from "./delta.mts";

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
 * 校验一组集成清单（纯函数：上游文件由 readUpstream 提供，delta 由 computeDelta 提供）。
 * 任一处不成立就抛错，错误信息给出「该 rebase 哪个文件、哈希改成什么」。
 * @param {Array<{dir?:string,package?:string,upstreamDir?:string,files?:Array<{path:string,upstreamSha256:string}>}>} integrations
 * @param {(repoRelPath:string)=>Buffer|null} readUpstream 读上游文件（仓库相对路径 → 内容；不存在返回 null）
 * @param {object} [options]
 * @param {(upstream:string,overlay:string)=>{sha256:string}} [options.computeDelta] delta 实现（默认真 git；单测可注入）
 * @param {(name:string,rel:string)=>string|null} [options.readOverlay] 读我们的 overlay；不提供就只校上游哈希
 * @returns {{packages:number, files:number, deltaChecked:number, empty:string[]}}
 */
export function verifyIntegrations(integrations, readUpstream, options = {}) {
  const computeDelta = options.computeDelta ?? deltaOf;
  // 未提供读 overlay 的能力时整道 delta 检查退成「无操作」（旧调用方与单测不必每人都接文件系统）
  const readOverlay = options.readOverlay;
  const problems: string[] = [];
  const empty: string[] = [];
  let files = 0;
  let deltaChecked = 0;
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
            `请把我们的 delta rebase 到 integrations/${name}/files/${rel}，` +
            `并把 upstreamSha256 更新为 ${actual}`,
        );
        continue;
      }
      // 第二道：delta 指纹。清单里没写 deltaSha256 就跳过（向后兼容）；没提供读 overlay 的能力也跳过。
      const recordedDelta = typeof f.deltaSha256 === "string" ? f.deltaSha256.toLowerCase() : null;
      if (readOverlay !== undefined && recordedDelta !== null && /^[0-9a-f]{64}$/.test(recordedDelta)) {
        let overlayText: string | null = null;
        try {
          overlayText = readOverlay(name, rel);
        } catch (e) {
          problems.push(`integration ${name}: 读 overlay ${rel} 失败：${errText(e)}`);
          continue;
        }
        if (overlayText === null) {
          problems.push(`integration ${name}: overlay 文件缺失（integrations/${name}/files/${rel}）`);
          continue;
        }
        const delta = computeDelta(Buffer.from(content).toString("utf8"), overlayText);
        if (delta.sha256 !== recordedDelta) {
          problems.push(
            `integration ${name}: overlay ${rel} 的 delta 漂了 —— 上游哈希对得上（${actual.slice(0, 12)}…），` +
              `但 delta 指纹不对（记录 ${recordedDelta.slice(0, 12)}…，实得 ${delta.sha256.slice(0, 12)}…）。` +
              `多半是 rebase 时我们的改动弄丢了或被整份覆盖；核对后把 deltaSha256 更新为 ${delta.sha256}`,
          );
          continue;
        }
        deltaChecked++;
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
  return { packages: (integrations || []).length, files, deltaChecked, empty };
}
