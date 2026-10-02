// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/ui/src/clipboard-shadow.ts — 壳级全局剪贴板影子（浏览器面）
//
// 为什么必须在**壳级**、且必须在**注入 DSH 之前**装：
//   · 嵌入场景里 navigator.clipboard 被宿主的 Permissions-Policy 关死（真机实测：
//     navigator.permissions.query({name:'clipboard-write'}) → 'denied'），原生 writeText 一调
//     就是一条 [Violation] Permissions policy violation，随后 reject。
//   · DSH 侧的写法（dsh-web-frontend 主 bundle 里的 writeClipboard，实读）是：
//       if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(t); return true }
//                                              catch { return false } }
//       …document.execCommand('copy') 兜底**只在 writeText 不存在时**才走
//     也就是「原生一失败就直接 false，没有第二条路」——所以影子必须在属性被读到之前就位。
//   · DSH 的 client 插件（@dshana/clipboard 的 client 半）是 boot manifest 里按需激活的
//     （dsh-client-modules 把每条声明成 { id, inject, immediately }，只有 immediately 才在启动
//     时就激活），装得晚且不保证被激活；壳页在注入 DSH 之前装，才是真正的「全局 + 最早」。
//
// 顺序（三跳依次试，每一跳失败都上报）:
//   ① **桥优先**（__DSHANA__.clipboardWrite → 宿主能力 app/ui/clipboard-write）。理由：嵌入
//      场景里原生必然先失败，若「先试原生」每次复制都要先撞一次已经关死的门（控制台刷 violation）
//      再回落。
//   ② **原生**（navigator.clipboard.writeText/write），但先用 permissions.query 探一次：已经
//      denied 就跳过，不再撞门。
//   ③ **遗留路线**（隐藏 textarea + document.execCommand('copy')）：它按用户激活判，不归
//      Permissions-Policy 的 clipboard-write 管——而宿主能力在 card 槽又直接拒，这一跳是 card
//      槽里唯一可能走通的路。DSH 自己的 helper 也有这条兜底，但只在「writeText 根本不存在」时
//      才走（影子把 writeText 换掉了，所以那条路永远轮不到它）。成功时留一行 tier=… 的痕。
//
// 覆盖范围：
//   · writeText(text)  —— 主路径，走宿主桥（DSH 的复制按钮都是它）。
//   · write(items)     —— 也盖。宿主能力只有 **writeText** 一个词（清单里是
//     app/ui/clipboard-write），所以这里只能把 ClipboardItem 的 text/plain 取出来走桥；
//     只有图像/富文本的 item 无路可走（原生那条被策略关死）→ 明确失败，不假装成功。
//   · readText/read    —— **不盖**。宿主没有对应的读能力词，盖了也只能假装/报错，不如让它
//     按原样失败（真机上会看到那条 violation，那是真实边界，不是我们该藏的）。
//
// 语义：不静默假装成功。显式失败值（false / { written:false }）与异常都当失败抛出去——
// DSH 那个 helper 只要不抛就报成功，所以「看得见的失败」比「假的成功」有价值。

/** 已安装标记（幂等：重复安装只返回一个空 disposer，不重建、不接管别人的清理）。 */
const MARK = "__DSHANA_CLIPBOARD_SHADOW__";

/** 一个 kind 的写成功后走的是哪一跳（真机上靠它分清“宿主真放的”与“浏览器自己兜的”）。 */
export type ClipboardTier = "bridge" | "native" | "legacy";

/** 上报口：影子写失败/降级时上报（stage 供定位）。 */
export type ClipboardReport = (stage: string, error: unknown) => void;

/** createClipboardShadow / installClipboardShadow 的依赖（缺省取全局）。 */
export interface ClipboardShadowDeps {
  /** 要接管剪贴板写的对象（默认 navigator.clipboard）。 */
  clipboard?: any;
  /** 壳页桥（读它的 clipboardWrite）。 */
  bridge?: any;
  report?: ClipboardReport;
  /** 遗留路线（document.execCommand('copy')）的入口：同步返回成败；缺省用内置实现（单测注入）。 */
  legacyCopy?: (text: string) => boolean;
  /** 原生那条路是否已被策略关死（探测一次并记住，然后就不再撞那扇门）。 */
  nativeBlocked?: () => Promise<boolean>;
  /** 写成功后的留痕（默认 console.info 一行，带 tier）。 */
  onTier?: (tier: ClipboardTier) => void;
}

/** 剪贴板影子：被替掉的原始实现 + 影子写入口。 */
export interface ClipboardShadow {
  /** 安装/卸载影子对象。 */
  shadow: any;
  /** 影子写（navigator.clipboard.write 的替代）：items 可能是图/富文本，走桥时需先取文本。 */
  writeShadow: (items: any) => Promise<any>;
  /** 原生 writeText（被替掉的）；未接管时为 null。 */
  original: any;
  /** 原生 write（被替掉的）；未接管时为 null。 */
  originalWrite: any;
  /** 把 ClipboardItem[] 抽成纯文本（不支持则 null）。 */
  extractText: (items: any) => Promise<string | null>;
}

