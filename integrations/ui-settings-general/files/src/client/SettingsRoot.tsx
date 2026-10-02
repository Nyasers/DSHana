/**
 * Settings shell root: the sidebar-foot trigger row plus the centered modal
 * panel (figma 2552:26025, 760x500) with the section nav rail. The shell is
 * a pure composition face — slot-owned text (trigger label, panel title,
 * close label, sections) arrives from registrants through slots; accessible
 * names resolve from localized content (trigger: shell locale; dialog:
 * aria-labelledby the title node; close: visually-hidden slot text). Modal
 * open state and the active section id belong to the declared owner store;
 * the onboarding coordinator mounts exactly one ordered registrant while the
 * sessions-derived empty-Hero fact is active. Visible dialog chrome belongs
 * to the step, so a mounted-but-deciding step paints nothing here.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  ConnectionIndicator, Tooltip, useModalLayer,
  IconAgentPresetOutlineMedium, IconArchiveOutlineMedium, IconCloseOutlineRegular, IconDataOutlineMedium,
  IconPersonalizationOutlineMedium, IconSettingsOutlineMedium, IconUserOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionIndicatorState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'
import { DesktopUpdateIndicator } from './DesktopUpdateIndicator.tsx'

const RECOVERY_CONFIRMATION_MS = 2_000

/** Minimum visible time for the connecting pill; shorter attempts read as flicker. */
const CONNECTING_MIN_VISIBLE_MS = 800

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'account') return <IconUserOutlineMedium className={css.navIcon} size={16} />
  if (id === 'models') return <IconDataOutlineMedium className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutlineMedium className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutlineMedium className={css.navIcon} size={16} />
  if (id === 'archived-sessions') return <IconArchiveOutlineMedium className={css.navIcon} size={16} />
  return <IconSettingsOutlineMedium className={css.navIcon} size={16} />
}

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
    embedded?: boolean
}

export type SettingsView = { open: boolean; section: string | null }

type HanaSettingsBridge = {
  role?: string
  readSettingsView?: () => Promise<SettingsView>
  writeSettingsView?: (next: SettingsView) => Promise<void>
  onSettingsViewChanged?: (listener: () => void) => () => void
}

function hanaBridge(): HanaSettingsBridge | undefined {
  return (globalThis as { __DSHANA__?: HanaSettingsBridge }).__DSHANA__
}

