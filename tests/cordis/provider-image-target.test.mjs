// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/cordis/provider-image-target.test.mjs — 图片请求目标尺寸投影单测
//
// 锁的是两件事：一是等比、不放大、不超预算的几何；二是 readImageRequest 的 target
// 形状（{ width, height, maxBytes } 三个正整数），尺寸不可用时回退固定档。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requestImageDimensions,
  longEdgeDimensions,
  imageRequestTarget,
  REQUEST_IMAGE_MAX_PIXELS,
  REQUEST_IMAGE_MAX_BYTES,
  REQUEST_IMAGE_MAX_DIMENSION,
  REQUEST_IMAGE_FALLBACK_WIDTH,
  REQUEST_IMAGE_FALLBACK_HEIGHT,
} from "../../src-cordis/plugins/provider/lib/image-target.ts";

test("requestImageDimensions: 小图不放大", () => {
  assert.deepEqual(requestImageDimensions(100, 50, REQUEST_IMAGE_MAX_PIXELS), { width: 100, height: 50 });
});

test("requestImageDimensions: 横图等比且不超预算", () => {
  const d = requestImageDimensions(4000, 2000, REQUEST_IMAGE_MAX_PIXELS);
  assert.ok(d.width * d.height <= REQUEST_IMAGE_MAX_PIXELS);
  assert.ok(d.width <= 4000 && d.height <= 2000);
  assert.ok(Math.abs(d.width / d.height - 2) < 0.01);
});

test("requestImageDimensions: 竖图分支同样等比", () => {
  const d = requestImageDimensions(2000, 4000, REQUEST_IMAGE_MAX_PIXELS);
  assert.ok(d.width * d.height <= REQUEST_IMAGE_MAX_PIXELS);
  assert.ok(Math.abs(d.height / d.width - 2) < 0.01);
});

test("requestImageDimensions: 入参非法返回 null", () => {
  assert.equal(requestImageDimensions(0, 10, 100), null);
  assert.equal(requestImageDimensions(10, 1.5, 100), null);
  assert.equal(requestImageDimensions(10, 10, 0), null);
  assert.equal(requestImageDimensions(undefined, 10, 100), null);
  assert.equal(requestImageDimensions(10, 10, Number.NaN), null);
});

test("longEdgeDimensions: 收长边后短边按比例", () => {
  assert.deepEqual(longEdgeDimensions(10000, 100, 4096), { width: 4096, height: 41 });
  assert.deepEqual(longEdgeDimensions(100, 10000, 4096), { width: 41, height: 4096 });
  assert.deepEqual(longEdgeDimensions(800, 600, 4096), { width: 800, height: 600 });
});

test("imageRequestTarget: 从 ref 原始尺寸投影，超长边被单边上限收住", () => {
  const t = imageRequestTarget({ width: 4000, height: 3000 });
  assert.equal(t.maxBytes, REQUEST_IMAGE_MAX_BYTES);
  assert.ok(t.width * t.height <= REQUEST_IMAGE_MAX_PIXELS);

  const thin = imageRequestTarget({ width: 10000, height: 1 });
  assert.equal(Math.max(thin.width, thin.height), REQUEST_IMAGE_MAX_DIMENSION);
  assert.ok(thin.height >= 1);
});

test("imageRequestTarget: 尺寸缺失或畸形时回退固定档", () => {
  const expected = {
    width: REQUEST_IMAGE_FALLBACK_WIDTH,
    height: REQUEST_IMAGE_FALLBACK_HEIGHT,
    maxBytes: REQUEST_IMAGE_MAX_BYTES,
  };
  assert.deepEqual(imageRequestTarget(null), expected);
  assert.deepEqual(imageRequestTarget({}), expected);
  assert.deepEqual(imageRequestTarget({ width: -5, height: 10 }), expected);
  assert.deepEqual(imageRequestTarget({ width: 10, height: 1.5 }), expected);
});

test("imageRequestTarget: target 三个字段都是正整数", () => {
  for (const ref of [null, {}, { width: 4000, height: 3000 }, { width: 1, height: 1 }, { width: 10000, height: 1 }]) {
    const t = imageRequestTarget(ref);
    for (const k of ["width", "height", "maxBytes"]) {
      assert.ok(Number.isInteger(t[k]) && t[k] > 0, `${k} 应为正整数：${JSON.stringify(ref)} -> ${t[k]}`);
    }
  }
});
