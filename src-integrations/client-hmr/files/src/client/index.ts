/** Web SSE transport for page-owned client entry reconciliation and rebuilt code replacement. */
import type { Context } from '@deepseek-ai/cordis'
import type { PluginsEventParseResult } from '../events.ts'
import { EVENTS_ENDPOINT, parsePluginsEventFrame } from '../events.ts'

export type { PluginsEventFrame } from '../events.ts'
export { EVENTS_ENDPOINT } from '../events.ts'

/** Cordis plugin name. */
export const name = 'client-hmr'

/** Required service: the client module system whose entry controller handles received frames. */
export const inject = ['modules']

/**
 * Forward graph snapshots and rebuilds to the page's shared serial controller.
 * @param ctx - Plugin context with the client module system.
 */
export function apply(ctx: Context): void {
  const entries = ctx.modules.entries
  const handle = (frame: Extract<PluginsEventParseResult, { kind: 'frame' }>['frame']): void => {
    const run = frame.type === 'graph'
      ? Promise.resolve().then(() => entries.sync(frame.graph))
      : entries.reload(frame.id, frame.rev)
    void run.catch((error: unknown) => { ctx.logger.error(error) })
  }

  ctx.effect(() => {
    // EventSource 无法被 fetch 型 transport 包装，所以只能把**地址**换到 App 的私有运行时基址
    // （桥的 runtimeUrl）。裸路径会打到宿主源，被凭据闸 403（missing_credential）。
    const bridge = (globalThis as { __DSHANA__?: { runtimeUrl?: (path: string) => string } }).__DSHANA__
    const source = new EventSource(bridge?.runtimeUrl?.(EVENTS_ENDPOINT) ?? EVENTS_ENDPOINT)
    source.addEventListener('message', (event: MessageEvent<string>) => {
      let value: unknown
      try {
        value = JSON.parse(event.data) as unknown
      } catch {
        // Wire boundary: a malformed transport frame is dropped loudly.
        ctx.logger.warn(`client-hmr: unparseable event frame: ${event.data}`)
        return
      }
      const parsed = parsePluginsEventFrame(value)
      if (parsed.kind === 'invalid') {
        ctx.logger.warn(`client-hmr: invalid event frame: ${event.data}`)
      } else if (parsed.kind === 'frame') {
        handle(parsed.frame)
      }
    })
    return () => { source.close() }
  }, 'client-hmr: event source')
}
