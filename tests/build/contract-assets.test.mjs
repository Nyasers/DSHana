// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/contract-assets.test.mjs — manifest 声明的契约件与源码落位的一致性闸
//
// 身份图标与卡面图的落位由 scripts/shared/contract-assets.mts 一处定义（App 域构建摆位与投稿条目
// 取图标共用）。这两个字段丢位的表现都不响：图标缺了，市场条目只是无声地没有图；卡面缺了，卡片
// 只是没脸。两处都不报错，所以这里按 manifest 的声明把源位钉住——改了布局而没跟映射，在 PR 上就红。
//
// 另守随包声明文本（NOTICE / THIRD_PARTY_NOTICES.md）：名单只有 DECLARATION_TEXTS 一份，
// 由 build:app 直出进 dist、pack 只断言。钉住两侧是为了不让「源一套、产物一套」重现——
// 那是靠 pack 事后往 dist 里补才有的缺口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { contractAssetSource, faceAssetSource, manifestPath } from "../../scripts/shared/contract-assets.mts";
import { DECLARATION_TEXTS } from "../../scripts/shared/paths.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(manifestPath(ROOT), "utf8"));

/** 宿主安装时会真的解码图标与卡面，扩展名对不代表内容对；这里只认已知图片签名。 */
const SIGNATURES = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG
  Buffer.from([0xff, 0xd8, 0xff]), // JPEG
  Buffer.from("RIFF"), // WebP（RIFF....WEBP）
  Buffer.from("<svg"), // static SVG
  Buffer.from("<?xml"), // static SVG（带 XML 声明）
];

function assertImage(file, label) {
  const bytes = readFileSync(file);
  assert.ok(bytes.length > 0, `${label} 是空文件：${file}`);
  assert.ok(
    SIGNATURES.some((sig) => bytes.subarray(0, sig.length).equals(sig)),
    `${label} 不是可识别的图片（宿主要真解码它）：${file}`,
  );
}

test("身份图标：manifest.icon 在 App 域有对应的图片源", () => {
  assert.equal(typeof manifest.icon, "string", "App v2 必须声明身份图标");
  assert.ok(manifest.icon.length > 0, "manifest.icon 不该是空串");
  const source = contractAssetSource(ROOT, manifest.icon);
  let stat;
  try {
    stat = statSync(source);
  } catch {
    assert.fail(`图标源缺失：${source}（manifest.icon=${JSON.stringify(manifest.icon)}）`);
  }
  assert.ok(stat.isFile(), `图标源不是文件：${source}`);
  assertImage(source, "身份图标");
});

test("卡面图：每个 face.image 在 ui 域有对应的图片源", () => {
  const cards = Array.isArray(manifest.contributes?.cards) ? manifest.contributes.cards : [];
  const faced = cards.filter((card) => typeof card?.face?.image === "string" && card.face.image);
  for (const card of faced) {
    const source = faceAssetSource(ROOT, card.face.image);
    let stat;
    try {
      stat = statSync(source);
    } catch {
      assert.fail(`${card.id} 的卡面源缺失：${source}（face.image=${JSON.stringify(card.face.image)}）`);
    }
    assert.ok(stat.isFile(), `${card.id} 的卡面源不是文件：${source}`);
    assertImage(source, `${card.id} 的卡面图`);
  }
});

// 声明文本（NOTICE / THIRD_PARTY_NOTICES.md）：落位规则只此一处，且由 build 直出进 dist。
// 两半都得在：名单错一份就会漏件（源改了、产物没跟），而靠 pack 事后往 dist 里补会让
// dist 在打包前后不是同一份东西（pack 变成 dist 的写者）。
test("声明文本：名单指向仓库根的真实文件", () => {
  assert.deepEqual(DECLARATION_TEXTS, ["NOTICE", "THIRD_PARTY_NOTICES.md"], "随包声明文本的名单");
  for (const item of DECLARATION_TEXTS) {
    const bytes = readFileSync(join(ROOT, item));
    assert.ok(bytes.length > 0, `${item} 是空文件`);
  }
});

test("声明文本：build:app 直出进 dist，pack 只断言不再补", () => {
  const read = (rel) => readFileSync(join(ROOT, ...rel.split("/")), "utf8");
  const build = read("packages/app/src/build.ts");
  assert.match(build, /DECLARATION_TEXTS/, "build.ts 要按名单直出声明文本（不能各写一份字面量）");
  const pack = read("scripts/release/pack/index.mts");
  const packAssert = read("scripts/release/pack/assert.mts");
  // pack 可以**从** dist 拷（fs.copySync(distDir, pkgDir)），但不得再**往** dist 写：
  // 旧实现那句 `fs.copySync(src, join(distDir, item))` 正是「pack 当 dist 写者」的缺口。
  assert.doesNotMatch(pack, /copySync\([^,]+,\s*join\(distDir/, "pack 不再向交付目录写声明文本");
  assert.doesNotMatch(pack, /staticItems/, "旧的静态项注入循环应已退场");
  assert.match(packAssert, /DECLARATION_TEXTS/, "pack 侧的断言要按同一份名单（各写一份就会一边补一边漏）");
});
