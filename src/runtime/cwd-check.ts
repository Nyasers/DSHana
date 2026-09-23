// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/cwd-check.ts — 会话工作目录的可用性判定（runtime 半）
//
// 为什么这件事归 runtime：App 宿主半的 node:fs 只覆盖应用自己的目录（应用包 + dataDir），用户侧
// 路径 stat 不到，而且失败原因与「目录不存在」在 errno 上分不开——两者混为一谈会把每一个合法
// cwd 都判成不存在。runtime 是真正 spawn 命令的进程，cwd 也交给它用，所以结论由它出。
//
// 为什么用异步 stat：本进程同时在服务中继与 DSH 请求，同步 API 会把事件循环一起按住——网络盘或
// 挂载点上的一次卡顿就是整条控制面卡顿，App 侧的请求超时也救不回来。
//
// 结果结构化返回、不抛错：调用方要区分「确实没有」与「有但用不了」，两者的处置不同。
import { stat } from "node:fs/promises";

export interface CwdCheckResult {
  ok: boolean;
  /** ok=true 时有效：路径是否是目录。 */
  isDirectory?: boolean;
  /** ok=false 时的 errno 码（ENOENT / ENOTDIR / EACCES…）；拿不到时为 null。 */
  code?: string | null;
  /** ok=false 时的可读原因。 */
  message?: string;
}

/** 判一个路径能否当会话工作目录用。只读一次 stat：不创建、不修改、不 chdir。 */
export async function checkCwd(cwd: unknown): Promise<CwdCheckResult> {
  const path = typeof cwd === "string" ? cwd.trim() : "";
  if (!path) return { ok: false, code: "EINVAL", message: "cwd 不能为空" };
  try {
    return { ok: true, isDirectory: (await stat(path)).isDirectory() };
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    const code = err && typeof err.code === "string" ? err.code : null;
    const message = err && typeof err.message === "string" ? err.message : String(e);
    return { ok: false, code, message };
  }
}
