// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/provider/lib/image-target.ts — 图片附件的请求目标尺寸（纯函数）
//
// 为什么需要：`ctx.attachments.readImageRequest(ref, target)` 的 target 是
// `{ width, height, maxBytes }` 三个正整数（上游 `@deepseek-ai/dsh-attachment` 的
// validateTarget 逐字段校验，缺 width 直接抛 "Image request width must be a positive
// integer."）。适配器手上只有附件的**原始**尺寸（`ImageAttachmentRef.width/height`，
// 必填的原始编码像素），得先按总像素预算投影成目标尺寸再传；把「预算」当成参数名递
// 过去是行不通的。
//
// 几何算法与上游 `@deepseek-ai/dsh-attachment` 的 request-image-projection 一致：等比、
// 向内取整、小图不放大、不超总像素预算，超过单边上限时按长边收。本插件只动态 import
// dsh-llm，不往上游内部包上加依赖，所以在这里自持一份；上游那条改了要跟着看。

/** 请求图片的总像素预算（2048×2048）与编码字节上限。 */
export const REQUEST_IMAGE_MAX_PIXELS = 4194304;
export const REQUEST_IMAGE_MAX_BYTES = 4000000;

/** 单边上限（上游对一次请求携带多图时的提供方限制）。 */
export const REQUEST_IMAGE_MAX_DIMENSION = 4096;

/** 附件没带可信尺寸时的回退目标：正整数字段缺失或畸形才走它。 */
export const REQUEST_IMAGE_FALLBACK_WIDTH = 1024;
export const REQUEST_IMAGE_FALLBACK_HEIGHT = 1024;

/** 正整数读法：非整数、非有限、≤0 都算没有。 */
function asPositiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 等比投影到总像素预算内（向内取整，小图不放大）。
 * @param width - 源宽。
 * @param height - 源高。
 * @param maxPixels - 总像素上限。
 * @returns 目标尺寸；任一入参不是正整数时返回 null（调用方回退）。
 */
export function requestImageDimensions(width, height, maxPixels) {
  const w = asPositiveInt(width);
  const h = asPositiveInt(height);
  const cap = asPositiveInt(maxPixels);
  if (w === null || h === null || cap === null) return null;
  const scale = Math.min(1, Math.sqrt(cap / (w * h)));
  if (scale === 1) return { width: w, height: h };
  if (w >= h) {
    let projectedWidth = Math.max(1, Math.floor(w * scale));
    let projectedHeight = Math.max(1, Math.round((projectedWidth * h) / w));
    while (projectedWidth * projectedHeight > cap && projectedWidth > 1) {
      projectedWidth -= 1;
      projectedHeight = Math.max(1, Math.round((projectedWidth * h) / w));
    }
    return { width: projectedWidth, height: projectedHeight };
  }
  let projectedHeight = Math.max(1, Math.floor(h * scale));
  let projectedWidth = Math.max(1, Math.round((projectedHeight * w) / h));
  while (projectedWidth * projectedHeight > cap && projectedHeight > 1) {
    projectedHeight -= 1;
    projectedWidth = Math.max(1, Math.round((projectedHeight * w) / h));
  }
  return { width: projectedWidth, height: projectedHeight };
}

/**
 * 等比收长边到指定像素（短边按四舍五入）。
 * @param width - 源宽。
 * @param height - 源高。
 * @param longEdge - 长边目标。
 * @returns 目标尺寸；长边目标不小于源长边时原样返回。
 */
export function longEdgeDimensions(width, height, longEdge) {
  if (longEdge >= Math.max(width, height)) return { width, height };
  return width >= height
    ? { width: longEdge, height: Math.max(1, Math.round((longEdge * height) / width)) }
    : { width: Math.max(1, Math.round((longEdge * width) / height)), height: longEdge };
}

/**
 * 附件 ref → `readImageRequest` 的 target。
 * @param ref - DSH ImageAttachmentRef（读 width/height）。
 * @returns `{ width, height, maxBytes }`，三个都是正整数；尺寸不可用时用回退档。
 */
export function imageRequestTarget(ref) {
  const width = ref && ref.width;
  const height = ref && ref.height;
  let projected = requestImageDimensions(width, height, REQUEST_IMAGE_MAX_PIXELS);
  if (!projected) {
    projected = { width: REQUEST_IMAGE_FALLBACK_WIDTH, height: REQUEST_IMAGE_FALLBACK_HEIGHT };
  } else if (Math.max(projected.width, projected.height) > REQUEST_IMAGE_MAX_DIMENSION) {
    projected = longEdgeDimensions(width, height, REQUEST_IMAGE_MAX_DIMENSION);
  }
  return { width: projected.width, height: projected.height, maxBytes: REQUEST_IMAGE_MAX_BYTES };
}
