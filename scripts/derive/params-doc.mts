// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/derive/params-doc.mts — dshana 参数参照生成（derive 的 skill-params 任务）
//
// 形状照 PTC 的 SDK 生成（@deepseek-ai/dsh-tools）：那边把各工具的模型面 schema 投影成一段
// 声明文本（jsonSchemaToTs 负责节点→类型文本的纯投影，renderToolsSdk 负责确定性装配），文本
// 进系统提示词。这里做同一件事，读者换成 Hana：把 dshana 的 parameters 投影成技能包里的
// references/parameters.md，由 SKILL.md 指过去按需读。
//
// 为什么生成：SKILL.md 原先手写一张 Required/Optional 表，与 parameters 是同一事实的两份副本，
// 改一次工具就要回去对齐一次，漏改则模型照着旧表传参。生成后只剩一份源，`derive --check` 拦漂移。
//
// 边界：**只投影 schema 能表达的东西**。跨字段约束（目标二选一、至少一个）不在 schema 里
// （discriminatedUnion 的分支只能是普通 ZodObject，挂 refine 会在构造时抛错），照旧手写在
// SKILL 正文，本文件不代它发言——那半是人的判断，推导不出来。
import { ACTIONS, parameters } from "@dshana/tools/index.ts";

import type { FileTask } from "./index.mts";

/** 产物路径（相对仓库根；随包 skills/ 由 build 整树拷进 dist）。 */
const OUT_REL = "skills/dshana/references/parameters.md";

/** 一个字段的投影（全部来自模型面 JSON Schema，不另立一份人工表）。 */
interface FieldDoc {
  name: string;
  type: string;
  required: boolean;
  description: string;
  /** schema 里带约束关键字的字段：约束原文（可读化，不做解释）。 */
  constraints: string[];
}

/** 带约束的关键字（出现即如实带出；当前只有 sessionId 的 pattern 命中）。 */
const CONSTRAINT_KEYS = ["pattern", "minLength", "maxLength", "format", "minimum", "maximum"];

function literalText(v: unknown): string {
  return typeof v === "string" ? "`" + v + "`" : String(v);
}

/**
 * 一个 JSON-Schema 节点 → 人读类型文本。与 PTC 的 jsonSchemaToTs 同位：纯投影，畸形或
 * 未支持的节点降级成 `unknown`，不抛错（宿主给的是自家生成的 schema，降级只为不因一处未知
 * 形状炸掉整份参照）。
 */
function typeText(node: unknown): string {
  if (!node || typeof node !== "object") return "unknown";
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.oneOf)) return n.oneOf.map(typeText).join(" | ");
  if ("const" in n) return literalText(n.const);
  if (Array.isArray(n.enum)) return n.enum.map(literalText).join(" | ");
  switch (n.type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return n.items === undefined ? "array" : typeText(n.items) + "[]";
    case "object":
      return "object";
    default:
      return "unknown";
  }
}

/** 表格单元格里的 `|` 会截断表格，转义掉。 */
const cell = (text: string) => text.replace(/\|/g, "\\|");

/** 一份分支（parameters.oneOf 的一支）→ 字段投影（不含判别键 action）。 */
function projectBranch(branch: any): FieldDoc[] {
  const properties = branch && typeof branch.properties === "object" ? branch.properties : {};
  const required = new Set(Array.isArray(branch?.required) ? branch.required : []);
  return Object.entries(properties)
    .filter(([name]) => name !== "action")
    .map(([name, node]) => {
      const n = (node && typeof node === "object" ? node : {}) as Record<string, unknown>;
      const constraints = CONSTRAINT_KEYS.filter((k) => n[k] !== undefined).map(
        (k) => "`" + k + "` = `" + String(n[k]) + "`",
      );
      return {
        name,
        type: typeText(n),
        required: required.has(name),
        description: typeof n.description === "string" ? n.description : "",
        constraints,
      };
    });
}

/** 固定抬头：与 PTC 的「固定使用说明 + 声明」同形，先讲这份文件是什么、源在哪、怎么改。 */
const HEADER = `# dshana — parameter reference

Generated from the tool's zod definition (\`packages/tools/src/\`), the same source that produces
the model-facing \`parameters\` JSON Schema and validates every call before dispatch. It cannot
drift from what the tool accepts: edit that source and run
\`node scripts/derive/index.mts skill-params\` (\`derive --check\` fails on drift).

Field descriptions are the model-facing text, and \`Required\` mirrors the schema's \`required\`
array. Cross-field rules that no argument schema can express — a target must be exactly one of
\`taskId\` / \`sessionId\`, \`close\` and \`get\` need at least one, \`open\` takes no \`sessionId\` —
are stated in \`SKILL.md\`, not here.`;

/**
 * 渲染整份参照。确定性：action 按注册表顺序、字段按 schema 声明顺序，同一份定义产出
 * 字节一致的文本（\`derive --check\` 靠这一点）。
 */
export function renderParamsDoc(): string {
  const summaries = new Map<string, string>(ACTIONS.map((mod) => [mod.command, mod.summary]));
  const branches: any[] = Array.isArray(parameters.oneOf) ? parameters.oneOf : [];

  const sections = branches.map((branch) => {
    const command = String(branch?.properties?.action?.const ?? "");
    const fields = projectBranch(branch);
    const lines = [
      "## `" + command + "` — " + (summaries.get(command) || ""),
      "",
      "| Field | Type | Required | Description |",
      "|---|---|---|---|",
    ];
    for (const f of fields) {
      const description = [f.description, ...f.constraints].filter(Boolean).join(" · ");
      lines.push(
        "| `" + f.name + "` | " + cell(f.type) + " | " + (f.required ? "yes" : "no") + " | " + cell(description) + " |",
      );
    }
    return lines.join("\n");
  });

  return HEADER + "\n\n" + sections.join("\n\n") + "\n";
}

/** 任务：skill-params —— 工具域的 zod 定义 → 技能包里的参数参照。 */
export const paramsDocTask: FileTask = {
  kind: "file",
  name: "skill-params",
  about: "packages/tools/src/ 的 zod 定义 → skills/dshana/references/parameters.md（技能参照）",
  plan: () => [{ rel: OUT_REL, content: renderParamsDoc() }],
};
