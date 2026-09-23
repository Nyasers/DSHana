// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/cordis/theme-token-coverage.test.mjs — 上游 token 的全量覆盖闸。
//
// 规则表的「全量」是个宣称：上游每用一个 --dsw-*，它要么在 TOKEN_MAP 里有归宿，要么在
// PASSTHROUGH 里写明为什么不接。宣称没有闸守着就只是愿望——rc.1 新增 --dsw-alias-file-diff-*
// 六条时，集成层漂移闸（只管我们贴的那几份 overlay 拷贝）看不出它，是靠人对出来的。本闸从
// 镜像的 pin tag 反推交付面在用的全部 token，与两处归宿做差集，非空即红。
//
// 口径（三条都写在这里，改口径先改这段）：
//   · 路径：packages/client/*/src/** 与 apps/web/**，只取 .css/.ts/.tsx/.js/.mjs/.html。
//     实测与「packages/client 全树去掉测试」逐字相同（388 条），所以取窄的不取宽的；
//   · 上游自己的 tests/ 与 *.spec.* / *.test.* 不算：那里会出现 --dsw-alias-bg / --dsw-alias-fg
//     这类测试桩假名，照算会逼我们给不存在的 token 编归宿；
//   · 以 `-` 结尾的匹配丢掉：注释里的族写法（`--dsw-alias-button-*`）与运行期拼出来的前缀都是这形。
//
// 反方向（规则表里有、上游已不用）不查：那是纪律④的另一半，该不该清由人判断，不是闸的事。
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { TOKEN_MAP, PASSTHROUGH } from "../../src-cordis/plugins/theme/token-map.ts";
import { dshVersionOf, tagForVersion } from "../../scripts/integrations/verify.mts";
import { ROOT, readShipPkg } from "../../scripts/shared/version.mts";

const MIRROR = join(ROOT, "vendor", "deepseek-harness");
const EXTENSIONS = ["css", "ts", "tsx", "js", "mjs", "html"];
/** token 名：--dsw- 开头的 kebab 段（末尾连字符由 scanUpstreamTokens 丢掉）。 */
const TOKEN_RE = "--dsw-[a-z0-9-]+";
/** 扫描条数下界：跌破它说明口径或镜像出了岔子，闸门会空转成「永远通过」。 */
const TOKEN_FLOOR = 200;

/** 交付面的路径口径（见文件头）。 */
function scanPaths() {
  const specs = [];
  for (const ext of EXTENSIONS) {
    specs.push(`:(glob)packages/client/*/src/**/*.${ext}`, `:(glob)apps/web/**/*.${ext}`);
  }
  specs.push(":(exclude,glob)**/tests/**", ":(exclude,glob)**/*.spec.*", ":(exclude,glob)**/*.test.*");
  return specs;
}

/** 镜像 tag → 交付面在用的 token（名字 → 出现处，最多留两处，报错时指得出文件）。 */
function scanUpstreamTokens(tag) {
  const args = ["-C", MIRROR, "grep", "-I", "-o", "-n", "-E", "-e", TOKEN_RE, tag, "--", ...scanPaths()];
  let stdout = "";
  try {
    stdout = execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    // git grep 一条都没匹配时退出码 1（本例不该发生），其余错误才是镜像/tag 读不到。
    if (!e.stdout) {
      throw new Error(
        `读镜像 ${tag} 失败（vendor/deepseek-harness 没同步到这个 tag？）：` + String(e.stderr || e.message).trim(),
      );
    }
    stdout = e.stdout;
  }
  const sites = new Map();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /:(\d+):(--dsw[a-z0-9-]+)$/.exec(line);
    if (!m) continue;
    const token = m[2];
    if (token.endsWith("-")) continue; // 族写法 / 拼接前缀，不是 token 名
    const head = line.slice(0, line.length - m[0].length);
    const where = head.startsWith(tag + ":") ? head.slice(tag.length + 1) : head;
    if (!sites.has(token)) sites.set(token, []);
    const seen = sites.get(token);
    if (seen.length < 2 && !seen.includes(where)) seen.push(where);
  }
  return sites;
}

test("主题适配：上游在用的 --dsw-* 每个都有归宿（接了，或 PASSTHROUGH 里写明不接）", () => {
  const tag = tagForVersion(dshVersionOf(readShipPkg()));
  const sites = scanUpstreamTokens(tag);
  assert.ok(
    sites.size >= TOKEN_FLOOR,
    `只扫到 ${sites.size} 个 token（口径或镜像不对？闸门会空转成永远通过）`,
  );
  const mapped = new Set(TOKEN_MAP.map(([token]) => token));
  const uncovered = [...sites.keys()]
    .filter((token) => !mapped.has(token) && !PASSTHROUGH.some((entry) => entry.match.test(token)))
    .sort();
  assert.deepEqual(
    uncovered,
    [],
    "以下 token 上游在用，但规则表与 PASSTHROUGH 都没写（接进 TOKEN_MAP，或补一条 PASSTHROUGH 理由）：\n"
      + uncovered.map((token) => `  ${token}  ← ${sites.get(token).join(" , ")}`).join("\n"),
  );
});
