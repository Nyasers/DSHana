/** Composes viewport operations, reading policy, and history navigation for Chat. */
import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { useChatNavigation, type ChatNavigation, type ChatNavigationInput } from './use-chat-navigation.ts'
import { useChatReading, type ChatReadingState } from './use-chat-reading.ts'
import { useChatViewport, type ViewportScroll } from './use-chat-viewport.ts'

// DSHana delta：滚到顶自动续页的触发距离。阅读位离顶 ≤ 此值即认为读者在请求更早一页。
const LOAD_OLDER_TOP_PX = 32

/** Committed content and Session operations used to reconcile scroll ownership. */
export interface ChatScrollInput extends ChatNavigationInput {
  readonly chatScroll: ChatViewSlotProps['chatScroll']
  readonly ready: boolean
  readonly order: readonly string[]
  readonly lastKey: string | null
  readonly lastIsUser: boolean
  readonly steeringId: string | null
  readonly submissionId: string | null
  readonly running: boolean
  readonly loadedTurns: ReturnType<ChatSnapshot['navigation']['items']>
}

interface ChatScrollState extends ChatReadingState {
  readonly listRef: RefObject<HTMLDivElement>
  readonly columnRef: RefObject<HTMLDivElement>
  readonly busyTurn: number | null
  readonly navigateToTurn: ChatNavigation['navigateToTurn']
  readonly loadEarlier: ChatNavigation['loadEarlier']
  readonly returnToBottom: () => void
}

/**
 * Coordinate scroll policy after Chat content commits.
 * New submitted input supersedes pending reader sampling.
 * @param input - current Chat content, scroll memory, and history operations.
 * @returns element refs, visible reading state, and navigation callbacks.
 */
export function useChatScroll(input: ChatScrollInput): ChatScrollState {
  const {
    ready, order, firstSeq, lastKey, lastIsUser, steeringId, submissionId, running,
    loadedTurns, chatScroll, hasMore, loadingOlder, loadOlder, loadThrough,
  } = input
  const { viewport, listRef, columnRef } = useChatViewport()
  const { reading, state } = useChatReading(viewport, chatScroll, loadedTurns.at(-1)?.turn ?? null)
  const navigationInput = useMemo(() => ({
    firstSeq, loadingOlder, hasMore, loadOlder, loadThrough,
  }), [firstSeq, loadingOlder, hasMore, loadOlder, loadThrough])
  const { navigation, busyTurn } = useChatNavigation(viewport, reading, navigationInput)
  const content = useRef<{ input: ChatScrollInput; applied: ChatScrollInput | null; opened: boolean }>({
    input, applied: null, opened: false,
  })
  // DSHana delta：滚动监听只在装配时接一次，而续页的守卫要读最新的 hasMore / loadingOlder。
  const latestInput = useRef(input)
  latestInput.current = input

  const processContent = useCallback(() => {
    const current = content.current.input
    const previous = content.current.applied
    const ownInput = (current.lastIsUser && current.lastKey !== previous?.lastKey)
      || (current.steeringId !== null && current.steeringId !== previous?.steeringId
        && current.steeringId !== previous?.submissionId)
      || (current.submissionId !== null && current.submissionId !== previous?.submissionId
        && current.submissionId !== previous?.steeringId)
    if (reading.pending && !ownInput) return
    content.current.applied = current
    if (current.ready && !content.current.opened) {
      content.current.opened = true
      navigation.reset()
      reading.restore()
      return
    }
    if (ownInput) {
      navigation.cancel()
      reading.followTail()
      return
    }
    if (navigation.contentCommitted()) {
      navigation.reconcile()
      return
    }
    const tipChanged = previous === null || current.ready !== previous.ready
      || current.firstSeq !== previous.firstSeq || current.lastKey !== previous.lastKey
      || current.order.length !== previous.order.length || current.running !== previous.running
      || current.steeringId !== previous.steeringId || current.submissionId !== previous.submissionId
    if (tipChanged && reading.followingTail) {
      navigation.cancel()
      reading.followTail()
    } else navigation.reconcile()
  }, [reading, navigation])

  useLayoutEffect(() => {
    // DSHana delta：读者自己滚到顶就续页（上游只给了「加载更早」按钮，长会话回翻要一直去够它）。
    // 走与按钮同一个入口 navigation.loadEarlier：锚定补偿由 viewport 负责，续下的页不会把阅读位顶跑。
    // 三个安全前提：
    //   · movedByReader：只有读者输入算数，续页后的程序化补偿不连轴触发；
    //   · 距离 ≤ LOAD_OLDER_TOP_PX：贴顶才算，正常阅读不误触；
    //   · hasMore && !loadingOlder：没有更早的页或已在加载时不重复发起。
    const onViewportScroll = (scroll: ViewportScroll): void => {
      reading.onScroll(scroll)
      const latest = latestInput.current
      if (scroll.movedByReader && scroll.metrics.top <= LOAD_OLDER_TOP_PX
        && latest.hasMore && !latest.loadingOlder) navigation.loadEarlier()
    }
    const disconnectViewport = viewport.connect({
      scroll: onViewportScroll,
      scrollEnd: () => {
        reading.onScrollEnd()
        navigation.readerSettled()
      },
      interact: () => { navigation.cancel() },
      resize: () => {
        if (!navigation.contentCommitted()) reading.onResize()
        navigation.reconcile()
      },
    })
    const disconnectReading = reading.connect((sample) => {
      navigation.readerSampled(sample)
      processContent()
    })
    return () => {
      disconnectViewport()
      disconnectReading()
      content.current.opened = false
      content.current.applied = null
    }
  }, [viewport, reading, navigation, processContent])

  useLayoutEffect(() => {
    const previous = content.current.input
    content.current.input = {
      ready, order, lastKey, lastIsUser, steeringId, submissionId, running, loadedTurns, chatScroll, ...navigationInput,
    }
    viewport.updateTurns(loadedTurns)
    const layoutChanged = previous.order !== order || previous.ready !== ready
    if (layoutChanged) viewport.invalidate()
    processContent()
    if (layoutChanged) reading.refreshActiveTurn()
  }, [
    viewport, reading, processContent, navigationInput, ready, order, lastKey, lastIsUser,
    steeringId, submissionId, running, loadedTurns, chatScroll,
  ])

  const returnToBottom = useCallback(() => {
    navigation.cancel()
    reading.followTail()
  }, [navigation, reading])

  return {
    listRef, columnRef, ...state, busyTurn,
    navigateToTurn: navigation.navigateToTurn,
    loadEarlier: navigation.loadEarlier,
    returnToBottom,
  }
}
