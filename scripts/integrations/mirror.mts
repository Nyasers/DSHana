// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/integrations/mirror.mts — 源码镜像的读访问与 overlay 落盘（磁盘侧）。
//
// 镜像 = vendor/deepseek-harness 的 checkout；一切都以 tag 为坐标读（git show / ls-tree），
// 不读工作树，免得构建结果随镜像的检出状态漂移。
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { ROOT } from "../shared/root.mts";
import { dshPin } from "../shared/version.mts";

export const REPO_ROOT = ROOT;
export const MIRROR = join(REPO_ROOT, "vendor", "deepseek-harness");

/**
 * 读 integrations 下各短名目录的 integration.json，附带 dir、root 与**派生的** upstreamVersion。
 *
 * upstreamVersion 取自 dshPin()（全链唯一的内核声明入口，镜像 tag、产物版本串都从它取），
 * 清单里不写它：手写就是第二事实源，pin 一动就漂。
 */
export function loadIntegrations(rootDir = REPO_ROOT) {
  const dir = join(rootDir, "integrations");
  if (!existsSync(dir)) return [];
  const out: any[] = [];
  const upstreamVersion = dshPin();
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const manifest = join(dir, ent.name, "integration.json");
    if (!existsSync(manifest)) continue;
    const it = JSON.parse(readFileSync(manifest, "utf8"));
    if (it.hana !== undefined || it.revision !== undefined) {
      throw new Error(
        `集成 ${ent.name}: integration.json 不得带 hana/revision 字段——`
          + "修订号由 git 历史派生（revisionOf），手写就是第二事实源",
      );
    }
    if (it.upstreamVersion !== undefined) {
      throw new Error(
        `集成 ${ent.name}: integration.json 不得带 upstreamVersion 字段——`
          + "上游版本由 pin 派生（dshPin），手写就是第二事实源",
      );
    }
    out.push({ ...it, dir: ent.name, root: join(dir, ent.name), upstreamVersion });
  }
  return out;
}

/** 镜像是否含该 tag（返回 commit 或 null）。 */
export function mirrorHasTag(tag, mirrorDir = MIRROR) {
  const r = spawnSync("git", ["-C", mirrorDir, "rev-parse", "--verify", "--quiet", tag + "^{commit}"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  return String(r.stdout || "").trim() || null;
}

/** 从镜像的某个 tag 读文件（仓库相对路径 → Buffer；不存在返回 null）。 */
export function readUpstreamFromMirror(repoRelPath, tag, mirrorDir = MIRROR) {
  const r = spawnSync("git", ["-C", mirrorDir, "show", `${tag}:${repoRelPath}`], {
    maxBuffer: 128 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  return r.stdout;
}

/** 镜像里列出某 tag 下某目录的文件（仓库相对路径）。 */
export function listMirrorFiles(tag, dir, mirrorDir = MIRROR) {
  const r = spawnSync("git", ["-C", mirrorDir, "ls-tree", "-r", "--name-only", tag, "--", dir], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`ls-tree 失败：${tag}:${dir}`);
  return String(r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
}

/** 把 overlay 落进 .tmp/integrations/<短名>/（供后续编译步骤消费）。 */
export function stageIntegrations(integrations, rootDir = REPO_ROOT) {
  const staged: string[] = [];
  for (const it of integrations) {
    for (const f of Array.isArray(it.files) ? it.files : []) {
      const src = join(it.root, "files", f.path);
      if (!existsSync(src)) throw new Error(`integration ${it.dir}: overlay 文件缺失 ${src}`);
      const dst = join(rootDir, ".tmp", "integrations", it.dir, f.path);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst);
      staged.push(join(".tmp", "integrations", it.dir, f.path));
    }
  }
  return staged;
}