/**
 * 造剪贴板影子（导出以便单测）。
 * @param deps
 *   clipboard 为 navigator.clipboard；bridge 为 window.__DSHANA__（读它的 clipboardWrite）
 * @returns 影子与写入口
 */
export function createClipboardShadow({
  clipboard, bridge, report,
  legacyCopy, nativeBlocked, onTier,
}: ClipboardShadowDeps = {}): ClipboardShadow {
  const original = clipboard && typeof clipboard.writeText === "function" ? clipboard.writeText.bind(clipboard) : null;
  const originalWrite = clipboard && typeof clipboard.write === "function" ? clipboard.write.bind(clipboard) : null;
  const note = typeof report === "function" ? report : () => {};
  const tierNote = typeof onTier === "function" ? onTier : (tier: ClipboardTier) => {
    try { console.info("[dshana/clipboard] 写入成功：tier=" + tier); } catch { /* 忽略 */ }
  };
  const legacy = typeof legacyCopy === "function" ? legacyCopy : defaultLegacyCopy;
  let blockedProbe: Promise<boolean> | null = null;

  /** 原生是否被策略关死（探测一次并记住）。探测不了（无 permissions 面）就当没关死，交给它自己报错。 */
  const nativeIsBlocked = (): Promise<boolean> => {
    if (typeof nativeBlocked === "function") return Promise.resolve(nativeBlocked()).catch(() => false);
    if (blockedProbe === null) {
      blockedProbe = (async () => {
        try {
          const perms = (globalThis as any).navigator && (globalThis as any).navigator.permissions;
          if (!perms || typeof perms.query !== "function") return false;
          const state = await perms.query({ name: "clipboard-write" });
          return !!state && state.state === "denied";
        } catch { return false; }
      })();
    }
    return blockedProbe;
  };

  const callBridge = (text) => {
    const fn = bridge && typeof bridge.clipboardWrite === "function" ? bridge.clipboardWrite : null;
    if (fn === null) return Promise.reject(new Error("clipboard bridge unavailable"));
    try {
      return Promise.resolve(fn(text));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const callNative = (fn, payload) => {
    if (fn === null) return Promise.reject(new Error("native clipboard unavailable"));
    let result;
    try {
      result = fn(payload);
    } catch (error) {
      return Promise.reject(error);
    }
    return result && typeof result.then === "function" ? result.then(() => undefined) : Promise.resolve();
  };
  /** 显式失败值也算失败：线上旧壳页会把宿主失败折成 false，而 DSH 只看「抛不抛」。 */
  const isFailureValue = (result) => result === false || !!(result && result.written === false);

  /**
   * 三跳依次试：桥 → 原生（已被策略关死就跳过，不去撞那扇每次复制都刷 violation 的门）→ 遗留路线。
   * 每一跳失败都上报（保留“每次都说”的观测面），全部失败抛**第一跳**的错（那是根因，不是最后一跳的余波）。
   */
  const writeViaTiers = async (text, nativeCall, stage) => {
    const errors = [];
    const bridged = bridge && typeof bridge.clipboardWrite === "function";
    if (bridged) {
      try {
        const result = await callBridge(text);
        if (!isFailureValue(result)) { tierNote("bridge"); return; }
        const error = new Error("clipboard bridge reported failure");
        note(stage, error);
        errors.push(error);
      } catch (error) {
        note(stage, error);
        errors.push(error);
      }
    }
    if (nativeCall && !(await nativeIsBlocked())) {
      try {
        await nativeCall();
        tierNote("native");
        return;
      } catch (error) {
        note("native", error);
        errors.push(error);
      }
    }
    try {
      if (legacy(text) === true) { tierNote("legacy"); return; }
      const error = new Error("遗留路线（document.execCommand('copy')）未接管：返回 false 或无 document");
      note("legacy", error);
      errors.push(error);
    } catch (error) {
      note("legacy", error);
      errors.push(error);
    }
    throw errors[0] || new Error("clipboard write failed");
  };

  /** 从 ClipboardItem 列表里取第一个可路由的 text/plain；取不到返回 null。 */
  const extractText = async (items) => {
    const list = Array.isArray(items) ? items : (items ? [items] : []);
    for (const item of list) {
      const types = item && item.types ? Array.from(item.types) : [];
      const type = types.find((candidate) => String(candidate).toLowerCase().startsWith("text/plain"));
      if (!type) continue;
      const blob = await item.getType(type);
      return await blob.text();
    }
    return null;
  };

  const shadow = (text) => writeViaTiers(text, original === null ? null : () => callNative(original, text), "bridge");

  const writeShadow = (items) => {
    const nativeCall = originalWrite === null ? null : () => callNative(originalWrite, items);
    const bridged = bridge && typeof bridge.clipboardWrite === "function";
    if (!bridged) {
      if (nativeCall) return nativeCall();
      return Promise.reject(new Error("native clipboard unavailable"));
    }
    return extractText(items).then(
      (text) => {
        if (text !== null) return writeViaTiers(text, nativeCall, "write");
        const unsupported = new Error("clipboard write(): 只有 text/plain 能走宿主桥（宿主无图/富文本能力）");
        note("write", unsupported);
        if (nativeCall === null) throw unsupported;
        return nativeCall().catch((nativeError) => {
          note("native", nativeError);
          throw unsupported;
        });
      },
      (error) => {
        note("write", error);
        throw error;
      },
    );
  };

  return { shadow, writeShadow, original, originalWrite, extractText };
}

/**
 * 内置遗留路线：隐藏 textarea + `document.execCommand('copy')`。
 *
 * 为什么还留着它：嵌入场景里异步剪贴板 API 被 Permissions-Policy 关死（card 槽连宿主能力也不放），
 * 而 execCommand 是另一条机制——它按用户激活判、不走那条策略。DSH 那个 helper 自己也有这条兜底，
 * 但只在“writeText 根本不存在”时才走；影子把 writeText 换掉了，所以那条路永远轮不到它。
 */
export function defaultLegacyCopy(text: string): boolean {
  try {
    const doc = typeof document === "undefined" ? null : document;
    if (!doc || typeof doc.execCommand !== "function") return false;
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    const host = doc.body || doc.documentElement;
    if (!host) return false;
    host.appendChild(area);
    try {
      area.select();
      if (typeof area.setSelectionRange === "function") area.setSelectionRange(0, area.value.length);
      return doc.execCommand("copy") === true;
    } finally {
      try { area.remove(); } catch { /* 忽略 */ }
    }
  } catch {
    return false;
  }
}

/**
 * 全局安装：实例方法与原型方法都换成影子（幂等）。
 * @param [options] 形如 { target, bridge, report }
 * @returns disposer（重复安装返回空函数，不会拆掉先装的那次）
 */
export function installClipboardShadow(
  options: ClipboardShadowDeps & { target?: any } = {},
): () => void {
  const target = options.target || (typeof globalThis === "undefined" ? null : globalThis);
  if (!target || target[MARK]) return () => {};
  const nav = target.navigator;
  if (!nav) return () => {};
  const clipboard = nav.clipboard;
  if (clipboard === undefined || clipboard === null) return () => {};

  const report = options.report || ((stage, error) => {
    // 默认报告：**每次都说**。宿主在 card slot 里明确不允许这个能力（真机：Plugin UI
    // capability "clipboard.writeText" is not allowed in card slots），原生又被
    // Permissions-Policy 挡住——两条路都在宿主手里，方向暂停；转发逻辑保留，
    // 宿主哪天放开，这套代码不用改就能活。报错要即时、可归因，不做“只说一次”的静音。
    try {
      console.warn(`[dshana/clipboard] ${stage} failed:`, error);
    } catch { /* 忽略 */ }
  });
  const bridge = options.bridge !== undefined ? options.bridge : target.__DSHANA__;
  const { shadow, writeShadow } = createClipboardShadow({
    clipboard, bridge, report,
    legacyCopy: options.legacyCopy,
    nativeBlocked: options.nativeBlocked,
    onTier: options.onTier,
  });
  // 还原用「原值」，不是 createClipboardShadow 里那份 bound（bound 是给调用用的，写回去等于换属性）。
  const nativeInstance = { writeText: clipboard.writeText, write: clipboard.write };
  const undo: Array<() => void> = [];

  /** 换实例方法 + 原型方法（只为传进来的这两个名字，read 一概不碰）。 */
  const patch = (name, replacement) => {
    const proto = target.Clipboard && target.Clipboard.prototype;
    try {
      clipboard[name] = replacement;
    } catch (error) {
      report(`${name} instance patch`, error);
    }
    if (clipboard[name] === replacement) {
      undo.push(() => { try { if (clipboard[name] === replacement) clipboard[name] = nativeInstance[name]; } catch { /* 忽略 */ } });
    } else if (typeof nativeInstance[name] === "function") {
      report(`${name} instance patch`, new Error(`navigator.clipboard.${name} 不可写`));
    }
    if (proto && typeof nativeInstance[name] === "function" && typeof proto[name] === "function") {
      const nativeProto = proto[name];
      try {
        proto[name] = replacement;
        if (proto[name] === replacement) undo.push(() => { try { if (proto[name] === replacement) proto[name] = nativeProto; } catch { /* 忽略 */ } });
      } catch (error) {
        report(`${name} prototype patch`, error);
      }
    }
  };

  patch("writeText", shadow);
  patch("write", writeShadow);

  const entry = {
    dispose: () => {
      for (const restore of undo.reverse()) restore();
      try { delete target[MARK]; } catch { /* 忽略 */ }
    },
  };
  try {
    Object.defineProperty(target, MARK, { value: entry, configurable: true });
  } catch {
    target[MARK] = entry;
  }
  return entry.dispose;
}
