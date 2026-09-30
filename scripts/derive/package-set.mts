// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/derive/package-set.mts — 运行树包集清单的派生化（写回 / --check 只读校验）。
//
// 派生方向：T1 缓存里的 dist-npm（源）→ packaging/dsh-package-set.json（目标）。
// 根集不落成常量：现算（上游 app-boot 的 web 模板 ∪ OPTIONAL_BUNDLES ∪ 我们那批），
// 与清单比对；上游改了模板，--check 就报，而不是等发版时人工对账。
//
// 只读性：--check 绝不写盘、绝不解包；缺 T1 缓存时**报错而不是跳过**——一个"跳过即通过"
// 的校验门在 CI 里等于不存在。缺失由**上游自愈**：prepackage 与 CI 都先跑一次 build:dsh
// （scripts/vendor/build.mts 幂等，命中只读），所以这道闸在干净环境里有实料可校。
import fs from "node:fs";
import path from "node:path";

import { ROOT } from "../shared/root.mts";
import { packageSetDigest } from "../shared/package-set-digest.mts";
import {
  PACKAGE_SET_REL,
  buildPackageSet,
  checkPackageSet,
  checkPackageSetBuild,
  readBuildRecipe,
  readPackageSet,
} from "../release/package-set.mts";
import { currentBuildIdentity } from "../vendor/build.mts";
import type { FileTask } from "./index.mts";

/**
 * 现算当前包集的 T1 缓存键。
 *
 * 走 T1 自己的键推导（scripts/vendor/build.mts 的 currentBuildIdentity），不读清单里记的那个键：
 * 清单记的是"上一版是谁"，而我们要的是"现在应该是谁"。读清单会让换了 tag/依赖/工具链之后
 * 永远照着老键校验（清单自洽，却指着上一份产物）。
 *
 * @returns 缓存键；对应缓存条目不存在时报错（让人先跑 build.mts）。
 */
function currentCacheKey(): string {
  const identity = currentBuildIdentity();
  return identity.key;
}

/** 现算包集，作为清单的期望内容。 */
async function planPackageSet(): Promise<{ rel: string; content: string }[]> {
  const set = await buildPackageSet(currentCacheKey());
  return [{ rel: PACKAGE_SET_REL, content: JSON.stringify(set, null, 2) + "\n" }];
}

/**
 * 只读校验：清单自洽（结构、tarball 字节与摘要、根集与现算一致、身份与 T1 缓存一致）。
 *
 * 为什么不能只靠"内容逐字相同"：tarball 是清单之外的文件，清单可以自洽却指向一份被换过的
 * 字节，或者指向另一次构建。这两件事必须各自验。
 *
 * @returns 差异清单（空 = 一致）。
 */
export function verifyPackageSet(): string[] {
  const set = readPackageSet();
  if (set === null) return ["找不到 " + PACKAGE_SET_REL];
  const key = set.build.cacheKey;
  if (!key) return [PACKAGE_SET_REL + " 里没记 cacheKey"];
  let recipe: Record<string, unknown>;
  try {
    recipe = readBuildRecipe(key) as Record<string, unknown>;
  } catch (error) {
    return ["T1 缓存条目读不到：" + String(error)];
  }
  // 逐字节对拍只在两侧**同源**时做：release:pack 的 tarball 字节不可跨机复现（win32 的 CRLF 对
  // linux 的 LF、gzip mtime 各有差异），拿别处那次的字节来比只会一片红。判据是这批 tarball 的
  // 指纹——构建期写进缓存档案、清单侧现算，两侧同一份实现（scripts/shared/package-set-digest）。
  const recordedDigest = (recipe.artifact as { setDigest?: unknown } | undefined)?.setDigest;
  const setDigest = packageSetDigest(set.packages);
  const sameOrigin = typeof recordedDigest === "string" && recordedDigest === setDigest;
  if (!sameOrigin) {
    console.log(
      "[derive] package-set: 本机包集与清单不同源（" +
        (typeof recordedDigest === "string" ? `档案指纹 ${recordedDigest} ≠ 清单 ${setDigest}` : "缓存档案里没有指纹") +
        "）——只校结构/根集/身份，不逐字节对拍",
    );
  }
  const diffs = checkPackageSet(
    set,
    path.join(ROOT, ".cache", "dsh-build", key, "dist-npm"),
    undefined,
    { compareBytes: sameOrigin },
  );
  diffs.push(...checkPackageSetBuild(set, recipe));
  return diffs;
}

/**
 * 任务：package-set —— T1 包集（dist-npm）→ packaging/dsh-package-set.json。
 *
 * 写回走框架的整份内容比较；--check 时框架另会调用 verify()（见 FileTask.verify）。
 */
export const packageSetTask: FileTask = {
  kind: "file",
  name: "package-set",
  about: "T1 dist-npm → packaging/dsh-package-set.json（包名/版本/字节/sha512 + 根集 + 身份）",
  plan: planPackageSet,
  verify: verifyPackageSet,
};
