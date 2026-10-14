// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/tools/src/actions/presets.ts — dshana presets：列出可选的 agent preset
//
// 为什么需要：`open` 的 `agentPreset` 是**透传值**，DSH 按当前 roster 解析，App 侧不白名单
// （roster 由 profile 各 bundle 的声明决定，用户装的包也能贡献）。而这个值的可接受集合没有任何
// 程序化入口：名字不在 roster 上时，DSH 只回
// `agent-preset/not-found Unknown agent preset: <id>`——只报传进去的那个，不带可用列表。
// 于是调用方只能靠猜，猜错一次才拿到一行错误。本 action 把 roster 显式读出来。
// 取数共用 packages/session/src/preset-roster.ts（`dshana open` 的预检也读同一份）：其中封装了
// 控制面调用——Remote 端点 `<namespace>/<method>`，本处即 `agentPresets/list`（实现是 registry 的
// `remoteExportList`，见 vendor 的 agent-preset-registry/src/index.ts）。不读 profile 文件、不猜包清单：
// 定义体可以是任意已装 bundle 的补丁，文件里那份不是事实源，registry 的内存态才是。
//
// 只读：不建会话、不改任何状态（查询本身要求 runtime 就绪，与 get 同口径）。
import { readPresetRoster, presetIds } from "@dshana/session/preset-roster.ts";
import type { PresetRosterRow } from "@dshana/session/preset-roster.ts";
import type { ToolCtx } from "@dshana/shared/host.ts";
import type { ToolInputBase, ToolResult } from "../shared/types.ts";

export const command = "presets";
export const summary = "list the agent presets this deployment offers";
export const readOnly = true;

/** 本 action 无专属字段：roster 是全量读，不按 id 过滤（要看某一个的挂载明细用 DSH 自己的设置页）。 */
export const fields = {};

/** 一行 roster → 一行文本（id 必在；其余存在才拼，broken 单独标）。 */
export function formatRow(row: PresetRosterRow): string {
  // 导出函数，调用方不受 parsePresetRoster 的行级过滤保护：每一处读都经 `row?.`。
  const id = String(row?.id ?? "").trim();
  const parts = [id];
  const name = typeof row?.name === "string" && row.name ? row.name : "";
  if (name) parts.push("（" + name + "）");
  const notes: string[] = [];
  if (row?.isDefault === true) notes.push("默认");
  const order = typeof row?.order === "number" && Number.isFinite(row.order) ? row.order : null;
  if (order !== null) notes.push("order " + order);
  if (typeof row?.broken === "string" && row.broken) notes.push("挂载失败：" + row.broken.split("\n")[0]);
  return parts.join("") + (notes.length ? "  [" + notes.join("；") + "]" : "");
}

/**
 * roster 行 → 模型面文本（抬头 + 每行 + 用法）。
 *
 * 与 formatRow 分开导出：run 要读 runtime，测不到，而这段文案有要守的约定（不说“不会怎样”
 * 这类否定式：那等于暗示本来可能如此），得能单独钉住。
 */
export function renderRoster(rows: PresetRosterRow[]): string {
  const lines = rows.map(formatRow);
  const brokenCount = rows.filter((r) => typeof r?.broken === "string" && r.broken).length;
  const header = "agent preset roster（" + rows.length + " 项" + (brokenCount ? "，其中 " + brokenCount + " 项挂载失败" : "") + "）：";
  const body = lines.length ? lines.join("\n") : "（roster 为空：该部署没有声明任何 preset，会话使用 Host 组合）";
  const guidance = [
    "",
    "用法：open 的 agentPreset 取以上任一 id，空表示交给 DSH 的默认；该名字原样传给 DSH。",
    "该值在会话开跑后锁定，要换预设得开新会话。",
  ].join("\n");
  return header + "\n" + body + guidance;
}

/** 动作入口：读 roster 并渲染成模型面文本。 */
export async function run(input: ToolInputBase, ctx: ToolCtx): Promise<ToolResult> {
  let rows: PresetRosterRow[] = [];
  try {
    rows = await readPresetRoster(ctx);
  } catch (e) {
    const msg = (e as any)?.message || String(e);
    return {
      ok: false,
      error: "agent preset roster 读取失败：" + msg,
      content: [
        {
          type: "text",
          text:
            "读不到 agent preset roster（" + msg + "）。稍后重试；若 DSH 未就绪，open 本身也会给出同样的失败。",
        },
      ],
      details: { dsh: { action: "presets", ok: false } },
    };
  }

  return {
    ok: true,
    content: [{ type: "text", text: renderRoster(rows) }],
    details: {
      dsh: {
        action: "presets",
        ok: true,
        count: rows.length,
        ids: presetIds(rows),
        presets: rows,
      },
    },
  };
}
