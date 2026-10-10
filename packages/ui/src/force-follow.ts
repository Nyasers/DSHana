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
// 与设置页的联动：改完设置不推事件（宿主 App 存储没有订阅口，见 packages/ui/src/settings.tsx
// 同一处说明），已开的卡片在**重新可见时**重读一次——壳页因此接上 visibilitychange
// （publishForceFollowOnVisible），用户从设置页切回卡片即生效。
import {
  FORCE_FOLLOW_ATTR,
  encodeForceFollowFaces,
  isForceFollowFace,
  type ForceFollowFace,
} from "@dshana/shared/face-theme.ts";
import { apiFetch } from "./surface-bridge.ts";

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
 * 页面重新可见时重读一次（改完设置切回卡片即生效）。
 * 返回解绑函数；调用方在页面卸载时不必特意调（文档级监听随文档走）。
 */
export function publishForceFollowOnVisible(): () => void {
  const onVisible = () => {
    if (document.visibilityState === "visible") void publishForceFollow();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => document.removeEventListener("visibilitychange", onVisible);
}
