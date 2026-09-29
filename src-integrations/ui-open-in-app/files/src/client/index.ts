/**
 * Shared native opening controls for workspace directories, document previews,
 * delivery cards, and changed-file review. Directory choices persist in the browser;
 * file defaults and application lists come from the serving Host desktop.
 */

import { createElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import { OPEN_IN_APP_ICON_PREFIX_ROUTE } from '@deepseek-ai/dsh-host-open-in-app/shared'
import { OpenInAppController } from './controller.ts'
import { OpenInAppAction, type OpenInAppActionInjected, type OpenInAppActionProps } from './OpenInAppAction.tsx'
import { OpenInAppPathController } from './open-path.ts'
import { OpenPathAction, type OpenPathInjected } from './OpenPathAction.tsx'
import { FileRouteAction } from './FileRouteAction.tsx'
import { OpenPathEmptyAction } from './OpenPathEmptyAction.tsx'
import { en, NS, zh, type OpenInAppKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session-header "open workspace in application" copy. */
    'open-in-app': OpenInAppKey
  }
}

export type { OpenInAppActionInjected, OpenInAppActionProps } from './OpenInAppAction.tsx'
export type { OpenInAppPathAction, OpenInAppPathFailure, OpenInAppPathRemote } from './open-path.ts'
export type { OpenPathActionProps, OpenPathInjected } from './OpenPathAction.tsx'
export type { OpenPathEmptyActionProps } from './OpenPathEmptyAction.tsx'

/** Required services: sessions, layout selection, the slot registry, copy, Remote calls, and shortcuts. */
export const inject = ['sessions', 'slots', 'locale', 'remote', 'remote.session', 'shortcuts', 'layout']

/**
 * Client plugin body: register dictionaries, workspace directory controls, and
 * document preview path controls.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
    // 浏览器裸 fetch 打宿主源必被凭据闸 403（missing_credential）。改用官方 __DSH_TRANSPORT__
  // （把请求重写到 App 的私有运行时基址）当 carrier；拿不到时传 undefined，退回控制器
    const bridgeFetch = (globalThis as {
    __DSH_TRANSPORT__?: { fetch?: (input: string | URL, init?: RequestInit) => Promise<Response> }
  }).__DSH_TRANSPORT__?.fetch
  const fetcher = bridgeFetch === undefined
    ? undefined
    : (input: string | URL, init?: RequestInit): Promise<Response> =>
      bridgeFetch(new URL(input, 'http://dsh.internal'), init)
        const bridgeUrl = (globalThis as {
    __DSHANA__?: { runtimeUrl?: (path: string) => string }
  }).__DSHANA__?.runtimeUrl
  const iconUrl = (path: string): string => {
    try {
      const mapped = bridgeUrl?.(path)
      if (typeof mapped === 'string' && mapped !== '') return mapped
    } catch { /* 桥异常则退回原路径 */ }
    return path
  }
  const controller = new OpenInAppController(fetcher)
  void controller.load()
  const paths = new OpenInAppPathController(ctx.remote)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'open-in-app: dictionaries')
  const t = ctx.locale.bind(NS)
  const target = () => {
    if (ctx.layout.panelInfo.getSnapshot().activePanelId !== null) return undefined
    const session = Object.values(ctx.sessions.list.getSnapshot().byId)
      .find(row => (row.retainedBy.mainView ?? 0) > 0)
    const appId = controller.currentApp()
    return session?.cwd && appId !== undefined ? { appId, path: session.cwd } : undefined
  }
  ctx.effect(() => ctx.shortcuts.register({
    id: 'workspace.openLocal' as ShortcutCommandId, label: () => t('open.tooltip'), aliases: ['open workspace locally', 'open in app'],
    defaults: {
      'desktop:macos': { code: 'KeyO', modifiers: ['primary', 'alt'] },
      'desktop:windows': { code: 'KeyO', modifiers: ['primary', 'alt'] },
      'desktop:linux': { code: 'KeyO', modifiers: ['primary', 'alt'] },
      'web:macos': { code: 'KeyO', modifiers: ['primary', 'shift'] },
      'web:windows': { code: 'KeyO', modifiers: ['primary', 'shift'] },
    },
    regions: ['page', 'editable'], modals: [],
    resolve: () => {
      if (controller.operation.getSnapshot().phase === 'busy') return { status: 'blocked', reason: t('shortcut.busy') }
      const selected = target()
      if (selected === undefined) return { status: 'blocked', reason: t('shortcut.unavailable') }
      return { status: 'handled', run: () => {
        void controller.launch(selected.appId, selected.path).catch((error: unknown) => {
          console.warn('workspace open rejected:', error)
        })
      } }
    },
  }), 'open-in-app: workspace command')
  const directoryInjected = (): OpenInAppActionInjected => ({
    hooks: {
      openInAppApps: controller.apps,
      openInAppChoice: controller.choice,
      openInAppLaunch: controller.operation,
      shortcuts: ctx.shortcuts.catalog,
    },
    launch: (appId, path) => controller.launch(appId, path),
    choose: (appId) => { controller.choose(appId) },
    iconUrl: appId => iconUrl(`${OPEN_IN_APP_ICON_PREFIX_ROUTE}/${appId}`),
  })
  function SessionOpenInAppAction(
    props: PropsRuntime<'conversation.session.header.utilities'> & Omit<OpenInAppActionProps, 'absolutePath'>,
  ) {
    const { sessionId, useSessions } = props
    const cwd = useSessions(state => state.byId[sessionId]?.cwd)
    return cwd ? createElement(OpenInAppAction, { ...props, absolutePath: cwd }) : null
  }
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'open-in-app', order: -10, locale: NS, inject: directoryInjected,
  }, SessionOpenInAppAction))
  ctx.slots.inject('sidebar.right.tab.files.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.files.actions',
    id: 'open-in-app', locale: NS, inject: directoryInjected,
  }, OpenInAppAction))
  const applications: OpenPathInjected['applications'] = (path, signal) => paths.applications(path, signal)
  const pathInjected = (): OpenPathInjected => ({
    hooks: { openInAppDesktop: paths.desktop },
    loadDesktop: () => paths.load(),
    openPath: (path, action, application) => paths.openPath(path, action, application),
    applications,
  })
  ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.actions',
    id: 'open-in-app',
    locale: NS,
    inject: pathInjected,
  }, OpenPathAction))
  ctx.slots.inject('sidebar.right.tab.document.unpreviewable', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.unpreviewable',
    id: 'open-in-app',
    locale: NS,
    inject: pathInjected,
  }, OpenPathEmptyAction))
  ctx.slots.inject('deliverables.file.actions', () => ctx.slots.register({
    name: 'deliverables.file.actions', id: 'open-in-app', locale: NS,
  }, FileRouteAction))
  ctx.slots.inject('deliverables.review.file.actions', () => ctx.slots.register({
    name: 'deliverables.review.file.actions', id: 'open-in-app', locale: NS,
  }, FileRouteAction))
}
