/** Session Controller adapter for React selector hooks and Slot scope data. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  ISessions,
  SessionBinding,
  SessionListState,
  SessionReference,
  SessionRetainInfo,
  SessionSnapshot,
  UseProjection,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// ui-workspace 的导航面（declare merge 的 ctx.uiWorkspace）：切会话请本面所属文档的视图所有者代劳。
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import { WeakMapWithValues } from '@deepseek-ai/dsh-util-values'
import { standardHookPropName } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  HostObservable,
  KeyedStandardSource,
  MaybeSnapshotSelectorHook,
  RootStandardSourceContribution,
  ScopedStandardSourceBinding,
  SlotScopeAdapter,
  SnapshotSelectorHook,
  StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only service merge for ctx.slots.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { renderSessionArea } from './session-provider.tsx'

/** Selector hook over the Session Controller list and current selection. */
export type UseSessions = SnapshotSelectorHook<SessionListState>
/** Selector hook over one Session's lifecycle and control state. */
export type SessionSnapshotSelector = SnapshotSelectorHook<SessionSnapshot>
/** Public name for the Session lifecycle selector hook. */
export type UseSession = SessionSnapshotSelector

/** Common identity carried by every Session-scoped pending interaction. */
export interface SessionPendingInteractionBase {
  /** Opaque request identity; a replacement request must use a new key. */
  readonly key: string
  /** Domain-owned presentation discriminator. */
  readonly kind: string
  /** Session whose UI can answer this interaction. */
  readonly sessionId: SessionId
}

/** Declaration-merged map of domain keys to their pending-interaction values. */
export interface SessionPendingInteractionMap {}

/** Union of every pending-interaction value contributed by the assembled Client. */
export type SessionPendingInteraction =
  [keyof SessionPendingInteractionMap] extends [never]
    ? SessionPendingInteractionBase
    : SessionPendingInteractionMap[keyof SessionPendingInteractionMap]

/** Independent UI status facts for one Session identity. */
export interface SessionStatus {
  /** Latest known running state; absent until a baseline or event establishes it. */
  readonly running: boolean | undefined
  /** Highest-precedence domain request currently awaiting user interaction. */
  readonly pendingInteraction: SessionPendingInteraction | undefined
  /** Whether an observed stop outside the main view still needs acknowledgement. */
  readonly completionUnread: boolean
}

/** Current UI status indexed by Session identity. */
export type SessionStatusSnapshot = ReadonlyMap<SessionId, SessionStatus>
/** Selector hook over the unified Session UI status snapshot. */
export type UseSessionStatus = SnapshotSelectorHook<SessionStatusSnapshot>

/** Selector hook for explicit or surrounding-Provider Session reference counts. */
export interface UseSessionRetainInfo {
  /**
   * Read the complete retain information for an explicit Session identity.
   * @param sessionId - Session identity to inspect without retaining it.
   * @returns current local reference counts, or absence while the source is unavailable.
   */
  (sessionId: SessionId): SessionRetainInfo | undefined
  /**
   * Select from the retain information for an explicit Session identity.
   * @param sessionId - Session identity to inspect without retaining it.
   * @param selector - projection over the current value.
   * @param equal - optional selected-value equality.
   * @returns selected value.
   */
  <Selected>(
    sessionId: SessionId,
    selector: (value: SessionRetainInfo | undefined) => Selected,
    equal?: (left: Selected, right: Selected) => boolean,
  ): Selected
  /**
   * Select from the surrounding Provider's Session retain information.
   * @param selector - projection receiving absence outside a Session binding.
   * @param equal - optional selected-value equality.
   * @returns selected value.
   */
  <Selected>(
    selector: (value: SessionRetainInfo | undefined) => Selected,
    equal?: (left: Selected, right: Selected) => boolean,
  ): Selected
}

/** Publish one pending interaction and define how plugin teardown delegates it. */
export type PendingInteractionPublisher<T extends SessionPendingInteractionBase> = (
  interaction: T,
  delegate: () => Promise<void>,
) => () => void

interface PendingInteractionEntry<T> {
  readonly interaction: T
  readonly delegate: () => Promise<void>
}

class PendingInteractionDomain<T extends SessionPendingInteractionBase> {
  private readonly values = new Map<string, PendingInteractionEntry<T>>()

