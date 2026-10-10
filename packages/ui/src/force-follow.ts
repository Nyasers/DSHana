// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/ui/src/force-follow.ts — 把「强制跟随宿主主题的面」这张声明从设置搬到 DOM 上。
//
// 数据流：App 设置存储（dataDir/settings.json 的 forceFollowFaces）
//   → GET /dshana/settings
//   → 本模块编码成 <html> 的 FORCE_FOLLOW_ATTR（逗号分隔的面名）
//   → 主题桥（packages/dsh/theme/assets/theme-bridge.js）读属性判「这一面是不是强制面」。
//
// 为什么绕 DOM 一圈而不是直接给桥：桥是 cordis 侧散装分发的浏览器 JS（无 import、ES5 风格），
// 引不到本仓库的模块；同文档注入后它与壳页在**同一个文档**里，属性就是那口井。
//
// 时机：壳页（app-shell.ts）与会话卡的重型半（stream-stage.tsx）各在 boot 时调一次。拉取与
// DSH boot 并行，晚到只让桥重算一轮（属性在 MutationObserver 的观察名单里），那一小段正好在
// 启动屏里。**拉不到就不写**——属性缺席时桥按 FORCE_FOLLOW_FACES 的缺省兜底（= 只有侧栏面），
// 也就是这一功能之前的行为，不因为一次取数失败把界面弄成别的样子。
//
// 与设置页的联动：设置页保存在**另一个文档**（宿主设置区那个 iframe）里，卡片看不到它的
// visibilityState 变化——所以不能只靠 visibilitychange。设置页保存后在同源广播频道上发一条
// （FORCE_FOLLOW_CHANNEL），所有已开的卡片与壳页收到就重读一次；可见性与焦点事件只当兜底
// （BroadcastChannel 不可用的旧宿主、以及同文档内切页的情形）。
//
// 两者都不轮询：与桥的偏好同步同一纪律（事件驱动）。
import {
  FORCE_FOLLOW_ATTR,
  FORCE_FOLLOW_CHANNEL,
  FORCE_FOLLOW_CHANGED,
  encodeForceFollowFaces,
  isForceFollowFace,
  type ForceFollowFace,
} from "@dshana/shared/face-theme.ts";
import { apiFetch } from "./surface-bridge.ts";

/**
 * 并发拉取的序号闸：焦点 / 可见性 / 广播三条来源各自能起一次拉取，若**先发起**的那次
 * 晚于后发起的落地，属性会被写回旧名单（写的是不同值，比现值那道闸拦不住），桥据此
 * 重算一轮、直到下一次触发才纠正。每次发起取一个号，落地时不是最新号就放弃写。
 */
let publishSeq = 0;

/** 读设置里的这张表；形状不对（缺键 / 脏值 / 非数组）返回 null，调用方据此不写属性。 */
function facesOf(settings: any): ForceFollowFace[] | null {
  const raw = settings && settings.forceFollowFaces;
  if (!Array.isArray(raw)) return null;
  const out: ForceFollowFace[] = [];
  for (const item of raw) {
    if (!isForceFollowFace(item)) return null;
    out.push(item);
  }
  return out;
}

/**
 * 拉一次设置并把这张表写到 `<html>` 上。
 * 返回值 = 是否写成功（false = 取数失败或形状不对，属性保持原样）。
 */
export async function publishForceFollow(): Promise<boolean> {
  const seq = ++publishSeq;
  let settings: any = null;
  try {
    const res = await apiFetch("dshana/settings", {
      method: "GET", cache: "no-store", headers: { Accept: "application/json" },
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    settings = data && data.settings;
  } catch {
    return false; // 凭据缺失 / 网络抖动：不写属性，桥走缺省兜底
  }
  // 取数期间有更新的一次发起：让位给它，不把旧名单盖回去。
  if (seq !== publishSeq) return false;
  const faces = facesOf(settings);
  if (!faces) return false;
  const value = encodeForceFollowFaces(faces);
  try {
    const root = document.documentElement;
    // 写前比现值：桥在观察这个属性，同值重写会白触发它一轮重算。
    if (root.getAttribute(FORCE_FOLLOW_ATTR) !== value) root.setAttribute(FORCE_FOLLOW_ATTR, value);
  } catch {
    return false;
  }
  return true;
}

/**
 * 设置页保存这张表后广播一条，让已开的页面重读。
 * 设置页与卡片是两个文档，拿不到彼此的可见性变化——同源广播才是那条可靠的路。
 * 广播不可用（旧宿主没有 BroadcastChannel）时静默：接收侧还有可见性 / 焦点兜底。
 */
export function notifyForceFollowChanged(): void {
  if (typeof BroadcastChannel !== "function") return;
  try {
    const bus = new BroadcastChannel(FORCE_FOLLOW_CHANNEL);
    bus.postMessage({ kind: FORCE_FOLLOW_CHANGED, at: Date.now() });
    // 发完就关：这里只借它递一条，不留常开连接（接收侧那份由监听方持有）。
    bus.close();
  } catch { /* 忽略：接收侧还有兜底 */ }
}

/**
 * 开始盯着这张表的变化。三条来源，都是事件、不轮询：
 *   · 同源广播（主力）：设置页保存后发一条，跨文档即时到达；
 *   · 页面重新可见：卡片在自己的窗口里被切回来时生效（同文档切页不触发，那条靠广播）；
 *   · 窗口重新获得焦点：文档被别的东西遮住又重新点回来的情形。
 * 返回解绑函数；不调也不漏（监听随文档走），但显式清理更干净。
 */
export function watchForceFollowChanges(): () => void {
  let bus: BroadcastChannel | null = null;
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as { kind?: unknown } | null;
    if (!data || typeof data !== "object" || data.kind !== FORCE_FOLLOW_CHANGED) return;
    void publishForceFollow();
  };
  if (typeof BroadcastChannel === "function") {
    try {
      bus = new BroadcastChannel(FORCE_FOLLOW_CHANNEL);
      bus.addEventListener("message", onMessage);
    } catch { bus = null; }
  }
  const onVisible = (): void => {
    if (document.visibilityState === "visible") void publishForceFollow();
  };
  const onFocus = (): void => { void publishForceFollow(); };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onFocus);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onFocus);
    try { if (bus) { bus.removeEventListener("message", onMessage); bus.close(); } } catch { /* 忽略 */ }
  };
}
