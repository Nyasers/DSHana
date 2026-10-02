/** Shortcut reference plugin; commands and entry points share one declared store. */
import type { Context } from '@deepseek-ai/cordis'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { closeTopModal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createShortcutsStore } from './store.ts'
import { ShortcutReference, ShortcutsRow } from './Reference.tsx'
import { en, zh } from './locales.ts'
import { fixedCommands } from './fixed.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Shortcut reference and settings entry copy. */
    shortcuts: keyof typeof zh
  }
}

/** Required command, locale, and slot services. */
export const inject = ['shortcuts', 'locale', 'slots']

/**
 * Register the reference command, settings row, and single shell overlay.
 * @param ctx - plugin-owned client context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('shortcuts', { zh, en }), 'shortcuts: dictionaries')
  const t = ctx.locale.bind('shortcuts')
  const handle = createShortcutsStore()
  const instance = handle.create()
  const store: typeof handle = { ...handle, create: () => instance }

  // ── 跨面转发（app 级 overlay 只归整幅面）──────────────────────────────────
  // 参考框注册在 shell.overlay，而 FP（navigation）不再渲染那一层（app 级 overlay 归整幅面）。
  // 打开它有两条路：设置区那一行（在主卡）与本包的 `shortcuts.open` 命令——后者在任何面都会
  // 触发，包括 FP。于是 FP 只发射意图，整幅面读进来用自己的 store 开框。
  const surfaceRole = forwardBridge()?.role
  const emitsOnly = surfaceRole === 'navigation'
  const landsIntent = surfaceRole === 'workspace' || surfaceRole === 'standalone'
  const openReference = (): void => {
    if (emitsOnly) { emitIntent('shortcuts-panel', {}); return }
    instance.actions.open()
  }
  const edit: typeof ctx.shortcuts.edit = (...args) => ctx.shortcuts.edit(...args)
  const recording = (active: boolean) => ctx.shortcuts.recording(active)
  const describeBinding: typeof ctx.shortcuts.describeBinding = binding => ctx.shortcuts.describeBinding(binding)
  for (const command of fixedCommands(t)) {
    ctx.effect(() => ctx.shortcuts.registerFixed(command), `shortcuts: ${command.id}`)
  }
  const injected = () => ({ platform: ctx.shortcuts.platform, runtime: ctx.shortcuts.runtime, edit, recording, describeBinding,
    hooks: { catalog: ctx.shortcuts.catalog, config: ctx.shortcuts.config, fixedCatalog: ctx.shortcuts.fixedCatalog } })
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: 'shortcuts', order: 16, locale: 'shortcuts', store,
    inject: injected,
  }, ShortcutsRow))
  ctx.slots.inject('shell.overlay', () => {
    const disposeCommand = ctx.shortcuts.register({
      id: 'shortcuts.open' as ShortcutCommandId, label: () => t('open'), aliases: ['shortcuts', 'keyboard shortcuts'],
      defaults: {
        'desktop:macos': { code: 'Slash', modifiers: ['primary'] },
        'desktop:windows': { code: 'Slash', modifiers: ['primary'] },
        'desktop:linux': { code: 'Slash', modifiers: ['primary'] },
        'web:macos': { code: 'Slash', modifiers: ['primary'] },
        'web:windows': { code: 'Slash', modifiers: ['primary'] },
        'web:linux': { code: 'Slash', modifiers: ['primary'] },
      },
      regions: ['page', 'editable', 'terminal'], modals: ['settings', 'shortcuts'],
      resolve: ({ modal }) => {
        if (modal !== null && modal !== 'settings' && modal !== 'shortcuts') return { status: 'blocked', reason: 'modal' }
        return { status: 'handled', run: () => {
          if (modal === 'shortcuts') closeTopModal(document)
          else openReference()
        } }
      },
    })
    const disposeSlot = ctx.slots.register({
      name: 'shell.overlay', id: 'shortcuts', locale: 'shortcuts', store,
      inject: injected,
    }, ShortcutReference)
    return () => { disposeCommand(); disposeSlot() }
  })

  // 落地端：接住 FP 发来的一次性「打开参考框」，用自己的 store 开；落地即清，重载不重放。
  ctx.effect(() => {
    if (!landsIntent) return () => { /* 发射端与其它面不落地 */ }
    const bridge = forwardBridge()
    const readIntent = bridge?.readIntent
    const onIntentChanged = bridge?.onIntentChanged
    if (readIntent === undefined || onIntentChanged === undefined) return () => { /* 桥不在就不参与 */ }
    let appliedAt = -1
    const drain = (): void => {
      void readIntent('shortcuts-panel').then((intent) => {
        if (!intent) return
        const at = typeof intent.at === 'number' ? intent.at : 0
        if (at <= appliedAt) return
        appliedAt = at
        instance.actions.open()
        const clearIntent = bridge?.clearIntent
        if (clearIntent !== undefined) void clearIntent('shortcuts-panel').catch(() => { /* 清不掉下次读再判一次 at */ })
      }, () => { /* 读失败等下一次变化 */ })
    }
    const off = onIntentChanged('shortcuts-panel', drain)
    // 面比发射端晚开时，把存着的那一条接住（已经是空的说明早已落地）。
    drain()
    return () => { if (typeof off === 'function') off() }
  }, 'ui-shortcuts: 跨面意图的落地')
}

// ── 跨面转发用到的宿主桥面（壳页挂在 window.__DSHANA__；缺失即整条不参与）───────────
interface ForwardBridge {
  readonly role?: string
  writeIntent?(kind: string, value: unknown): Promise<unknown>
  readIntent?(kind: string): Promise<{ value: unknown; at: number }>
  onIntentChanged?(kind: string, listener: () => void): () => void
  clearIntent?(kind: string): Promise<unknown>
}

function forwardBridge(): ForwardBridge | undefined {
  const bridge = (globalThis as { __DSHANA__?: ForwardBridge }).__DSHANA__
  return bridge !== null && typeof bridge === 'object' ? bridge : undefined
}

/** 发射一条意图（发射端用；桥不在或写失败就当没发出去）。 */
function emitIntent(kind: string, value: unknown): void {
  const written = forwardBridge()?.writeIntent?.(kind, value)
  if (written !== undefined) void written.catch(() => { /* 写不进则本次不发 */ })
}