  constructor(
    readonly precedence: (interaction: T) => number,
    private readonly changed: () => void,
  ) {}

  valuesSnapshot(): readonly T[] {
    return [...this.values.values()].map(entry => entry.interaction)
  }

  publish(interaction: T, delegate: () => Promise<void>): () => void {
    if (this.values.has(interaction.key)) {
      throw new Error(`ui-session: duplicate pending interaction key '${interaction.key}'`)
    }
    this.values.set(interaction.key, { interaction, delegate })
    this.changed()
    let active = true
    return () => {
      if (!active) return
      active = false
      if (!this.values.delete(interaction.key)) return
      this.changed()
    }
  }

  /** Remove every pending value and return the operations that settle their owners. */
  release(): readonly (() => Promise<void>)[] {
    const delegates = [...this.values.values()].map(entry => entry.delegate)
    this.values.clear()
    return delegates
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotScopeTargetMap {
    session: SessionReference
  }

  interface GlobalStandardProps {
    /** Session list and current selection. */
    useSessions: UseSessions
    useSessionStatus: UseSessionStatus
    useSessionRetainInfo: UseSessionRetainInfo
  }

  interface SessionStandardProps {
    /** Current Session lifecycle and control state. */
    useSession: SessionSnapshotSelector
    /** Current Session identity. */
    sessionId: SessionId
    /** Host-computed projection values addressed by projection key. */
    useProjection: UseProjection
  }

  interface SessionMaybeStandardProps {
    /** Current Session state, absent while no Session is selected. */
    useSession: MaybeSnapshotSelectorHook<SessionSnapshot>
    /** Current Session identity, absent while no Session is selected. */
    sessionId: SessionId | undefined
    /** Host-computed projection values; every key is absent without a Session. */
    useProjection: UseProjection
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    mainView: unknown
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session Controller adapter and session-scoped source registry. */
    uiSession: UiSession
  }
}

type SessionSourceRoster = readonly string[] | undefined
type StandardMemberKind = 'hook' | 'keyed hook' | 'prop'

type SessionSourceRecord<Roster extends SessionSourceRoster, Value> =
  Roster extends readonly string[] ? Readonly<Record<Roster[number], Value>> : never

/** Bare values produced by one Session-scoped source contribution. */
export interface SessionSourceContribution<
  Hooks extends SessionSourceRoster = SessionSourceRoster,
  KeyedHooks extends SessionSourceRoster = SessionSourceRoster,
  Props extends SessionSourceRoster = SessionSourceRoster,
> {
  readonly hooks?: SessionSourceRecord<Hooks, HostObservable<unknown>>
  readonly keyedHooks?: SessionSourceRecord<KeyedHooks, KeyedStandardSource>
  readonly props?: SessionSourceRecord<Props, unknown>
}

/** Static roster and per-Session resolver for one standard-props contribution. */
export interface SessionSourceDescriptor<
  Hooks extends SessionSourceRoster = SessionSourceRoster,
  KeyedHooks extends SessionSourceRoster = SessionSourceRoster,
  Props extends SessionSourceRoster = SessionSourceRoster,
> {
  readonly hooks?: Hooks
  readonly keyedHooks?: KeyedHooks
  readonly props?: Props
  /**
   * Resolve every declared member for one Session binding.
   * @param binding - Controller-owned Session binding.
   * @returns all declared bare sources and stable props.
   */
  resolve(binding: SessionBinding): SessionSourceContribution<
    NoInfer<Hooks>,
    NoInfer<KeyedHooks>,
    NoInfer<Props>
  >
}

interface RuntimeSessionSourceContribution {
  readonly hooks?: Readonly<Record<string, HostObservable<unknown>>>
  readonly keyedHooks?: Readonly<Record<string, KeyedStandardSource>>
  readonly props?: Readonly<Record<string, unknown>>
}

interface RuntimeSessionSourceDescriptor {
  readonly hooks?: readonly string[]
  readonly keyedHooks?: readonly string[]
  readonly props?: readonly string[]
  resolve(binding: SessionBinding): RuntimeSessionSourceContribution
}

type RuntimePendingDomain = PendingInteractionDomain<SessionPendingInteractionBase>

interface MaterializedBinding {
  readonly owner: SessionBinding
  readonly source: BindingSource
  readonly release: () => void
}

interface BindingSource extends HostObservable<StandardSourceBinding> {
  value: StandardSourceBinding
  readonly listeners: Set<() => void>
}

const BUILTIN_SOURCE = {
  hooks: ['session'],
  keyedHooks: ['projection'],
  props: ['sessionId'],
  resolve: binding => ({
    hooks: { session: binding.session },
    keyedHooks: { projection: key => binding.session.projections.faceOf(key) },
    props: { sessionId: binding.sessionId },
  }),
} satisfies SessionSourceDescriptor<
  readonly ['session'],
  readonly ['projection'],
  readonly ['sessionId']
>

/** Session-scoped source roster and renderer adapter. */
export class UiSession extends Service {
  private readonly descriptors: RuntimeSessionSourceDescriptor[] = [
    BUILTIN_SOURCE,
  ]
  private readonly bindings = new WeakMapWithValues<SessionBinding, MaterializedBinding>()
  private readonly absent: BindingSource
  private readonly current: BindingSource
  private readonly pendingDomains: RuntimePendingDomain[] = []
  private pendingSnapshot: ReadonlyMap<SessionId, SessionPendingInteractionBase> = new Map()
  private readonly running = new Map<SessionId, boolean>()
  private readonly completionUnread = new Set<SessionId>()
  private statusSnapshot: SessionStatusSnapshot = new Map()
  private readonly statusListeners = new Set<() => void>()
  private mainRetainId: SessionId | undefined
  private disposeMainRetain = (): void => {}
  private active = true
  /** Root source combining running, pending-interaction, and completion-reminder facts. */
  readonly sessionStatus: HostObservable<SessionStatusSnapshot> = {
    getSnapshot: () => this.statusSnapshot,
    subscribe: (listener) => {
      this.statusListeners.add(listener)
      return () => { this.statusListeners.delete(listener) }
    },
  }
  /** Renderer-facing adapter for `session` and `session-maybe` scopes. */
  readonly adapter: SlotScopeAdapter

