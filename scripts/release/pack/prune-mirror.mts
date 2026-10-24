// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/prune-mirror.mts — 打包期按剔除名单剃除交付树里某份 cordis.patch.yml 的行。
//
// 为什么需要它：本形态不交付若干包（`excludedPackages()` 的 `"-"` 把它们从依赖图里移除），
// 但上游的 patch 文档里仍挂着指向它们的行。包不在树里而行还在，boot 期就是
// `ERR_MODULE_NOT_FOUND`。所以行必须跟着包一起消失。
//
// 为什么不是 overlay：这些文件的每一条取值都是上游原文，我们一个字都没改过 —— 只要「不要
// 其中若干行」。整文件 overlay 于是只承载这一个信息，却要背 `upstreamSha256`/`deltaSha256`
// 两道校验，上游每次动这份文档都得人工 rebase。剃除把这个信息收敛成「名单 + 一个函数」：
// 上游升版不再失败，名单与根级 overrides 用同一份 `excludedPackages()`。
//
// 为什么用 yaml 解析器而不是按行删：patch 是数据不是文本。一个行块可跨多行（`config`、
// 上方注释、`!!js` 表达式），按行删的边界靠猜；删漏一行得到的是**语法崩坏的 yaml**，而这份
// 文档直接决定 boot。这里用 `yaml` 的 Document API 改对象树再序列化，边界由解析器负责。
//
// 与 `disabled: true` 的区别是本质的：disabled 是「包在树里，只是不加载」，包仍然占体积与
// 依赖面；剃除配合根级 overrides 的 `"-"` 才是「包不在树里、行也不在」。
import fs from "fs-extra";
import { join } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";

import { excludedPackages } from "./exclude.mts";

/** 只做解析所需的 !!/js 标签（值是一段 JS 表达式，原样保留，不执行）。 */
const DSH_JS_TAG = { tag: "tag:yaml.org,2002:js", resolve: (v: unknown) => v };

/** 一次剃除的结果。 */
export interface PruneResult {
  /** 剃完的 yaml 文本。 */
  text: string;
  /** 实际剃掉的行（id，无 id 时用包名）。 */
  removed: string[];
  /** 名单里要求剔除、但文档里没有对应行的包名 —— 该包不在这份 patch 里，属正常。 */
  absent: string[];
}

/** 一行的包名（name 字段；`@pkg/sub` 归到 `@pkg`）。 */
function packageOf(row: unknown): string | null {
  if (!isMap(row)) return null;
  const name = row.get("name");
  if (typeof name !== "string" || name.length === 0) return null;
  return name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]!;
}

/**
 * 按包名名单剃除 patch 行。
 *
 * 只按 `name`（包名）判定，不按 `id`：id 是贴着上游当时措辞起的短名（`otel`、
 * `command-feedback`），跨层不稳定；包名才是跨层稳定的事实，且 `excludedPackages()`
 * 本来就是包名 —— 两边同源，没有第二事实源。
 *
 * `insert` 是分组容器，本身不是可剃的行；其中若挂着命中行就一并剃，剃空了整组丢掉
 * （空 insert 没有意义，留着只是噪声）。
 * @param text - patch 文件原文。
 * @param dropPackages - 要剔除的包名集合。
 * @param label - 报错用的文件名。
 * @returns 剃除结果；yaml 语法有错时抛错（绝不产出坏文档）。
 */
