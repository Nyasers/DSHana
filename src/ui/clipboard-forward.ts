// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/ui/clipboard-forward.ts — DSH 剪贴板写的兜底层（浏览器面）：**原生优先，失败才转给应用侧**
//
// 一顺位是**本文档的原生 Clipboard API**。App 面 iframe 与宿主 renderer 同源（App 文档的
// location.pathname 是 /api/apps/<id>/…，renderer 自己的请求也都是同源相对路径），
// `clipboard-write` 的默认 allowlist（self）本来就覆盖它——同形态的 App（githana 的 settings
// 面）就是直接调原生 API 的。所以声明了 `app/ui.clipboard-write` 的 App 在自己的面里**直接调**
// 是主路径，不该舍近求远。
//
// 二顺位才是兜底：原生不可用/被拒时，把文本转给 DSHana 应用侧（壳页发布的
// __DSHANA__.clipboardWrite，由壳页 handler 走宿主能力门）。这一层存在的理由只有一个——
// 原生在某些面可能拿不到（策略/焦点/宿主差异），那时至少还有一条路；反过来，宿主的能力门
// 按槽位判（`clipboard.writeText` 的允许集不含 card），单独用它是不够的，所以它只做兜底。
//
// 为什么必须接管属性：DSH 侧的写法（dsh-client-ui-primitives 的 writeClipboard，实读）是
//     if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(t); return true }
//                                            catch { return false } }
//     …document.execCommand('copy') 只在 writeText **不存在**时才走
// 也就是「原生一失败就直接 false，没有第二条路」。把 writeText / write 换成"原生优先 + 兜底"
// 的实现，才既保留原生、又给失败留一条路；属性在第一次点击之前就位即可（它在调用时才读）。
//
// 失败语义：两条都失败就 **reject**（DSH 只看抛不抛，把失败折成 resolve 值会被读成复制成功）。
// 转发层的职责仅此而已：判断写不写得成、怎么表达失败都归应用侧那份 handler。
//
// 覆盖范围：writeText(text) 与 write(items)。readText / read 一概不碰。

/** 已安装标记（幂等：重复安装只返回一个空 disposer，不重建、不接管别人的清理）。 */
const MARK = "__DSHANA_CLIPBOARD_FORWARD__";

/** createClipboardForward / installClipboardForward 的依赖（缺省取全局）。 */
export interface ClipboardForwardDeps {
  /** 要接管的剪贴板对象（默认 navigator.clipboard）。 */
  clipboard?: any;
  /** 兜底转发目标（默认 target.__DSHANA__，读它的 clipboardWrite）。 */
  bridge?: any;
  /** 兜底里说话的地方（默认 console.warn）；只在装配失败时用（写失败靠 reject 带出去）。 */
  warn?: (message: string, error: unknown) => void;
  /** 安装目标（默认 globalThis）。 */
  target?: any;
}

/** 被换上去的写口。 */
export interface ClipboardForward {
  /** navigator.clipboard.writeText 的替代：先试本文档原生，失败再转给应用侧。 */
  writeText: (text: any) => Promise<any>;
  /** navigator.clipboard.write 的替代：items 先试原生；不行就取 text/plain 走同一条路。 */
  write: (items: any) => Promise<any>;
  /** 把 ClipboardItem[] 抽成纯文本（不支持则 null）。 */
  extractText: (items: any) => Promise<string | null>;
}

/**
 * 造写口实现（导出以便单测）。
 *
 * @param deps clipboard 为 navigator.clipboard；bridge 为壳页桥（读它的 clipboardWrite）
 * @returns 写口实现与本模块自己的抽文本口
 */
export function createClipboardForward({ clipboard, bridge }: Pick<ClipboardForwardDeps, "clipboard" | "bridge"> = {}): ClipboardForward {
  const forward = bridge && typeof bridge.clipboardWrite === "function" ? bridge.clipboardWrite.bind(bridge) : null;
  const nativeText = clipboard && typeof clipboard.writeText === "function" ? clipboard.writeText.bind(clipboard) : null;
  const nativeWrite = clipboard && typeof clipboard.write === "function" ? clipboard.write.bind(clipboard) : null;

  const call = (fn: any, payload: any) => {
    if (fn === null) return Promise.reject(new Error("clipboard unavailable"));
    let result;
    try {
      result = fn(payload);
    } catch (error) {
      return Promise.reject(error);
    }
    return result && typeof result.then === "function" ? Promise.resolve(result).then(() => undefined) : Promise.resolve();
  };
  const forwardText = (text: any) => {
    if (forward === null) return Promise.reject(new Error("clipboard forward unavailable"));
    try {
      return Promise.resolve(forward(text));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const writeText = (text: any) => {
    if (nativeText === null) return forwardText(text);
    return call(nativeText, text).catch((nativeError) => {
      if (forward === null) throw nativeError;
      // 兜底那条失败时以它为准（它是宿主能力的原话）；原生那条挂在 cause 上带出去。
      return forwardText(text).catch((forwardError) => {
        try {
          (forwardError as any).cause = nativeError;
        } catch { /* 忽略 */ }
        throw forwardError;
      });
    });
  };

  /** 从 ClipboardItem 列表里取第一个 text/plain；取不到返回 null。 */
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

  const write = (items: any) => {
    if (nativeWrite === null) return writeTextOf(items, null);
    return call(nativeWrite, items).catch((nativeError) => writeTextOf(items, nativeError));
  };

  /** write(items) 的回落：取得到 text/plain 就走写文本那条路（仍是原生优先），取不到就明确失败。 */
  const writeTextOf = (items: any, nativeError: any) =>
    extractText(items).then(
      (text) => {
        if (text !== null) return writeText(text);
        const unsupported = new Error("clipboard write(): 没有可写的 text/plain（图/富文本本文档写不了，应用侧也只有写文本）");
        if (nativeError) {
          try {
            (unsupported as any).cause = nativeError;
          } catch { /* 忽略 */ }
        }
        throw unsupported;
      },
      (error) => {
        throw error;
      },
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
 * 全局安装：实例方法与原型方法都换成这套写口（幂等）。
 *
 * 没有兜底目标（桥缺席或它的 clipboardWrite 不是函数）时**不装**——原生本来就够了，没必要
 * 拿一层等价包装把文档的剪贴板对象换掉。
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

  const { writeText, write } = createClipboardForward({ clipboard, bridge });
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
