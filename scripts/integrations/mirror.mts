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

export const REPO_ROOT = ROOT;
export const MIRROR = join(REPO_ROOT, "vendor", "deepseek-harness");

/** 读 integrations 下各短名目录的 integration.json，附带 dir 与 root。 */
export function loadIntegrations(rootDir = REPO_ROOT) {
  const dir = join(rootDir, "src-integrations");
  if (!existsSync(dir)) return [];
  const out: any[] = [];
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
    out.push({ ...it, dir: ent.name, root: join(dir, ent.name) });
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

/** 把 overlay 落进 _tmp/integrations/<短名>/（供后续编译步骤消费）。 */
export function stageIntegrations(integrations, rootDir = REPO_ROOT) {
  const staged: string[] = [];
  for (const it of integrations) {
    for (const f of Array.isArray(it.files) ? it.files : []) {
      const src = join(it.root, "files", f.path);
      if (!existsSync(src)) throw new Error(`integration ${it.dir}: overlay 文件缺失 ${src}`);
      const dst = join(rootDir, "_tmp", "integrations", it.dir, f.path);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst);
      staged.push(join("_tmp", "integrations", it.dir, f.path));
    }
  }
  return staged;
}