export function prunePatch(text: string, dropPackages: readonly string[], label = "cordis.patch.yml"): PruneResult {
  const doc = parseDocument(text, { customTags: [DSH_JS_TAG] });
  if (doc.errors.length > 0) {
    throw new Error(`${label} 解析失败（上游文档本身有问题？）：${doc.errors.map((e) => e.message).join("; ")}`);
  }
  const contents = doc.contents;
  if (!isSeq(contents)) {
    throw new Error(`${label} 顶层不是行数组（patch 文档的形状变了），拒绝剃除`);
  }

  const drop = new Set(dropPackages);
  const removed: string[] = [];
  const present = new Set<string>();

  /** 递归处理一层行数组，返回保留的行。 */
  const filterRows = (items: readonly unknown[]): unknown[] => {
    const kept: unknown[] = [];
    for (const item of items) {
      if (!isMap(item)) {
        kept.push(item);
        continue;
      }
      const pkg = packageOf(item);
      if (pkg !== null) present.add(pkg);

      if (pkg !== null && drop.has(pkg)) {
        const id = item.get("id");
        removed.push(typeof id === "string" ? id : pkg);
        continue; // 整块丢弃
      }

      // insert 分组：递归剃其中的行，剃空了就把这一组一起丢掉。
      const insert = item.get("insert");
      if (insert !== null && insert !== undefined && isSeq(insert)) {
        const kids = filterRows(insert.items);
        if (kids.length === 0) continue;
        item.set("insert", kids);
      }
      kept.push(item);
    }
    return kept;
  };

  const survivors = filterRows(contents.items);
  const absent = [...drop].filter((name) => !present.has(name));
  (contents as { items: unknown[] }).items = survivors;

  return { text: String(doc), removed, absent };
}

/** 一份待剃的 patch：包里哪份文件、断言至少要剃掉几行。 */
export interface PruneTarget {
  /** 包名（交付树里的目录名来源）。 */
  package: string;
  /** 包内相对路径（如 `cordis.patch.yml`）。 */
  path: string;
  /** 至少应剃掉的行数下限；0 表示不断言。上游改了包名时这里会拦下来。 */
  expectRemoved?: number;
}

/** 本形态要剃的 patch 名单。 */
export const PRUNE_TARGETS: readonly PruneTarget[] = [
  // dsh-base 的共享底座补丁：账号 / 反馈 / 遥测 / 官方 LLM adapter / 会话日志上传 那十条行。
  // 上游原文含这些行，而本形态的推理一律走宿主（`@dshana/dsh-provider` 经 `hana.models`），
  // DSH 侧一个官方 adapter 都不需要。断言 10：上游若把某个包名改掉，按包名匹配就再也碰不上
  // 它，行会静默留成原样而包已不在树里，表现是 boot 期 import 失败 —— 所以下不去就当场报。
  { package: "@deepseek-ai/dsh-base", path: "cordis.patch.yml", expectRemoved: 10 },
];

/**
 * 把剔除应用到交付树里的包补丁。
 *
 * fail-closed：目标包或文件不存在即抛（上游把文件搬到别处 / 包没进树，都要当场知道）；
 * 剃掉的行使数低于 `expectRemoved` 也抛（上游改包名会让匹配静默失效）。
 * @param nodeModulesDir - 交付树的 node_modules
 * @param targets - 待剃清单（默认 {@link PRUNE_TARGETS}）
 * @param dropPackages - 剔除包名集合（默认 `excludedPackages()`）
 */
export function pruneDeliveredPatches(
  nodeModulesDir: string,
  targets: readonly PruneTarget[] = PRUNE_TARGETS,
  dropPackages: readonly string[] = excludedPackages(),
): void {
  for (const target of targets) {
    const file = join(nodeModulesDir, target.package, target.path);
    if (!fs.pathExistsSync(file)) {
      throw new Error(`剔除目标不存在：${target.package}/${target.path}（包没进树？上游把文件搬走了？）`);
    }
    const res = prunePatch(fs.readFileSync(file, "utf8"), dropPackages, `${target.package}/${target.path}`);
    fs.writeFileSync(file, res.text);
    const expect = target.expectRemoved ?? 0;
    if (expect > 0 && res.removed.length < expect) {
      throw new Error(
        `剔除 ${target.package}/${target.path} 只命中 ${res.removed.length} 行，低于下限 ${expect} —— `
          + "多半是上游把某个包名改掉了，剔除名单需同步（否则那些行会留在产物里，而包已不在树里）",
      );
    }
    console.log(
      `[pack] 剔除行：${target.package}/${target.path} 剃掉 ${res.removed.length} 行`
        + `（${res.removed.join(", ") || "无"}）`,
    );
  }
}
