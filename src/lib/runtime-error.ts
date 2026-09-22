// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/runtime-error.ts — 受管 runtime 启动失败的诊断归一（纯函数）
//
// 形态借自官方桌面壳的 startup-error / fatal-recovery：失败面要给用户看的是
// **成因**（含嵌套 AggregateError 的每一层、以及子进程诊断的末尾若干行），不是一句
// 与成因无关的罐头提示。子进程退出码只能归类「哪一类失败」，真实的报错文本随
// 结构化失败报告（src/runtime/main.ts 写、managed-runtime.ts 读）一起回来。
//
// 三个纯函数：
//   runtimeErrorState(error)  —— 把任意抛出值展开成 { message }（AggregateError 递归拼各层）
//   diagnosticTail(text)      —— 诊断文本的有界尾巴（末尾若干行 + 截断标记 + 半个代理对裁剪）
//   parseRuntimeFatal(raw)    —— 校验并归一子进程写下的结构化失败报告

/** 诊断尾巴保留的行数与字符上限（与官方桌面壳对话框 detail 同量级，避免撑爆卡片）。 */
export const DIAGNOSTIC_TAIL_LINES = 8;
export const DIAGNOSTIC_TAIL_CHARS = 1200;

/** 诊断被截断时的提示行（用户可据此知道「还有更早的诊断」，去看宿主/runtime 日志）。 */
export const DIAGNOSTIC_TRUNCATED = "…（诊断已截断，仅保留末尾；完整内容见 App 日志/runtime 日志）";

/** 子进程写下的结构化失败报告（src/runtime/main.ts 的 reportFatal 产物）。 */
export interface RuntimeFatalReport {
  /** 归类（port-busy / boot-failed / auth-exchange / bridge-bind / deps …），供 App 侧对照 START_ERROR_HINTS。 */
  readonly kind: string;
  /** 主成因文本（已展开嵌套）。 */
  readonly message: string;
  /** 附加的成因层（AggregateError 各层、上下文），可为空。 */
  readonly causes: readonly string[];
}

/**
 * 把任意抛出值展开成可读文本。AggregateError 的每一层递归拼进来（官方桌面壳
 * desktopErrorState 同形），因为 DSH 的 boot 失败常把根因包在聚合错误里。
 * @param error - 启动/运行失败值（类型未知）。
 * @returns { message } —— 已去掉空白的多行文本。
 */
export function runtimeErrorState(error: unknown): { message: string } {
  const message = error instanceof AggregateError
    ? [error.message, ...error.errors.map((item) => runtimeErrorState(item).message)]
        .filter((part) => typeof part === "string" && part.trim() !== "")
        .join("\n")
    : error instanceof Error
      ? error.message
      : String(error);
  return { message: String(message).trim() };
}

/**
 * 诊断文本的有界尾巴：超长时只留末尾若干行，前置截断提示；并裁掉落在半个
 * 代理对（surrogate pair）上的首字符，避免渲染出孤立代理项。
 * @param text - 原始诊断文本。
 * @param maxChars - 结果字符上限（默认 DIAGNOSTIC_TAIL_CHARS）。
 * @param keepLines - 截断时保留的末尾行数（默认 DIAGNOSTIC_TAIL_LINES）。
 * @returns 有界诊断文本。
 */
export function diagnosticTail(
  text: string,
  maxChars = DIAGNOSTIC_TAIL_CHARS,
  keepLines = DIAGNOSTIC_TAIL_LINES,
): string {
  const raw = typeof text === "string" ? text : String(text ?? "");
  const trimmed = raw.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const tail = trimmed.split(/\r\n|[\n\r\u2028\u2029]/u).slice(-keepLines).join("\n");
  const budget = Math.max(0, maxChars - DIAGNOSTIC_TRUNCATED.length - 1);
  const shortened = tail.slice(-budget).replace(/^[\uDC00-\uDFFF]/u, "");
  return `${DIAGNOSTIC_TRUNCATED}\n${shortened}`;
}

/**
 * 校验并归一子进程写下的结构化失败报告；形状不符返回 null（调用方回落到退出码归类）。
 * @param raw - 报告文件解析出的值（类型未知）。
 * @returns 归一后的报告，或 null。
 */
export function parseRuntimeFatal(raw: unknown): RuntimeFatalReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.ok !== false) return null;
  const kind = typeof obj.kind === "string" && obj.kind ? obj.kind : "unknown";
  const message = typeof obj.message === "string" ? obj.message.trim() : "";
  if (!message) return null;
  const causes = Array.isArray(obj.causes)
    ? obj.causes.filter((c): c is string => typeof c === "string" && c.trim() !== "")
    : [];
  return { kind, message, causes };
}

/**
 * 把结构化失败报告合成一条面向用户的诊断文本：主成因 + 各成因层（去重、有界）。
 * @param report - parseRuntimeFatal 的产物。
 * @returns 供 boot-state error.userText 使用的文本。
 */
export function fatalReportText(report: RuntimeFatalReport): string {
  const lines = [report.message, ...report.causes.filter((c) => c !== report.message)];
  return diagnosticTail([...new Set(lines)].join("\n"));
}