  /**
   * @param ctx - Client root context.
   * @param sessions - Controller-owned Session object layer.
   */
  constructor(
    ctx: Context,
    private readonly sessions: ISessions,
  ) {
    super(ctx, 'uiSession')
    this.absent = createBindingSource(this.materializeAbsent())
    this.current = createBindingSource(this.absent.value)
    this.adapter = {
      current: this.current,
      bindingSource: target => this.bindingSource(target),
      renderArea: renderSessionArea,
    }

    ctx.effect(() => {
      const disposeList = sessions.list.subscribe(() => { this.publishMain() })
      const disposeStatus = sessions.list.subscribe(() => { this.reconcileStatus() })
      const disposeRemoteStatus = ctx.remote.$on('api-session/status', (sessionId, running) => {
        this.observeRunning(sessionId, running)
      })
      this.publishMain()
      this.reconcileStatus()
      return () => {
        this.active = false
        disposeList()
        disposeStatus()
        disposeRemoteStatus()
        this.disposeMainRetain()
        const records = [...this.bindings.values]
        this.bindings.clear()
        for (const record of records) record.release()
      }
    }, 'ui-session: Session binding projection')
  }

  /**
   * Resolve a stable renderer source for an owned Session reference or explicit absence.
   * @param reference - active reference supplied by the Provider owner, or absence.
   * @returns the binding source, which falls back to the absent projection when its generation ends.
   * @throws when the reference does not belong to the active Controller generation.
   */
  bindingSource(reference: SessionReference | undefined): HostObservable<StandardSourceBinding> {
    if (!this.active) return this.absent
    if (reference === undefined) return this.absent
    const owner = reference.binding
    if (this.sessions.binding(reference.sessionId) !== owner) {
      throw new Error('ui-session: Session reference is not active in this Controller')
    }
    return this.sourceFor(owner)
  }

