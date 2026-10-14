// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/session/src/preset-roster.ts — agent preset roster 的读取与校验（单一实现）
//
// 两处消费者，同一份实现：
//   · `dshana presets`（packages/tools/src/actions/presets.ts）——把 roster 显式列给调用方；
//   · `open` 的提交链（session-run.ts）——在建立 Hana 任务**之前**校验 agentPreset，
//     把「名字不在 roster 上」变成一条带候选的立即拒绝。
//
// 为什么要有那个前置校验：`agentPreset` 是无白名单的透传值，名字错时 DSH 只回
// `agent-preset/not-found Unknown agent preset: <id>`——只报传进去的那个，不带可用列表。
// 而提交链是「先建宿主任务、再建 DSH 会话」，于是错名字会留下一条 failed 的废任务记录，
// 调用方还得从一次后台失败里反推原因。预检把它挪到建任务之前。
//
// 取数走控制面（与 get 同一入口，见 packages/runtime/src/controller.ts）：Remote 端点写作
// `<namespace>/<method>`（typert 的 typertEndpoint），本处即 `agentPresets/list`，实现是 registry
// 的 `remoteExportList`。不读 profile 文件、不猜包清单：preset 定义体可以是任意已装 bundle 的补丁，
// 文件里那份不是事实源，registry 的内存态才是——用户从插件页装的包贡献的 preset 同样在列。
import { z } from "zod";
import { ensureManagedRuntime } from "@dshana/runtime/managed-runtime.ts";
import { rpcViaControl } from "@dshana/runtime/controller.ts";

/** roster 里一行（registry 的 AgentPresetRow + isDefault；字段存在才带）。 */
export interface PresetRosterRow {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  order?: unknown;
  isDefault?: unknown;
  /** 挂载失败的原因；absent 表示该项当前可用。 */
  broken?: unknown;
}

/** 受管 runtime 就绪（单例；未起则启动到 ready）。失败时给可读原因。 */
async function ensureReady(): Promise<void> {
  try {
    await ensureManagedRuntime({});
  } catch (e) {
    throw new Error(
      "DSH managed runtime not ready (the preset roster needs it online): " + ((e as any)?.message || e),
    );
  }
}

/**
 * 读当前部署的 preset roster（含挂载失败的项）。
 *
 * 失败一律上抛（不识别的部署、runtime 起不来）：调用方各自决定怎么处置——`presets` 把它渲染成
 * 一次读失败，`open` 的预检靠它区分「名字确实错」与「读不到 roster 所以没法判」。
 */
export async function readPresetRoster(ctx: unknown): Promise<PresetRosterRow[]> {
  await ensureReady();
  const roster = await rpcViaControl(ctx, { method: "agentPresets/list", payload: {}, timeoutMs: 30000 });
  return roster && Array.isArray((roster as { presets?: unknown }).presets)
    ? ((roster as { presets: PresetRosterRow[] }).presets)
    : [];
}

/** id 集合（非字符串/空白的项跳过；roster 是外部数据，逐个收窄）。 */
export function presetIds(rows: readonly PresetRosterRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (id) out.push(id);
  }
  return out;
}

/**
 * 待用 id 是否在 roster 上。
 *
 * `broken` 的项也算「在 roster 上」：那是「这个 id 被声明了、但当前挂不起来」——报错该说挂载
 * 失败的原因，不该说名字不存在。两种情况都拦，但理由不同，所以分别判。
 */
export function findPreset(rows: readonly PresetRosterRow[], id: string): PresetRosterRow | undefined {
  // 两侧都 trim：id 词表本就不含空格（小写字母/数字/连字符），到这里的值与 roster 里的字面量
  // 都在比较点归一，任何调用方都拿到同一行为（不要求上游先 trim 过）。
  const want = String(id ?? "").trim();
  return rows.find((row) => (typeof row?.id === "string" ? row.id.trim() : "") === want);
}

/** 挂载失败原因的首行（registry 的 diagnostic 可能是多行；报错只取一行）。 */
export function brokenReason(row: PresetRosterRow | undefined): string {
  return row && typeof row.broken === "string" && row.broken ? row.broken.split("\n")[0] : "";
}

/**
 * 名字不在 roster 上时的拒绝理由。照仓库既有的错误口径：说错在哪，也说下一步去哪看。
 *
 * 候选列表按 roster 顺序原样列出（含 broken 的项——「有这个 id 但挂不了」是调用方要知道的事，
 * 只是这里只报名字，具体原因由 presets action 或 DSH 设置页给）。列表在错误文本里，因为
 * `agent-preset/not-found` 那条只报传进去的那个值。
 */
export function unknownPresetError(id: string, rows: readonly PresetRosterRow[]): Error {
  const ids = presetIds(rows);
  const available = ids.length > 0 ? ids.join(", ") : "(none — this deployment declares no presets)";
  return new Error(
    "unknown agent preset \"" + id + "\" (this deployment offers: " + available +
      "). Run action=presets for names and roles; an empty value leaves the preset to DSH.",
  );
}

/**
 * 用**运行期**候选把名字校成 zod enum，报错交给 zod 出。
 *
 * 为什么不在模型面的 `fields.agentPreset` 上挂 enum：那份 schema 是**注册期快照**，而 roster 是
 * 运行时的（随 profile 装了哪些 bundle 变）。把它复制进 schema 就是造了第二处真相，还得靠
 * 「roster 变了就重注册」去同步——而 roster 变化的事件 App 侧拿不到。所以分两层：模型面只声明
 * 类型（`z.string()`），真正在校验时用当时读到的候选造 enum。
 *
 * 用 `z.enum` 而不是自拼文案：报错原文与 zod 的 enum 一致（`Invalid option: expected one of
 * "a"|"b"`），候选由 zod 自己排；调用方看到的形态与其它字段的 zod 报错同形。
 *
 * 候选为空（该部署没声明任何 preset）时不构造 enum（`z.enum([])` 无合法值，报错也没有内容）：
 * 直接抛 unknownPresetError，那条会说清「本部署没声明 preset」。
 * @param id - 待校的名字。
 * @param rows - 运行期读到的 roster。
 */
export function assertPresetInRoster(id: string, rows: readonly PresetRosterRow[]): void {
  const ids = presetIds(rows);
  // 候选为空时不构造 enum：`z.enum([])` 无合法值，报错也没有内容，不如说清「本部署没声明 preset」。
  if (ids.length === 0) throw unknownPresetError(id, rows);
  const parsed = z.enum(ids as [string, ...string[]]).safeParse(id);
  if (!parsed.success) {
    // 主体用 zod 自己的枚举报错（它把候选排好了），再补一句去哪儿看——zod 不知道本工具还有个
    // `presets` action，那句指路只能由我们加。
    const issue = parsed.error.issues[0];
    throw new Error(
      (issue?.message ?? String(parsed.error.message)) +
        ". Run action=presets for names and roles; an empty value leaves the preset to DSH.",
    );
  }
}

/** 名字在 roster 上但当前挂载失败时的拒绝理由。 */
export function brokenPresetError(id: string, reason: string): Error {
  return new Error(
    "agent preset \"" + id + "\" is declared but currently cannot compose a session: " + reason +
      ". Run action=presets for the roster, or pick another preset.",
  );
}
