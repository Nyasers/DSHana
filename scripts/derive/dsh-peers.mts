// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/derive/dsh-peers.mts — 组合层包 peerDependencies 里的内核版本与 pin 对齐。
//
// 为什么进派生表：DSH 的插件加载器拿 peer 声明做内核兼容性校验，值对不上就把整个组合层包跳过，
// boot 死在起跑线（`@dshana/dsh-app@… is incompatible with dsh …: requirements {"…":"…"}`）。
// 这条 pin 与 dependencies 不同源、不受 install 约束，verify:bundle 只看派生面、check:type 更管不着，
// 于是漏改时全绿到 boot 才炸。来源与 dependencies 同：packages/host 声明的内核版本。
//
// 只认 @deepseek-ai/dsh 与 @deepseek-ai/dsh-* 的 peer；cordis / schemastery 那几条走自己的版本线，
// 与本 pin 无关，改它们才是错的。
import { dshPin, readPkg, writePkg } from "../shared/version.mts";

const BUNDLE_PKG = "packages/dsh/app/package.json";

/** 归内核 pin 管的 peer 名（`@deepseek-ai/dsh` 本身与它的子包）。 */
function isKernelPeer(name: string) {
  return name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-");
}

/** 与 pin 不一致的 peer 条目（空数组 = 一致）。 */
function stalePeers(): [string, string][] {
  const pin = dshPin();
  if (!pin) throw new Error(`${BUNDLE_PKG} 的 peer 无法对账：packages/host 未声明 dependencies['@deepseek-ai/dsh']`);
  const peers = (readPkg(BUNDLE_PKG)?.peerDependencies ?? {}) as Record<string, string>;
  return Object.entries(peers).filter(([name, spec]) => isKernelPeer(name) && spec !== pin);
}

/** 只读检查。 */
export function inspect(): string[] {
  const pin = dshPin();
  return stalePeers().map(([name, spec]) => `${BUNDLE_PKG}#peerDependencies[${name}] 是 ${spec}，内核 pin 是 ${pin}`);
}

/** 修复：把这些 peer 写成 pin。 */
export function repair(): void {
  const pin = dshPin();
  if (!pin) throw new Error(`${BUNDLE_PKG} 的 peer 无法对齐：packages/host 未声明 dependencies['@deepseek-ai/dsh']`);
  const pkg = readPkg(BUNDLE_PKG);
  if (stalePeers().length === 0) return;
  for (const name of Object.keys(pkg.peerDependencies ?? {})) {
    if (isKernelPeer(name)) pkg.peerDependencies[name] = pin;
  }
  writePkg(BUNDLE_PKG, pkg);
}

/** derive 的 dsh-peers 任务（形状与 derive 的 StateTask 一致，由 derive 侧标注类型）。 */
export const dshPeersTask = {
  kind: "state" as const,
  name: "dsh-peers",
  about: "packages/host 的内核 pin → packages/dsh/app#peerDependencies 的 @deepseek-ai/dsh-*",
  inspect,
  repair,
};