  /**
   * Register one Session-scoped standard-source contribution.
   * @param descriptor - static member roster and per-binding resolver.
   * @returns disposer owned by the caller's Cordis fiber.
   */
  provide<
    const Hooks extends SessionSourceRoster = undefined,
    const KeyedHooks extends SessionSourceRoster = undefined,
    const Props extends SessionSourceRoster = undefined,
  >(descriptor: SessionSourceDescriptor<Hooks, KeyedHooks, Props>): () => void {
    const runtimeDescriptor = descriptor as unknown as RuntimeSessionSourceDescriptor
    const dispose = this.ctx.effect(() => {
      this.descriptors.push(runtimeDescriptor)
      try {
        this.rebuildBindings()
      } catch (error) {
        this.descriptors.pop()
        throw error
      }
      return () => {
        const index = this.descriptors.indexOf(runtimeDescriptor)
        this.descriptors.splice(index, 1)
        this.rebuildBindings()
      }
    }, 'uiSession.provide()')
    return () => { void dispose() }
  }

  /**
   * Register one pending-interaction domain and return its publication function.
   * Domain teardown first removes its visible values, then delegates and awaits
   * every still-active owner request.
   * @param precedence - deterministic cross-domain precedence; larger values win.
   * @returns a function that publishes one interaction and its teardown delegation.
   */
  registerPendingInteraction<T extends SessionPendingInteractionBase>(
    precedence: (interaction: T) => number,
  ): PendingInteractionPublisher<T> {
    const domain = new PendingInteractionDomain(precedence, () => {
      this.publishPendingInteractions()
    })
    const runtimeDomain = domain as unknown as RuntimePendingDomain
    this.ctx.effect(() => {
      this.pendingDomains.push(runtimeDomain)
      this.publishPendingInteractions()
      return async () => {
        const delegates = domain.release()
        const index = this.pendingDomains.indexOf(runtimeDomain)
        this.pendingDomains.splice(index, 1)
        this.publishPendingInteractions()
        await Promise.allSettled(delegates.map(delegate => Promise.resolve().then(delegate)))
      }
    }, 'uiSession.registerPendingInteraction()')
    return (interaction, delegate) => domain.publish(interaction, delegate)
  }

  private rebuildBindings(): void {
    const absent = this.materializeAbsent()
    const updates = [...this.bindings.values].map(record => ({
      source: record.source,
      value: this.materialize(record.owner),
    }))
    this.absent.value = absent
    for (const { source, value } of updates) source.value = value
    notifySubscribers(this.absent.listeners, '[ui-session] absent binding')
    for (const { source } of updates) {
      notifySubscribers(source.listeners, '[ui-session] Session binding')
    }
    this.publishMain()
  }

  private sourceFor(owner: SessionBinding): BindingSource {
    const cached = this.bindings.get(owner)
    if (cached !== undefined) return cached.source
    const record = this.createMaterializedBinding(owner)
    this.bindings.set(owner, record)
    return record.source
  }

  private publishMain(): void {
    if (!this.active) return
    const byId = this.sessions.list.getSnapshot().byId
    const currentId = this.current.value.key as SessionId | undefined
    const currentIsMain = currentId !== undefined
      && (this.sessions.retainInfo(currentId).getSnapshot().retainedBy.mainView ?? 0) > 0
    const nextId = currentIsMain
      ? currentId
      : Object.values(byId).find(candidate => (candidate.retainedBy.mainView ?? 0) > 0)?.id
    this.watchMainRetention(nextId)
    const owner = nextId === undefined ? undefined : this.sessions.binding(nextId)
    const value = owner === undefined ? this.absent.value : this.sourceFor(owner).value
    if (this.current.value === value) return
    this.current.value = value
    notifySubscribers(this.current.listeners, '[ui-session] main binding')
  }

  private watchMainRetention(sessionId: SessionId | undefined): void {
    if (sessionId === this.mainRetainId) return
    this.disposeMainRetain()
    this.mainRetainId = sessionId
    this.disposeMainRetain = sessionId === undefined
      ? () => {}
      : this.sessions.retainInfo(sessionId).subscribe(() => { this.publishMain() })
  }

  private publishPendingInteractions(): void {
    const next = new Map<SessionId, {
      interaction: SessionPendingInteractionBase
      precedence: number
    }>()
    for (const domain of this.pendingDomains) {
      for (const interaction of domain.valuesSnapshot()) {
        const precedence = domain.precedence(interaction)
        const previous = next.get(interaction.sessionId)
        if (previous === undefined || precedence >= previous.precedence) {
          next.set(interaction.sessionId, { interaction, precedence })
        }
      }
    }
    const projected = new Map(
      [...next].map(([sessionId, value]) => [sessionId, value.interaction] as const),
    )
    if (samePendingInteractions(this.pendingSnapshot, projected)) return
    this.pendingSnapshot = projected
    this.publishStatus()
  }

