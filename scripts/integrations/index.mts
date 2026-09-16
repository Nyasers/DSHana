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
// 本文件只解析参数并按序编排。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { errText } from "../shared/err-text.mts";
import { isDirectRun } from "../shared/run.mts";
import { buildIntegrations } from "./build.mts";
import { REPO_ROOT, loadIntegrations, mirrorHasTag, readUpstreamFromMirror, stageIntegrations } from "./mirror.mts";
import { dshVersionOf, sha256, tagForVersion, verifyIntegrations } from "./verify.mts";

async function main() {
  const cmd = process.argv[2] || "verify";
  const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const version = dshVersionOf(pkgJson);
  if (!version) {
    console.error("[integrations] package.json 未声明 dependencies['@deepseek-ai/dsh']");
    process.exit(1);
  }
  const tag = tagForVersion(version);

  if (cmd === "hash") {
    const rel = process.argv[3];
    if (!rel) {
      console.error("[integrations] 用法：node scripts/integrations/index.mts hash <仓库相对路径>");
      process.exit(1);
    }
    const buf = readUpstreamFromMirror(rel, tag);
    if (buf === null) {
      console.error(`[integrations] 镜像 ${tag} 下不存在：${rel}`);
      process.exit(1);
    }
    console.log(sha256(buf));
    return;
  }

  const integrations = loadIntegrations();
  if (cmd === "list") {
    for (const it of integrations) {
      console.log(`${it.dir}  → ${it.package}  overlay=${(it.files || []).length}`);
    }
    return;
  }

  // verify / stage 都要先过闸
  const commit = mirrorHasTag(tag);
  if (!commit) {
    console.error(
      `[integrations] 源码镜像不一致：vendor/deepseek-harness 里没有 tag ${tag}。\n` +
        `  pin 的 DSH 版本是 ${version}；请先把镜像跟到该版本：\n` +
        `  git -C vendor/deepseek-harness fetch --no-tags origin tag ${tag}`,
    );
    process.exit(1);
  }
  console.log(`[integrations] 镜像 ${tag} = ${commit.slice(0, 9)}（pin ${version}）`);

  let result;
  try {
    result = verifyIntegrations(integrations, (rel) => readUpstreamFromMirror(rel, tag));
  } catch (e) {
    console.error("[integrations] " + errText(e));
    process.exit(1);
  }
  console.log(`[integrations] 漂移闸通过：${result.packages} 个集成、${result.files} 个 overlay 文件`);
  if (result.empty.length) {
    console.log(`[integrations] 注意：以下集成尚无 overlay（批次未落地）：${result.empty.join(", ")}`);
  }

  if (cmd === "stage") {
    const staged = stageIntegrations(integrations);
    console.log(`[integrations] 已落盘 ${staged.length} 个文件到 _tmp/integrations/`);
    return;
  }

  if (cmd === "build") {
    try {
      const built = await buildIntegrations(integrations, { tag, log: (m) => console.log(m) });
      for (const b of built) console.log(`[integrations] 产物：${b.out}`);
    } catch (e) {
      console.error("[integrations] 编译失败：" + errText(e));
      process.exit(1);
    }
    return;
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    console.error("[integrations] " + errText(e));
    process.exit(1);
  });
}
