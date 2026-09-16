// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/integrations/index.mts — 集成层 CLI（见 src-integrations/README.md 与 specs/current/hana-integrations）
//
// 用法：
//   node scripts/integrations/index.mts verify          # 镜像版本一致 + 每个 overlay 记录的上游哈希仍成立
//   node scripts/integrations/index.mts stage           # verify 后把 overlay 落进 _tmp/integrations/<短名>/
//   node scripts/integrations/index.mts hash <仓库相对路径>   # 打印上游该文件的 sha256（写清单时用）
//   node scripts/integrations/index.mts list
//
// 闸的意义：overlay 是「上游某版文件 + 我们的 delta」的整文件拷贝，清单记下当时上游文件的 sha256。
// 构建时用**当前镜像**重算比对；不一致 = 上游动过 → 构建失败并指名要 rebase 的文件。
// 于是"拷贝即冻结"在流程上不可能发生。
//
// 分工：校验纯函数在 verify.mts，镜像访问与落盘在 mirror.mts，编译进包在 build.mts；
// 本文件是 CLI 门面（子命令表 + 过闸），退出码 2 = 用法/子命令错，1 = 运行期失败。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { errText } from "../shared/err-text.mts";
import { isDirectRun } from "../shared/run.mts";
import { buildIntegrations } from "./build.mts";
import { REPO_ROOT, loadIntegrations, mirrorHasTag, readUpstreamFromMirror, stageIntegrations } from "./mirror.mts";
import { dshVersionOf, sha256, tagForVersion, verifyIntegrations } from "./verify.mts";

interface CommandContext {
  tag: string;
  version: string;
}

/**
 * 过闸：镜像 tag 必须在，漂移校验必须过。失败一律抛错，由 main 统一收口成 exit 1。
 * @returns {any[]} 集成清单（stage / build 接着用）
 */
async function gate(tag, version) {
  const commit = mirrorHasTag(tag);
  if (!commit) {
    throw new Error(
      `源码镜像不一致：vendor/deepseek-harness 里没有 tag ${tag}。\n` +
        `  pin 的 DSH 版本是 ${version}；请先把镜像跟到该版本：\n` +
        `  git -C vendor/deepseek-harness fetch --no-tags origin tag ${tag}`,
    );
  }
  console.log(`[integrations] 镜像 ${tag} = ${commit.slice(0, 9)}（pin ${version}）`);
  const integrations = loadIntegrations();
  const result = verifyIntegrations(integrations, (rel) => readUpstreamFromMirror(rel, tag));
  console.log(`[integrations] 漂移闸通过：${result.packages} 个集成、${result.files} 个 overlay 文件`);
  if (result.empty.length) {
    console.log(`[integrations] 注意：以下集成尚无 overlay（批次未落地）：${result.empty.join(", ")}`);
  }
  return integrations;
}

/**
 * 子命令表：**键即白名单、值即实现**。校验与分发同一份事实源，加子命令只需在这里加一项。
 * 未知子命令当场 exit 2——否则拼错的 `buid` 会落进默认分支，白跑一次 verify 后报成功。
 *
 * 用 satisfies 而非类型注解：既校验值的形状，又保留键的字面量类型，默认值靠它约束。
 */
const COMMANDS = {
  hash: async ({ tag }: CommandContext) => {
    const rel = process.argv[3];
    if (!rel) throw new Error("用法：node scripts/integrations/index.mts hash <仓库相对路径>");
    const buf = readUpstreamFromMirror(rel, tag);
    if (buf === null) throw new Error(`镜像 ${tag} 下不存在：${rel}`);
    console.log(sha256(buf));
  },
  list: async () => {
    for (const it of loadIntegrations()) {
      console.log(`${it.dir}  → ${it.package}  overlay=${(it.files || []).length}`);
    }
  },
  verify: async ({ tag, version }: CommandContext) => {
    await gate(tag, version);
  },
  stage: async ({ tag, version }: CommandContext) => {
    const integrations = await gate(tag, version);
    console.log(`[integrations] 已落盘 ${stageIntegrations(integrations).length} 个文件到 _tmp/integrations/`);
  },
  build: async ({ tag, version }: CommandContext) => {
    const integrations = await gate(tag, version);
    let built;
    try {
      built = await buildIntegrations(integrations, { tag, log: (m) => console.log(m) });
    } catch (e) {
      throw new Error("编译失败：" + errText(e));
    }
    for (const b of built) console.log(`[integrations] 产物：${b.out}`);
  },
} satisfies Record<string, (ctx: CommandContext) => Promise<void>>;

/** 默认子命令：与 COMMANDS 的键共用真源——表里改名而这里没跟上，类型检查会当场报错。 */
const DEFAULT_COMMAND: keyof typeof COMMANDS = "verify";

/** 子命令名守卫：把任意 argv 收窄成表内的键（这一步同时也是白名单校验）。 */
const isCommand = (name: string): name is keyof typeof COMMANDS => name in COMMANDS;

async function main() {
  const cmd = process.argv[2] || DEFAULT_COMMAND;
  if (!isCommand(cmd)) {
    console.error(`[integrations] 未知子命令：${cmd}（支持 ${Object.keys(COMMANDS).join("/")}）`);
    process.exit(2);
  }
  const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const version = dshVersionOf(pkgJson);
  if (!version) {
    console.error("[integrations] package.json 未声明 dependencies['@deepseek-ai/dsh']");
    process.exit(1);
  }
  await COMMANDS[cmd]({ tag: tagForVersion(version), version });
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    console.error("[integrations] " + errText(e));
    process.exit(1);
  });
}
