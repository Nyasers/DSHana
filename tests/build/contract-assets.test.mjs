// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/contract-assets.test.mjs — manifest 声明的契约件与源码落位的一致性闸
//
// 身份图标与卡面图的落位由 scripts/shared/contract-assets.mts 一处定义（App 域构建摆位与投稿条目
// 取图标共用）。这两个字段丢位的表现都不响：图标缺了，市场条目只是无声地没有图；卡面缺了，卡片
// 只是没脸。两处都不报错，所以这里按 manifest 的声明把源位钉住——改了布局而没跟映射，在 PR 上就红。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { contractAssetSource, faceAssetSource, manifestPath } from "../../scripts/shared/contract-assets.mts";

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
