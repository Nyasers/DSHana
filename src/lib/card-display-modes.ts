// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/card-display-modes.ts — 会话流卡档位的词表（零依赖）
//
// 单独一层只为一件事实：这份词表要被四种消费者读——服务端的设置校验（lib/data-source.ts）、
// 缺省值（lib/config.ts）、工具侧的判定（lib/card-display.ts）、以及浏览器里的设置页
// （ui/settings.tsx）。设置页是浏览器 bundle，不能经上面任何一个模块拿到它（那些模块拖着
// node:fs / app-runtime），所以词表落在没有依赖的这里。
//
// never / open-only / all 的语义见 lib/card-display.ts。
export const SESSION_CARD_DISPLAYS = Object.freeze(["never", "open-only", "all"]);

/** 缺省档位：open-only。一个会话一张卡——聊天流里一次任务就一个 iframe，reply 不再叠；
 * 而卡页按 sid 跟整段会话，所以那唯一一张仍然跟着会话活着。 */
export const SESSION_CARD_DISPLAY_DEFAULT = "open-only";
