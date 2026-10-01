/** `settings.theme` namespace dictionaries (the Appearance and font-size rows' copy). */

// 本覆盖层只改「系统」那一个选项的文案：本形态下该选项跟的是宿主（Hana）配色而非操作系统，
// 「跟随系统」名不副实。偏好值仍是 system，落盘的键与 theme/change 契约一个字不动。
// 两个字典的键集必须保持上游那样完整对齐（en 对 zh 的键集有 satisfies 检查）。

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'appearance.title': '外观',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.system': '跟随宿主',
  'fontSize.title': '字号大小',
  'fontSize.description': '仅影响会话内容的字号',
  'fontSize.unit': 'px',
  'fontSize.increase': '增大字号',
  'fontSize.decrease': '减小字号',
} satisfies Record<string, string>

/** The settings.theme namespace key union. */
export type ThemeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'Host',
  'fontSize.title': 'Font size',
  'fontSize.description': 'Only affects conversation content',
  'fontSize.unit': 'px',
  'fontSize.increase': 'Increase font size',
  'fontSize.decrease': 'Decrease font size',
} satisfies Record<ThemeKey, string>