/**
 * Body-portaled modal layer: full-viewport mask + centered panel. Close paths: the
 * header button, a mask click, and document-level Escape (mounted only while
 * open, so the listener lifetime is the panel's).
 */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose, embedded = false }: PanelProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()

  const panel = useRef<HTMLDivElement>(null)
  // 嵌入式（占满整列）不是对话框：不装模态层、不抢焦点、不 portal。
  useModalLayer(panel, !embedded, onClose)

  // Portalled beside #root like the Modal primitive: a covering surface mounted
  // inside the root would precede the columns' chrome in document order, so a
  // chrome row that declares window drag after it would override its subtraction.
  // Beside the root, base.css's `body > :not(#root)` rule subtracts it instead.
  const shell = (
    <div className={embedded ? css.embedded : css.overlay} role={embedded ? 'region' : 'presentation'}>
      {!embedded && <div className={css.mask} aria-hidden="true" onClick={onClose} />}
      <div ref={panel} tabIndex={-1} data-shortcut-modal="settings" className={clsx(css.panel, embedded && css.embeddedPanel)} role={embedded ? undefined : 'dialog'} aria-modal={embedded ? undefined : 'true'} aria-labelledby={titleId}>
        <nav className={css.nav}>
          <div className={css.navTitle} id={titleId} tabIndex={-1}
            data-modal-autofocus={active === undefined ? '' : undefined}>{renderSlot('settings.header', {})}</div>
          <div className={css.navList}>
            {rows.map(row => (
              <button
                key={row.id}
                type="button"
                className={clsx(css.navCell, row.id === active && css.active)}
                aria-current={row.id === active ? 'true' : undefined}
                data-modal-autofocus={row.id === active ? '' : undefined}
                onClick={() => { onSelect(row.id) }}
              >
                {navIcon(row.id)}
                <span className={css.navLabel}>{row.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header}>
            <div className={css.actions}>{renderSlot('settings.action', {})}</div>
            <button type="button" className={css.close} onClick={onClose}>
              <IconCloseOutlineRegular size={14} />
              <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
            </button>
          </div>
          <div className={css.options}>
            {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
          </div>
        </div>
      </div>
    </div>
  )
  return embedded ? shell : createPortal(shell, document.body)
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const {
    wide, reconnect, useConnectionState, useSections, useOnboardingSteps, useSessions, renderSlot, t,
    useDesktopUpdate, openDesktopUpdate, useStore, actions, useShortcuts,
  } = props
  const bridge = hanaBridge()
  const role = bridge?.role ?? 'navigation'
  const readView = bridge?.readSettingsView
  const writeView = bridge?.writeSettingsView
  const onViewChanged = bridge?.onSettingsViewChanged
  const { open, activeId } = useStore(state => state)
  const shortcut = useShortcuts(rows => rows.find(row => row.id === 'settings.open'))
  const { open: openState, close: closeState, select: selectState, openSection: openSectionState } = actions
  const [requestedOnboarding, setRequestedOnboarding] = useState<string | undefined>()
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const [showRecovery, setShowRecovery] = useState(false)
  const [viewFailure, setViewFailure] = useState<{ kind: 'read' | 'write'; revision: number } | null>(null)
  const [holdConnecting, setHoldConnecting] = useState(false)
  const connectingShownAt = useRef<number | undefined>(undefined)
  const viewRevision = useRef(0)
  const pendingWrite = useRef<{ next: SettingsView; revision: number } | null>(null)
  const refreshSettingsView = useRef<(() => void) | undefined>(undefined)

  // 把视图状态写出去（revision 守卫：晚到的写不覆盖新状态；失败保留可重试信息）
  const publish = useCallback((next: SettingsView) => {
    const revision = ++viewRevision.current
    pendingWrite.current = { next, revision }
    setViewFailure(null)
    if (writeView === undefined) {
      setViewFailure({ kind: 'write', revision })
      return
    }
    void writeView(next).then(() => {
      if (pendingWrite.current?.revision === revision) pendingWrite.current = null
    }, (error: unknown) => {
      if (revision !== viewRevision.current) return
      console.error('DSH settings view could not be synchronized.', error)
      setViewFailure({ kind: 'write', revision })
    })
  }, [writeView])

  const close = useCallback(() => {
    closeState()
    publish({ open: false, section: null })
  }, [closeState, publish])
  const openSection = useCallback((id?: string) => {
    if (id === undefined) openState()
    else openSectionState(id)
    publish({ open: true, section: id ?? activeId ?? null })
  }, [activeId, openState, openSectionState, publish])

  // 跟随共享状态：只有 workspace / standalone 订阅并应用——
  // FP（navigation）是发射端（点设置写出去），主卡是接收端（读进来以模态面板打开）。
  useEffect(() => {
    if (role === 'navigation' || role === 'settings' || readView === undefined || onViewChanged === undefined) {
      refreshSettingsView.current = undefined
      return
    }
    let active = true
    let generation = 0
    const refresh = () => {
      const request = ++generation
      const revision = viewRevision.current
      void readView().then((next) => {
        if (!active || request !== generation || revision !== viewRevision.current) return
        if (next.open) {
          if (next.section === null) openState()
          else openSectionState(next.section)
        } else {
          closeState()
        }
      }, (error: unknown) => {
        if (!active || request !== generation) return
        console.error('DSH settings view could not be read.', error)
        if (revision === viewRevision.current) setViewFailure({ kind: 'read', revision })
      })
    }
    const off = onViewChanged(refresh)
    refreshSettingsView.current = refresh
    refresh()
    return () => {
      active = false
      generation++
      if (refreshSettingsView.current === refresh) refreshSettingsView.current = undefined
      off()
    }
  }, [readView, onViewChanged, role])

  // The ledger tick keeps the nav rows fresh: registrants re-register with
  // freshly localized text on locale change, and the trigger/header/close
  // seats re-render through their own outlets' subscriptions.
  const rows = useSections(s => s)
  const desktopUpdate = useDesktopUpdate(state => state)
  const connectionState = useConnectionState(state => state)
  const previousConnectionState = useRef(connectionState)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions((state) => {
    const main = Object.values(state.byId)
      .find(session => (session.retainedBy.mainView ?? 0) > 0)
    return state.phase === 'ready' && (main === undefined || main.blank)
  })
  // 引导态只有主卡 / 拆窗面持有：FP 与设置面不抢 onboarding。
  const ownsOnboarding = role === 'workspace' || role === 'standalone'
  const onboardingStep = !ownsOnboarding
    ? undefined
    : requestedOnboarding !== undefined
      ? onboardingSteps.find(step => step.id === requestedOnboarding)
      : onboardingActive
        ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
        : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const onboardingStepSeen = useRef(onboardingStep)
  // An onboarding step owns the viewport and marks `#root` inert. The panel portals
  // beside `#root`, outside that mark, so a step that appears while the panel is open
  // takes the panel down rather than leaving it focusable behind the onboarding mask.
  useEffect(() => {
    const appeared = onboardingStepSeen.current === undefined && onboardingStep !== undefined
    onboardingStepSeen.current = onboardingStep
    if (appeared && open) close()
  }, [onboardingStep, open, close])

  useLayoutEffect(() => {
    const previous = previousConnectionState.current
    previousConnectionState.current = connectionState
    if (connectionState !== 'connected') {
      setShowRecovery(false)
      return
    }
    if (previous !== 'disconnected' && previous !== 'connecting') return
    setShowRecovery(true)
  }, [connectionState])

  // The confirmation window starts when the recovered pill becomes visible,
  // which the connecting minimum-visible hold can delay past the transition.
  useLayoutEffect(() => {
    if (!showRecovery || holdConnecting) return
    const timeout = window.setTimeout(() => { setShowRecovery(false) }, RECOVERY_CONFIRMATION_MS)
    return () => { window.clearTimeout(timeout) }
  }, [showRecovery, holdConnecting])

  useLayoutEffect(() => {
    if (connectionState === 'connecting') {
      connectingShownAt.current = Date.now()
      return
    }
    const shownAt = connectingShownAt.current
    if (shownAt === undefined) return
    connectingShownAt.current = undefined
    const remaining = CONNECTING_MIN_VISIBLE_MS - (Date.now() - shownAt)
    if (remaining <= 0) return
    setHoldConnecting(true)
    const timeout = window.setTimeout(() => { setHoldConnecting(false) }, remaining)
    return () => {
      window.clearTimeout(timeout)
      setHoldConnecting(false)
    }
  }, [connectionState])

  const completeOnboardingStep = useCallback((id: string) => {
    setRequestedOnboarding(undefined)
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  let connectionIndicator: ConnectionIndicatorState | undefined
  if (connectionState === 'connecting' || holdConnecting) {
    connectionIndicator = 'connecting'
  } else if (connectionState === 'disconnected') {
    connectionIndicator = 'disconnected'
  } else if (showRecovery) {
    connectionIndicator = 'recovered'
  }

  // 设置面：整列 embedded，无触发器、无模态。
  if (role === 'settings') {
    return (
      <SettingsPanel
        rows={rows}
        renderSlot={renderSlot}
        activeId={activeId}
        onSelect={selectState}
        onClose={() => { /* settings 面常开，无关闭语义 */ }}
        embedded
      />
    )
  }

  const panel = open && (
    <SettingsPanel
      rows={rows}
      renderSlot={renderSlot}
      activeId={activeId}
      onSelect={(id: string) => { selectState(id); publish({ open: true, section: id }) }}
      onClose={close}
    />
  )
  // FP（navigation）**只发射状态、自己不渲染面板**：
    // 这里让步：面板归 workspace 面，FP 只留齿轮入口（点击照常 publish，主卡就会开）。
  const localPanel = role === 'navigation' ? null : panel
  const onboarding = onboardingStep !== undefined && renderSlot('settings.onboarding', {
    stepId: onboardingStep.id,
    explicit: requestedOnboarding !== undefined,
    complete: () => { completeOnboardingStep(onboardingStep.id) },
    openSection,
  }, { only: onboardingStep.id })
  const retryView = () => {
    if (viewFailure?.kind === 'write' && pendingWrite.current?.revision === viewFailure.revision) {
      publish(pendingWrite.current.next)
    } else if (viewFailure?.kind === 'read' && viewFailure.revision === viewRevision.current) {
      refreshSettingsView.current?.()
    }
  }
  const syncFailure = viewFailure !== null && (
    <p className={css.syncError} role="alert">
      {t(viewFailure.kind === 'read' ? 'view.readError' : 'view.writeError')}{' '}
      <button type="button" className={css.retry} onClick={retryView}>{t('view.retry')}</button>
    </p>
  )

  // 主卡面：**只画面板，不画触发器**——这就是「FP 点设置、主卡打开」的落点。
  if (role === 'workspace') return <>{panel}{syncFailure}{onboarding}</>

  return (
    <>
      <div className={clsx(css.triggerRow, !wide && css.railRow)}>
        {renderSlot('settings.launcher', {
          wide, settingsOpen: open, openSettings: openSection,
          ...(shortcut?.keys.length ? { settingsShortcut: { keys: shortcut.keys, aria: shortcut.aria } } : {}),
          openOnboarding: (id) => { close(); setRequestedOnboarding(id) },
        }, { fallback: <Tooltip disabled={open} label={t('trigger')} shortcutKeys={shortcut?.keys}>
          <button
            type="button"
            className={clsx(css.trigger, !wide && css.rail)}
            aria-label={t('trigger')}
            aria-keyshortcuts={shortcut?.aria}
            aria-haspopup="dialog"
            aria-expanded={role === 'navigation' ? false : open}
            onClick={() => { openSection() }}
          >
            {renderSlot('settings.trigger', { wide })}
          </button>
        </Tooltip> })}
        <ConnectionIndicator
          state={wide && desktopUpdate.presentation?.phase !== 'installing' ? connectionIndicator : undefined}
          disconnectedLabel={t('connection.error')}
          connectingLabel={t('connection.connecting')}
          recoveredLabel={t('connection.connected')}
          reconnectActionLabel={t('connection.reconnect')}
          restartActionLabel={t('connection.restart')}
          onReconnect={reconnect}
        />
        <DesktopUpdateIndicator wide={wide} hidden={connectionIndicator !== undefined && desktopUpdate.presentation?.phase !== 'installing'}
          t={t} view={desktopUpdate} onOpen={openDesktopUpdate} />
      </div>
      {localPanel}
      {syncFailure}
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. */}
      {onboarding}
    </>
  )
}