  private observeRunning(sessionId: SessionId, running: boolean): void {
    const previous = this.running.get(sessionId)
    const beforeBaseline = this.sessions.list.getSnapshot().phase === 'pending'
    this.running.set(sessionId, running)
    if (running) this.completionUnread.delete(sessionId)
    else if ((previous === true || (previous === undefined && beforeBaseline))
      && !this.isMain(sessionId)) this.completionUnread.add(sessionId)
    this.publishStatus()
  }

  private reconcileStatus(): void {
    const list = this.sessions.list.getSnapshot()
    const present = new Set(Object.keys(list.byId) as SessionId[])
    for (const id of present) {
      const row = list.byId[id]
      if (row === undefined) continue
      const previous = this.running.get(id)
      if (previous === undefined) this.running.set(id, row.running)
      else if (previous !== row.running) this.observeRunning(id, row.running)
      if ((row.retainedBy.mainView ?? 0) > 0) this.completionUnread.delete(id)
    }
    if (list.phase === 'ready') {
      for (const id of this.running.keys()) {
        if (present.has(id)) continue
        this.running.delete(id)
        this.completionUnread.delete(id)
      }
    }
    this.publishStatus()
  }

  private isMain(sessionId: SessionId): boolean {
    return (this.sessions.list.getSnapshot().byId[sessionId]?.retainedBy.mainView ?? 0) > 0
  }

  private publishStatus(): void {
    const ids = new Set<SessionId>([
      ...(Object.keys(this.sessions.list.getSnapshot().byId) as SessionId[]),
      ...this.running.keys(),
      ...this.pendingSnapshot.keys(),
      ...this.completionUnread,
    ])
    const next = new Map<SessionId, SessionStatus>()
    for (const id of ids) {
      next.set(id, {
        running: this.running.get(id),
        pendingInteraction: this.pendingSnapshot.get(id),
        completionUnread: this.completionUnread.has(id),
      })
    }
    if (sameSessionStatus(this.statusSnapshot, next)) return
    this.statusSnapshot = next
    notifySubscribers(this.statusListeners, '[ui-session] Session status')
  }

  private createMaterializedBinding(owner: SessionBinding): MaterializedBinding {
    const value = this.materialize(owner)
    this.ctx.slots.bindStoreScope(value)
    const source = createBindingSource(value)
    const releaseEffect = owner.ctx.effect(() => () => {
      if (this.bindings.get(owner) === record) this.bindings.delete(owner)
      source.value = this.absent.value
      notifySubscribers(source.listeners, '[ui-session] Session binding')
      this.publishMain()
    }, `ui-session: binding ${owner.sessionId}`)
    const record: MaterializedBinding = {
      owner,
      source,
      release: () => { void releaseEffect() },
    }
    return record
  }

  private materialize(binding: SessionBinding): ScopedStandardSourceBinding {
    const hooks: Record<string, HostObservable<unknown>> = {}
    const keyedHooks: Record<string, KeyedStandardSource> = {}
    const props: Record<string, unknown> = {}
    const finalProps = new Set<string>()
    for (const descriptor of this.descriptors) {
      const contribution = descriptor.resolve(binding)
      validateContribution(descriptor, contribution)
      copyDeclared('hook', hooks, descriptor.hooks, contribution.hooks, finalProps)
      copyDeclared('keyed hook', keyedHooks, descriptor.keyedHooks, contribution.keyedHooks, finalProps)
      copyDeclared('prop', props, descriptor.props, contribution.props, finalProps)
    }
    const value: ScopedStandardSourceBinding = {
      key: binding.sessionId,
      ctx: binding.ctx,
      hooks,
      keyedHooks,
      props,
    }
    return value
  }

