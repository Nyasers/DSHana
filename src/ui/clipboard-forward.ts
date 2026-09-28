// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/ui/clipboard-forward.ts — DSH 剪贴板写请求的一层纯转发（浏览器面）
//
// 职责边界一句话：**这里只转发，不判断、不回落、不上报**。写不写得成、失败怎么表达、
// 要不要别的兜底，全归 DSHana 应用侧那一个 handler（src/ui/app-shell.ts 的 writeClipboard）。
//
// 为什么需要这一层：嵌入场景（DSHana 卡）里 navigator.clipboard 被宿主的 Permissions-Policy
// 关死（真机实测：permissions.query({name:'clipboard-write'}) → 'denied'），原生 writeText
// 一调就是一条 [Violation] Permissions policy violation，随后 reject。而 DSH 侧的写法
// （dsh-client-ui-primitives 的 writeClipboard，实读）是：
//     if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(t); return true }
//                                            catch { return false } }
//     …document.execCommand('copy') 兜底**只在 writeText 不存在时**才走
// 也就是「原生一失败就直接 false，没有第二条路」，而且它在**调用时**才读
// navigator.clipboard?.writeText——所以把 writeText / write 换成转发实现就能截住每一次复制，
// 属性在第一次点击之前就位即可，不必抢在 DSH 之前注入。
//
// 转发目标 = 壳页发布的 __DSHANA__.clipboardWrite（应用侧 handler）。结果原样交回：它 reject，
// DSH 那个 helper 就报失败；它 resolve，就是成功。**失败必须由应用侧用 reject 表达**——DSH 只看
// 「抛不抛」，把失败折成一个 resolve 值会被读成「复制成功」。
//
// 覆盖范围：writeText(text) 与 write(items)。write 只认第一个 text/plain——宿主能力面只有
// 「写文本」一个词（清单 app/ui/clipboard-write），图/富文本没有可转发的东西，明确失败。
// readText / read 一概不碰：应用侧没有对应的读能力，假装或报错都不如让它按原样走。

/** 已安装标记（幂等：重复安装只返回一个空 disposer，不重建、不接管别人的清理）。 */
const MARK = "__DSHANA_CLIPBOARD_FORWARD__";

/** createClipboardForward / installClipboardForward 的依赖（缺省取全局）。 */
export interface ClipboardForwardDeps {
  /** 要接管的剪贴板对象（默认 navigator.clipboard）。 */
  clipboard?: any;
  /** 转发目标（默认 target.__DSHANA__，读它的 clipboardWrite）。 */
  bridge?: any;
  /** 装不上时说话的地方（默认 console.warn）；只在「属性不可写」这类装配失败时用。 */
  warn?: (message: string, error: unknown) => void;
  /** 安装目标（默认 globalThis）。 */
  target?: any;
}

/** 转发实现：被换上去的 writeText / write。 */
export interface ClipboardForward {
  /** navigator.clipboard.writeText 的替代：把文本转发给应用侧。 */
  writeText: (text: any) => Promise<any>;
  /** navigator.clipboard.write 的替代：items 可能是图/富文本，只取 text/plain 转发。 */
  write: (items: any) => Promise<any>;
  /** 把 ClipboardItem[] 抽成纯文本（不支持则 null）。 */
  extractText: (items: any) => Promise<string | null>;
}

/**
 * 造转发实现（导出以便单测）。
 *
 * @param deps bridge 为壳页桥（读它的 clipboardWrite）；没有转发目标时，两个写口都直接 reject
 * @returns 转发实现与本模块自己的抽文本口
 */
export function createClipboardForward({ bridge }: Pick<ClipboardForwardDeps, "bridge"> = {}): ClipboardForward {
  const forward = bridge && typeof bridge.clipboardWrite === "function" ? bridge.clipboardWrite.bind(bridge) : null;

  const writeText = (text: any) => {
    if (forward === null) return Promise.reject(new Error("clipboard forward unavailable"));
    try {
      return Promise.resolve(forward(text));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  /** 从 ClipboardItem 列表里取第一个可转发的 text/plain；取不到返回 null。 */
  const extractText = async (items: any): Promise<string | null> => {
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

  const write = (items: any) =>
    extractText(items).then((text) =>
      text === null
        ? Promise.reject(new Error("clipboard write(): 只有 text/plain 能转发给应用侧（宿主能力面只有写文本）"))
        : writeText(text),
    );

  return { writeText, write, extractText };
}

function assign(object: any, name: string, value: any): boolean {
  try {
    object[name] = value;
  } catch { /* 写不进去就看结果，由调用方按结果说话 */ }
  return object[name] === value;
}

/**
 * 全局安装：实例方法与原型方法都换成转发实现（幂等）。
 *
 * 没有可转发的目标（桥缺席或它的 clipboardWrite 不是函数）时**不装**——没得转发，保持页面原生
 * 行为，不接管任何东西。
 *
 * @param [options] 形如 { target, bridge, clipboard, warn }
 * @returns disposer（重复安装返回空函数，不会拆掉先装的那次）
 */
export function installClipboardForward(options: ClipboardForwardDeps = {}): () => void {
  const target = options.target || (typeof globalThis === "undefined" ? null : globalThis);
  if (!target || target[MARK]) return () => {};
  const nav = target.navigator;
  if (!nav) return () => {};
  const clipboard = options.clipboard !== undefined ? options.clipboard : nav.clipboard;
  if (clipboard === undefined || clipboard === null) return () => {};
  const bridge = options.bridge !== undefined ? options.bridge : target.__DSHANA__;
  if (!bridge || typeof bridge.clipboardWrite !== "function") return () => {};
  const warn = options.warn || ((message, error) => {
    try {
      console.warn(`[dshana/clipboard] ${message}`, error);
    } catch { /* 忽略 */ }
  });

  const { writeText, write } = createClipboardForward({ bridge });
  // 还原用「原值」，不是上面那份 bound（bound 是给调用用的，写回去等于换属性）。
  const nativeInstance = { writeText: clipboard.writeText, write: clipboard.write };
  const undo: Array<() => void> = [];

  /** 换实例方法 + 原型方法（只为传进来的这两个名字，read 一概不碰）。
   *  装配失败（属性不可写）说一次：报的是结果，不是抛出来的那句话。 */
  const patch = (name: string, replacement: any) => {
    const proto = target.Clipboard && target.Clipboard.prototype;
    if (assign(clipboard, name, replacement)) {
      undo.push(() => { try { if (clipboard[name] === replacement) clipboard[name] = nativeInstance[name]; } catch { /* 忽略 */ } });
    } else if (typeof nativeInstance[name] === "function") {
      warn(`${name} instance patch`, new Error(`navigator.clipboard.${name} 不可写`));
    }
    if (proto && typeof nativeInstance[name] === "function" && typeof proto[name] === "function") {
      const nativeProto = proto[name];
      if (assign(proto, name, replacement)) {
        undo.push(() => { try { if (proto[name] === replacement) proto[name] = nativeProto; } catch { /* 忽略 */ } });
      } else {
        warn(`${name} prototype patch`, new Error(`Clipboard.prototype.${name} 不可写`));
      }
    }
  };

  patch("writeText", writeText);
  patch("write", write);

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
