// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/check/on-demand.mts — 按需名单与上游 OPTIONAL_BUNDLES 的对账闸。
//
// 为什么要提前到这里：这份名单漂移的后果不是「包大一点」，而是 `pnpm run package` 直接红
// （pack/index.mts 里的 assertMatchesUpstreamOptional）。出包是发版前最后一步，那时才发现
// 上游往 OPTIONAL_BUNDLES 塞了新 bundle，等于把一次机械修正拖到了发布当口——0.2.2-rc.3 就是
// 打包跑到一半才炸出来的。这条闸把它挪进常规门（挂在 build 链上，CI 每次 PR 都跑）。
//
// 判据与打包完全相同（同一份 shared 实现）：少一个 = 那个 bundle 仍随包内置；多一个 = 我们
// 造了个上游没有的按需项，catalog 里点安装会 404。
//
// 用法：node scripts/check/on-demand.mts
// 退出码：0 一致；1 不一致；2 跑不起来（镜像缺 tag、yaml 里读不到名单）。
import { ROOT } from "../shared/root.mts";
import { isDirectRun } from "../shared/run.mts";
import { errText } from "../shared/err-text.mts";
import { dshPin } from "../shared/version.mts";
import { assertMatchesUpstreamOptional, onDemandBundles, upstreamOptionalBundles } from "../shared/on-demand.mts";

/** 跑一次对账并打印结论；不一致抛错（由调用点决定退出码）。 */
export function verifyOnDemand(): { ours: number; upstream: number; tag: string } {
  const ours = onDemandBundles(ROOT);
  if (ours.length === 0) {
    // 段空了多半不是「上游清空了可选名单」，而是标记段被改坏——静默放行等于关掉整条通道。
    throw new Error("pnpm-workspace.yaml 的 excluded-on-demand 段读不到任何包名（标记段被改坏？）");
  }
  assertMatchesUpstreamOptional(ROOT);
  const upstream = upstreamOptionalBundles();
  return { ours: ours.length, upstream: upstream.length, tag: `dsh-v${dshPin()}` };
}

if (isDirectRun(import.meta.url)) {
  try {
    const { ours, upstream, tag } = verifyOnDemand();
    console.log(`[on-demand] 通过：按需名单 ${ours} 个与上游 ${tag} 的 OPTIONAL_BUNDLES（${upstream} 个）一一对应`);
  } catch (e) {
    const message = errText(e);
    // 名单不一致是「配置要改」（1）；读不到镜像/解析不出上游是「闸跑不起来」（2）。
    const code = message.includes("按需名单与上游 OPTIONAL_BUNDLES 不一致") ? 1 : 2;
    console.error(`[on-demand] ${code === 1 ? "名单未跟上游" : "闸本身跑不起来"}：\n${message}`);
    process.exit(code);
  }
}