  private materializeAbsent(): StandardSourceBinding {
    const hooks: Record<string, undefined> = {}
    const keyedHooks: Record<string, undefined> = {}
    const props: Record<string, undefined> = {}
    const finalProps = new Set<string>()
    for (const descriptor of this.descriptors) {
      declareAbsent('hook', hooks, descriptor.hooks, finalProps)
      declareAbsent('keyed hook', keyedHooks, descriptor.keyedHooks, finalProps)
      declareAbsent('prop', props, descriptor.props, finalProps)
    }
    return { key: undefined, hooks, keyedHooks, props }
  }
}

function createBindingSource(value: StandardSourceBinding): BindingSource {
  const source: BindingSource = {
    value,
    listeners: new Set(),
    getSnapshot: () => source.value,
    subscribe: (listener) => {
      source.listeners.add(listener)
      return () => { source.listeners.delete(listener) }
    },
  }
  return source
}

function validateContribution(
  descriptor: RuntimeSessionSourceDescriptor,
  contribution: RuntimeSessionSourceContribution,
): void {
  rejectUndeclared('hook', descriptor.hooks, contribution.hooks)
  rejectUndeclared('keyed hook', descriptor.keyedHooks, contribution.keyedHooks)
  rejectUndeclared('prop', descriptor.props, contribution.props)
}

function rejectUndeclared(
  kind: string,
  declared: readonly string[] | undefined,
  values: Readonly<Record<string, unknown>> | undefined,
): void {
  for (const name of Object.keys(values ?? {})) {
    if (!(declared ?? []).includes(name)) {
      throw new Error(`uiSession.provide: undeclared ${kind} '${name}'`)
    }
  }
}

function copyDeclared<T>(
  kind: StandardMemberKind,
  target: Record<string, T>,
  declared: readonly string[] | undefined,
  values: Readonly<Record<string, T>> | undefined,
  finalProps: Set<string>,
): void {
  for (const name of declared ?? []) {
    claimStandardProp(kind, name, finalProps)
    const value = values?.[name]
    if (value === undefined) throw new Error(`uiSession.provide: missing ${kind} '${name}'`)
    target[name] = value
  }
}

function declareAbsent(
  kind: StandardMemberKind,
  target: Record<string, undefined>,
  declared: readonly string[] | undefined,
  finalProps: Set<string>,
): void {
  for (const name of declared ?? []) {
    claimStandardProp(kind, name, finalProps)
    target[name] = undefined
  }
}

function claimStandardProp(kind: StandardMemberKind, name: string, finalProps: Set<string>): void {
  const propName = kind === 'prop' ? name : standardHookPropName(name)
  if (finalProps.has(propName)) {
    throw new Error(`uiSession.provide: duplicate ${kind} '${name}' at prop '${propName}'`)
  }
  finalProps.add(propName)
}

/** Required Controller and renderer services. */
export const inject = ['sessions', 'slots', 'remote']

/**
 * Install the Session root source and scoped adapter.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: Context): void {
  const service = new UiSession(ctx, ctx.sessions)
  ctx.slots.provideRoot({
    hooks: {
      sessions: ctx.sessions.list,
      sessionStatus: service.sessionStatus,
    },
    keyedHooks: {
      sessionRetainInfo: key => ctx.sessions.retainInfo(key as SessionId),
    },
  } satisfies RootStandardSourceContribution)
  ctx.slots.installScope('session', service.adapter)
  installCrossSurfaceSelection(ctx)
}

// ─────────────────────────────────────────────────────────────────────────────
//
// 动因：FP 与主卡是两个文档 = 两个 DSH 客户端实例，选中状态是实例本地的，天然不同步。
//   两个面都参与，而且是对称的：本地选中变化 → 写壳页共享状态；共享状态变化 → 跟随。
//   于是 FP 点会话主卡跟着切，主卡切工作区/新建会话后 FP 也跟着走。
//   不打架靠两条：
//     · 意见带写入时刻 at：只采纳比自己动手更新的。旧的是对方上次留下的陈述，不是指令；
//     · 自己请求的那次导航落地时打 pendingApply 标记：那一刻的列表变化既不记时刻也不回宣告——
//       这是防广播风暴的那一刀（没它两面会互相回声）。
//   另有一条更根本的：期望的目标（钉住的 sid / 共用的当前选中）是**这一面的不动点**，
//   列表每有变动都对一次，被挪开了就再请一次。DSH 客户端自己会把**上次打开的会话**
//   （localStorage 的 dsh.sessions.current）恢复成主视图保留，那是它本地的记忆，与我们的
//   期望目标无关；它可能落在钉住那次导航之前，也可能导航当时目标还不在列表里而失败——
//   只对「共享状态变化」和「导航面到场」这两个时机跟一次，面就停在那一段恢复出来的会话上。
//   settings / standalone 不参与。
// 恢复落地的第一跳不算用户动作（只记 seen，随后与共享状态对一次），否则重载任一面都会
// 把它自己恢复出来的选中当成新指令宣告出去，把对方拉回去。
// 启动握手：不靠“广播宣告”，靠**读快照**——载体（App 全局存储）始终有当前值，
// 没有“接收端晚于发射端启动就错过宣告”的时序窗口。
//
// 会话选中在服务层没有状态：ISessions 既不持有「当前选中」，也不提供选中入口。
//   选中表达为主视图（ui-workspace）对某一段会话的 mainView 保留，导航归视图所有者：
//   ctx.uiWorkspace.openSession(target) 同步替换那份保留。因此本插件读写的都是同一份事实：
//   读 = 本地列表里 retainedBy.mainView > 0 的那一段；写 = 请本面所属文档的视图所有者导航。
//   只读会话流面钉住的 sid 走同一条入口。
//   导航面不是 apply 时取一次就完了：本插件在装配次序上先于 ui-workspace（装配清单里 ui-session
//   排在 ui-workspace 之前，两者之间没有依赖边），apply 那一刻它还不存在，所以用动态注入等它到场。
// ─────────────────────────────────────────────────────────────────────────────

/** 壳页桥面里本插件用到的部分（仅有用的字段，缺失即不参与）。 */
interface SurfaceSelectionBridge {
  readonly role?: string
  readSelection?(): Promise<{ sessionId: string | null; at?: number }>
  writeSelection?(sessionId: string | null): Promise<void>
  onSelectionChanged?(listener: () => void): () => void
  /** 只读会话流面：钉住的一段会话（未钉住时 null，表示跟随共用选中）。 */
  readPinnedSession?(): Promise<string | null>
}

function selectionBridge(): SurfaceSelectionBridge | undefined {
  const host = (globalThis as { __DSHANA__?: unknown }).__DSHANA__
  if (host === null || typeof host !== 'object') return undefined
  return host as SurfaceSelectionBridge
}

/**
 * 本地「当前选中」：被主视图保留的那一段会话。
 * @param list - Session 列表源。
 * @returns 会话身份；没有任何一段被主视图保留时为 null。
 */
function mainSessionId(list: { getSnapshot(): SessionListState }): SessionId | null {
  const found = Object.values(list.getSnapshot().byId)
    .find((row) => (row.retainedBy.mainView ?? 0) > 0)
  return found?.id ?? null
}

/** 安装跨面会话选中同步（角色不符 / 桥缺失时静默不参与）。 */
function installCrossSurfaceSelection(ctx: Context): void {
  const bridge = selectionBridge()
  if (bridge === undefined) return
  const role = bridge.role
  // 只读会话流面只读不写：钉住时跳开共用选中，未钉住时跟随。
  const readOnly = role === 'stream'
  if (role !== 'navigation' && role !== 'workspace' && !readOnly) return
  const read = bridge.readSelection
  const write = bridge.writeSelection
  const onChanged = bridge.onSelectionChanged
  if (read === undefined || write === undefined || onChanged === undefined) return
  const readPinned = readOnly ? bridge.readPinnedSession : undefined
  const list = ctx.sessions.list
  const snap0 = list.getSnapshot()
  let generation = 0
  let pendingApply: SessionId | null | undefined
  let localAt = 0
  let seen = mainSessionId(list)
  // 本面所属文档的视图所有者导航面；ui-workspace 到场前缺席（见文件头那一段）。
  let navigate: UiWorkspace | undefined
  let warnedAbsentNavigator = false
  // 面上线时列表已就绪 ⇒ 恢复早已落地，往后的选中变化都算用户动作。
  let settled = snap0.phase === 'ready'

  /** 共用的当前选中（带它的写入时刻；没有就报 null 与 0）。 */
  const sharedSelection = (): Promise<{ id: string | null; at: number }> =>
    read().then((next) => ({
      id: next?.sessionId ?? null,
      at: typeof next?.at === 'number' ? next.at : 0,
    }))

  /** 本次该显示哪一段：钉住的 sid 优先，否则共用的当前选中。 */
  const desired = async (): Promise<{ id: string | null; at: number }> => {
    if (readPinned === undefined) return sharedSelection()
    const sid = await readPinned()
    // 没钉住（直接开页、不带 sid）= 跟随共用选中。这里若给 MAX_SAFE_INTEGER，
    // 这一面就被钉死在「没有会话」上：applyRemote 随后调用 clear()。
    if (sid === null) return sharedSelection()
    return { id: sid, at: Number.MAX_SAFE_INTEGER }
  }

  const applyRemote = (): void => {
    const request = ++generation
    void desired().then((next) => {
      if (request !== generation) return
      const id = next.id
      const at = next.at
      if (at <= localAt) return
      if (id === mainSessionId(list)) return
      // 对方此刻没有意见（无选中）不动本地：视图所有者没有「清空」入口，
      // 而空值只表示对方那一面此刻没有可宣告的选中。
      if (id === null) return
      if (navigate === undefined) {
        // 导航面还没到场：动态注入的回调会在它到位时重走本函数，这里留一句可查的痕。
        if (!warnedAbsentNavigator) {
          warnedAbsentNavigator = true
          console.warn('[dshana/ui-session] 本面还没有导航面（uiWorkspace），跨面选中暂不跟随。')
        }
        return
      }
      const target = SessionId(id)
      pendingApply = target
      try {
        navigate.openSession(target)
      } catch (error: unknown) {
        // 目标会话可能已不存在：保持本地选中。
        pendingApply = undefined
        console.warn('[dshana/ui-session] 跨面导航没能发起。', error)
      }
    }, () => { /* 读失败保持本地 */ })
  }

  // 导航面在装配次序上晚于本插件：动态注入等它到场，进场即补一次（启动握手那次导航可能早于它）。
  ctx.inject(['uiWorkspace'], (scope) => {
    const service = (scope as unknown as { uiWorkspace?: UiWorkspace }).uiWorkspace
    navigate = service !== undefined && typeof service.openSession === 'function' ? service : undefined
    if (navigate !== undefined) applyRemote()
    return () => { navigate = undefined }
  })

  ctx.effect(() => {
    const off = onChanged(applyRemote)
    const offList = list.subscribe(() => {
      const snap = list.getSnapshot()
      const current = mainSessionId(list)
      if (current !== seen) {
        seen = current
        if (snap.phase !== 'ready') return
        if (pendingApply !== undefined) {
          // 自己刚请求的那次导航落地：不记时刻、不回宣告（随后那次对齐会认出目标已在位）。
          // 落地成了别的（请求被更晚的导航取代、目标已不在）：这枚标记作废，按本地变化照常走。
          // 标记不能留在场上：它会把本地之后的每一次变化都吞掉，本面从此不再宣告。
          pendingApply = undefined
        }
        if (!settled) {
          // 恢复落地的第一跳：只记录，随后与共享状态对一次（谁更新谁说了算）。
          settled = true
        } else if (!readOnly && current !== null) {
          // 只读面不宣告本地变化：它只是在看，不该把另一个面的选中拉过来。
          // 本地无选中也不宣告：空值在对面上表示「没有意见」，没有要传达的动作。
          localAt = Date.now()
          void Promise.resolve(write(current)).catch(() => { /* 写失败不回滚本地 */ })
        }
      }
      // 列表每有变动都对一次期望目标。目标还没到列表里、上一次导航失败、或客户端自己恢复了
      // 另一段会话，都在这里被纠回来；目标已在位时 applyRemote 当场返回，不会来回打。
      applyRemote()
    })
    applyRemote()
    return () => {
      off()
      offList()
    }
  }, 'ui-session: cross-surface selection')
}

function sameSessionStatus(left: SessionStatusSnapshot, right: SessionStatusSnapshot): boolean {
  if (left.size !== right.size) return false
  for (const [id, status] of left) {
    const candidate = right.get(id)
    if (candidate === undefined
      || candidate.running !== status.running
      || candidate.pendingInteraction !== status.pendingInteraction
      || candidate.completionUnread !== status.completionUnread) return false
  }
  return true
}

function samePendingInteractions(
  left: ReadonlyMap<SessionId, SessionPendingInteractionBase>,
  right: ReadonlyMap<SessionId, SessionPendingInteractionBase>,
): boolean {
  if (left.size !== right.size) return false
  for (const [sessionId, interaction] of left) {
    if (right.get(sessionId) !== interaction) return false
  }
  return true
}
