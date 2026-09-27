import { useCallback, useEffect, type WheelEvent } from "react";
import { type ConversationScrollState, type TaskRecord } from "../models";
import {
  appendConversationWindow,
  isConversationAtBottom,
  latestConversationWindow,
  prependConversationWindow,
  windowContainingTurn,
  offsetWithinScrollContainer,
  scrollContainerToElementTop,
  type ConversationWindow,
} from "../conversation-window";
import {
  ConversationScrollController,
  nestedWheelScroller,
} from "../conversation-scroll-controller";
import { errorMessage } from "../lib/format";
import {
  prependPageMetadata,
  prependUniqueItems,
  TASK_MESSAGE_PAGE_SIZE,
  windowAfterPrepend,
} from "../task-history-paging";
import { isTaskViewCurrent } from "../task-status";
import type { AgentActivity, ChatMessage } from "../types";
import { type TaskPagingState } from "./app-utils";

type ConversationViewportBindings = {
  conversationRef: React.RefObject<HTMLElement | null>;
  autoFollowRef: React.RefObject<boolean>;
  setTurnRailOverflow: React.Dispatch<
    React.SetStateAction<{
      up: boolean;
      down: boolean;
    }>
  >;
  conversationTurns: import("../conversation-window").ConversationTurn[];
  activeConversationTurnRef: React.RefObject<string | undefined>;
  activeTaskId: string;
  bottomLayoutFrameRef: React.RefObject<number | undefined>;
  pendingScrollRestoreRef: React.RefObject<
    | {
        taskId: string;
        state: ConversationScrollState;
      }
    | undefined
  >;
  conversationScrollControllerRef: React.RefObject<ConversationScrollController>;
  displayedTaskIdRef: React.RefObject<string>;
  scrollStateByTaskRef: React.RefObject<Map<string, ConversationScrollState>>;
  messages: ChatMessage[];
  scrollFrameRef: React.RefObject<number | undefined>;
  bottomSettleTimerRef: React.RefObject<number | undefined>;
  pendingLatestScrollRef: React.RefObject<ScrollBehavior | undefined>;
  turnLayoutFrameRef: React.RefObject<number | undefined>;
  persistTaskDrafts: (value?: string) => void;
  turnButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
  turnRailRef: React.RefObject<HTMLElement | null>;
  turnPositionsRef: React.RefObject<
    {
      id: string;
      top: number;
    }[]
  >;
  turnRefs: React.RefObject<Map<string, HTMLDivElement>>;
  windowScrollAnchorRef: React.RefObject<
    | {
        turnId: string;
        viewportOffset: number;
      }
    | undefined
  >;
  taskPagingRef: React.RefObject<
    Map<
      string,
      {
        messages: import("../types").TaskItemPageMetadata;
        activities: import("../types").TaskItemPageMetadata;
      }
    >
  >;
  loadingOlderTurnsRef: React.RefObject<boolean>;
  setHistoryLoadingTaskId: React.Dispatch<
    React.SetStateAction<string | undefined>
  >;
  tasksRef: React.RefObject<TaskRecord[]>;
  rememberTaskPaging: (taskId: string, paging: TaskPagingState) => void;
  setTasks: React.Dispatch<React.SetStateAction<TaskRecord[]>>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setActivities: React.Dispatch<React.SetStateAction<AgentActivity[]>>;
  conversationPageSize: number;
  setVisibleTurnWindow: React.Dispatch<
    React.SetStateAction<ConversationWindow>
  >;
  activeTaskIdRef: React.RefObject<string>;
  setContextError: React.Dispatch<React.SetStateAction<string>>;
  scrollTargetRef: React.RefObject<HTMLElement | null>;
  programmaticScrollRef: React.RefObject<boolean>;
  visibleTurnWindow: ConversationWindow;
  conversationSearchOpen: boolean;
  hasNewerMessages: boolean;
  setShowScrollToBottom: React.Dispatch<React.SetStateAction<boolean>>;
  setScrollingToBottom: React.Dispatch<React.SetStateAction<boolean>>;
  bottomIndicatorUntilRef: React.RefObject<number>;
  bottomSettlePassesRef: React.RefObject<number>;
  bottomSettleDeadlineRef: React.RefObject<number>;
  endRef: React.RefObject<HTMLDivElement | null>;
  pendingTurnTargetRef: React.RefObject<string | undefined>;
};

export function useConversationViewport({
  conversationRef,
  autoFollowRef,
  setTurnRailOverflow,
  conversationTurns,
  activeConversationTurnRef,
  activeTaskId,
  bottomLayoutFrameRef,
  pendingScrollRestoreRef,
  conversationScrollControllerRef,
  displayedTaskIdRef,
  scrollStateByTaskRef,
  messages,
  scrollFrameRef,
  bottomSettleTimerRef,
  pendingLatestScrollRef,
  turnLayoutFrameRef,
  persistTaskDrafts,
  turnButtonRefs,
  turnRailRef,
  turnPositionsRef,
  turnRefs,
  windowScrollAnchorRef,
  taskPagingRef,
  loadingOlderTurnsRef,
  setHistoryLoadingTaskId,
  tasksRef,
  rememberTaskPaging,
  setTasks,
  setMessages,
  setActivities,
  conversationPageSize,
  setVisibleTurnWindow,
  activeTaskIdRef,
  setContextError,
  scrollTargetRef,
  programmaticScrollRef,
  visibleTurnWindow,
  conversationSearchOpen,
  hasNewerMessages,
  setShowScrollToBottom,
  setScrollingToBottom,
  bottomIndicatorUntilRef,
  bottomSettlePassesRef,
  bottomSettleDeadlineRef,
  endRef,
  pendingTurnTargetRef,
}: ConversationViewportBindings) {
  const updateTurnRailOverflow = useCallback(() => {
    // Cue visibility follows the conversation viewport, not the tick strip:
    // top → down only, middle → both, bottom → up only.
    // On first open, scrollTop is still 0 before scrollToLatest settles while
    // autoFollow is already true — trust follow-bottom so we do not flash the
    // down cue (task switches restore scroll first, so they already looked fine).
    const conversation = conversationRef.current;
    if (!conversation) return;
    const { scrollTop, clientHeight, scrollHeight } = conversation;
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    const followingBottom = autoFollowRef.current;
    const fitsWithoutScroll = maxScroll <= 4;
    const atBottom =
      fitsWithoutScroll || followingBottom || scrollTop >= maxScroll - 4;
    const atTop = fitsWithoutScroll ? true : !followingBottom && scrollTop <= 4;
    const next = {
      up: !atTop,
      down: !atBottom,
    };
    setTurnRailOverflow((current) =>
      current.up === next.up && current.down === next.down ? current : next,
    );
  }, []);
  useEffect(() => {
    requestAnimationFrame(updateTurnRailOverflow);
  }, [conversationTurns.length, updateTurnRailOverflow]);
  useEffect(() => {
    const ids = new Set(conversationTurns.map((turn) => turn.id));
    if (
      !activeConversationTurnRef.current ||
      !ids.has(activeConversationTurnRef.current)
    )
      setActiveConversationTurn(conversationTurns[0]?.id);
    refreshTurnPositions();
  }, [activeTaskId, conversationTurns.length]);
  useEffect(() => {
    const conversation = conversationRef.current;
    const messageList = conversation?.querySelector(".message-list");
    if (!messageList || typeof ResizeObserver === "undefined") return;
    const queueBottomFollow = () => {
      if (bottomLayoutFrameRef.current) return;
      bottomLayoutFrameRef.current = requestAnimationFrame(() => {
        bottomLayoutFrameRef.current = undefined;
        if (
          !autoFollowRef.current &&
          !pendingScrollRestoreRef.current?.state.atBottom
        )
          return;
        const current = conversationRef.current;
        if (
          !current ||
          current !== conversation ||
          (!autoFollowRef.current &&
            !pendingScrollRestoreRef.current?.state.atBottom)
        )
          return;
        // Align in the same paint cycle as the content resize. Delaying this
        // independently made the viewport catch up in visible 50 ms jumps.
        conversationScrollControllerRef.current.markProgrammatic();
        current.scrollTop = current.scrollHeight;
        const taskId = displayedTaskIdRef.current;
        if (taskId)
          scrollStateByTaskRef.current.set(taskId, {
            top: current.scrollHeight,
            atBottom: true,
          });
      });
    };
    const observer = new ResizeObserver(() => {
      const pending = pendingScrollRestoreRef.current;
      if (!autoFollowRef.current && !pending?.state.atBottom) return;
      queueBottomFollow();
    });
    observer.observe(messageList);
    return () => {
      observer.disconnect();
      if (bottomLayoutFrameRef.current) {
        cancelAnimationFrame(bottomLayoutFrameRef.current);
        bottomLayoutFrameRef.current = undefined;
      }
    };
  }, [activeTaskId, messages.length, conversationTurns.length]);
  useEffect(
    () => () => {
      if (scrollFrameRef.current) cancelAnimationFrame(scrollFrameRef.current);
      if (bottomLayoutFrameRef.current)
        cancelAnimationFrame(bottomLayoutFrameRef.current);
      if (bottomSettleTimerRef.current)
        window.clearTimeout(bottomSettleTimerRef.current);
      pendingLatestScrollRef.current = undefined;
      if (turnLayoutFrameRef.current)
        cancelAnimationFrame(turnLayoutFrameRef.current);
      persistTaskDrafts();
    },
    [persistTaskDrafts],
  );

  function setActiveConversationTurn(id?: string) {
    if (activeConversationTurnRef.current === id) return;
    if (activeConversationTurnRef.current)
      turnButtonRefs.current
        .get(activeConversationTurnRef.current)
        ?.classList.remove("active");
    activeConversationTurnRef.current = id;
    if (id) {
      const button = turnButtonRefs.current.get(id);
      button?.classList.add("active");
      if (!button) {
        const index = conversationTurns.findIndex((turn) => turn.id === id);
        const rail = turnRailRef.current;
        if (index >= 0 && rail)
          rail.scrollTop = Math.max(0, index * 28 - rail.clientHeight / 2);
      }
      const rail = button?.parentElement;
      if (button && rail) {
        const top = button.offsetTop;
        const bottom = top + button.offsetHeight;
        if (top < rail.scrollTop + 12) rail.scrollTop = Math.max(0, top - 12);
        else if (bottom > rail.scrollTop + rail.clientHeight - 12)
          rail.scrollTop = bottom - rail.clientHeight + 12;
      }
    }
  }

  function updateActiveTurn(container: HTMLElement) {
    const positions = turnPositionsRef.current;
    if (!positions.length) return setActiveConversationTurn(undefined);
    const threshold =
      container.scrollTop + Math.min(180, container.clientHeight * 0.3);
    let low = 0;
    let high = positions.length - 1;
    let match = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (positions[middle].top <= threshold) {
        match = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    setActiveConversationTurn(positions[match].id);
  }

  function refreshTurnPositions() {
    if (turnLayoutFrameRef.current)
      cancelAnimationFrame(turnLayoutFrameRef.current);
    turnLayoutFrameRef.current = requestAnimationFrame(() => {
      turnLayoutFrameRef.current = undefined;
      const conversation = conversationRef.current;
      turnPositionsRef.current = [...turnRefs.current.entries()]
        .filter(([, element]) => element.isConnected)
        .map(([id, element]) => ({
          id,
          top: conversation
            ? offsetWithinScrollContainer(conversation, element)
            : element.offsetTop,
        }))
        .sort((a, b) => a.top - b.top);
      if (conversation) updateActiveTurn(conversation);
    });
  }

  function preserveWindowAnchor(turnIndex: number) {
    const turn = conversationTurns[turnIndex];
    const element = turn ? turnRefs.current.get(turn.id) : undefined;
    if (!turn || !element) return;
    windowScrollAnchorRef.current = {
      turnId: turn.id,
      viewportOffset: element.getBoundingClientRect().top,
    };
  }

  async function loadOlderTaskHistory(
    taskId: string,
    currentWindow: ConversationWindow,
  ) {
    const state = window.kcode?.state;
    const initialPaging = taskPagingRef.current.get(taskId);
    const messageCursor = initialPaging?.messages.oldestCursor;
    if (!state || !initialPaging?.messages.hasMoreBefore || !messageCursor) {
      loadingOlderTurnsRef.current = false;
      windowScrollAnchorRef.current = undefined;
      setHistoryLoadingTaskId((current) =>
        current === taskId ? undefined : current,
      );
      return;
    }

    try {
      const messagePage = await state.taskMessagePage(taskId, {
        before: messageCursor,
        limit: TASK_MESSAGE_PAGE_SIZE,
      });
      const requestIds = messagePage.items
        .map((message) => message.id)
        .filter((messageId) => messageId.startsWith("assistant:"))
        .map((messageId) => messageId.slice("assistant:".length));
      const olderActivities = await state.taskActivitiesForRequests(
        taskId,
        requestIds,
      );

      const latestTask = tasksRef.current.find((task) => task.id === taskId);
      if (!latestTask) {
        loadingOlderTurnsRef.current = false;
        windowScrollAnchorRef.current = undefined;
        return;
      }
      const nextMessages = prependUniqueItems(
        messagePage.items,
        latestTask.messages,
      );
      const nextActivities = prependUniqueItems(
        olderActivities,
        latestTask.activities,
      );
      const latestPaging = taskPagingRef.current.get(taskId) ?? initialPaging;
      rememberTaskPaging(taskId, {
        messages: prependPageMetadata(latestPaging.messages, messagePage),
        activities: {
          oldestCursor: nextActivities[0]?.id,
          newestCursor: nextActivities.at(-1)?.id,
          hasMoreBefore: messagePage.hasMoreBefore,
          hasMoreAfter: false,
        },
      });
      const nextTask = {
        ...latestTask,
        messages: nextMessages,
        activities: nextActivities,
      };
      const nextTasks = tasksRef.current.map((task) =>
        task.id === taskId ? nextTask : task,
      );
      tasksRef.current = nextTasks;
      setTasks(nextTasks);

      const knownMessageIds = new Set(
        latestTask.messages.map((message) => message.id),
      );
      const addedTurns = messagePage.items.filter(
        (message) =>
          message.role === "user" && !knownMessageIds.has(message.id),
      ).length;
      if (
        isTaskViewCurrent(
          activeTaskIdRef.current,
          displayedTaskIdRef.current,
          taskId,
        )
      ) {
        setMessages(nextMessages);
        setActivities(nextActivities);
        if (addedTurns > 0) {
          const totalTurns = nextMessages.reduce(
            (count, message) => count + (message.role === "user" ? 1 : 0),
            0,
          );
          setVisibleTurnWindow(
            windowAfterPrepend(
              currentWindow,
              addedTurns,
              totalTurns,
              conversationPageSize,
            ),
          );
          return;
        }
      }
      loadingOlderTurnsRef.current = false;
      windowScrollAnchorRef.current = undefined;
    } catch (error) {
      loadingOlderTurnsRef.current = false;
      windowScrollAnchorRef.current = undefined;
      setContextError(`加载历史记录失败：${errorMessage(error)}`);
    } finally {
      setHistoryLoadingTaskId((current) =>
        current === taskId ? undefined : current,
      );
    }
  }

  function handleConversationScroll(container: HTMLElement) {
    scrollTargetRef.current = container;
    // Programmatic bottom alignment also emits scroll events. Do not treat the
    // transient intermediate position as the user scrolling away from bottom.
    if (programmaticScrollRef.current) return;
    if (scrollFrameRef.current) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = undefined;
      const target = scrollTargetRef.current;
      if (!target) return;
      // Read scroll geometry once per animation frame. Reading it in every
      // native scroll event forces repeated synchronous layout on long output.
      const scrollTop = target.scrollTop;
      const clientHeight = target.clientHeight;
      const scrollHeight = target.scrollHeight;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      if (
        !conversationSearchOpen &&
        scrollTop <= 48 &&
        !loadingOlderTurnsRef.current
      ) {
        if (visibleTurnWindow.start > 0) {
          loadingOlderTurnsRef.current = true;
          preserveWindowAnchor(visibleTurnWindow.start);
          setVisibleTurnWindow((current) =>
            prependConversationWindow(current, conversationPageSize),
          );
          return;
        }
        if (taskPagingRef.current.get(activeTaskId)?.messages.hasMoreBefore) {
          loadingOlderTurnsRef.current = true;
          setHistoryLoadingTaskId(activeTaskId);
          preserveWindowAnchor(0);
          void loadOlderTaskHistory(activeTaskId, visibleTurnWindow);
          return;
        }
      }
      if (
        !conversationSearchOpen &&
        distanceFromBottom <= 48 &&
        hasNewerMessages &&
        !loadingOlderTurnsRef.current
      ) {
        loadingOlderTurnsRef.current = true;
        preserveWindowAnchor(
          Math.max(visibleTurnWindow.start, visibleTurnWindow.end - 1),
        );
        setVisibleTurnWindow((current) =>
          appendConversationWindow(
            current,
            conversationTurns.length,
            conversationPageSize,
          ),
        );
        return;
      }
      const atBottom = isConversationAtBottom(
        { scrollTop, clientHeight, scrollHeight },
        hasNewerMessages,
      );
      const scrollObservation = conversationScrollControllerRef.current.observe(
        { scrollTop, clientHeight, scrollHeight },
        hasNewerMessages,
      );
      const shouldFollow = atBottom && !scrollObservation.userScrolledAway;
      const taskId = displayedTaskIdRef.current;
      if (taskId)
        scrollStateByTaskRef.current.set(taskId, {
          top: scrollTop,
          atBottom: shouldFollow,
        });
      if (autoFollowRef.current !== shouldFollow) {
        autoFollowRef.current = shouldFollow;
        if (!shouldFollow) refreshTurnPositions();
      }
      setShowScrollToBottom(
        !shouldFollow || scrollObservation.showScrollButton,
      );
      updateActiveTurn(target);
      updateTurnRailOverflow();
    });
  }

  function scrollToLatest(
    behavior: ScrollBehavior = "auto",
    showProgress = false,
  ) {
    const conversation = conversationRef.current;
    if (!conversation) {
      setScrollingToBottom(false);
      return;
    }
    if (scrollFrameRef.current) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = undefined;
    }
    scrollTargetRef.current = null;
    if (showProgress) {
      bottomIndicatorUntilRef.current = performance.now() + 450;
      setScrollingToBottom(true);
    }
    conversationScrollControllerRef.current.markProgrammatic();
    const latest = latestConversationWindow(
      conversationTurns.length,
      conversationPageSize,
    );
    const alreadyShowingLatest =
      visibleTurnWindow.start === latest.start &&
      visibleTurnWindow.end === latest.end;
    if (!alreadyShowingLatest) {
      pendingLatestScrollRef.current = behavior;
      setVisibleTurnWindow(latest);
    }
    autoFollowRef.current = true;
    programmaticScrollRef.current = true;
    setShowScrollToBottom(false);
    if (bottomSettleTimerRef.current)
      window.clearTimeout(bottomSettleTimerRef.current);
    bottomSettlePassesRef.current = 0;
    bottomSettleDeadlineRef.current = performance.now() + 3_000;

    const finishBottomScroll = () => {
      bottomSettleTimerRef.current = undefined;
      bottomIndicatorUntilRef.current = 0;
      bottomSettlePassesRef.current = 0;
      programmaticScrollRef.current = false;
      setScrollingToBottom(false);
      setShowScrollToBottom(false);
      updateTurnRailOverflow();
    };

    const alignToLatest = () => {
      const current = conversationRef.current;
      if (!current || !autoFollowRef.current) {
        programmaticScrollRef.current = false;
        bottomSettleTimerRef.current = undefined;
        bottomIndicatorUntilRef.current = 0;
        bottomSettlePassesRef.current = 0;
        setScrollingToBottom(false);
        return;
      }
      current.scrollTop = current.scrollHeight;
      conversationScrollControllerRef.current.markProgrammatic();
      const taskId = displayedTaskIdRef.current;
      if (taskId)
        scrollStateByTaskRef.current.set(taskId, {
          top: current.scrollHeight,
          atBottom: true,
        });
      const latestTurnId = conversationTurns.at(-1)?.id;
      const latestTurn = latestTurnId
        ? turnRefs.current.get(latestTurnId)
        : undefined;
      const latestMounted = !latestTurnId || Boolean(latestTurn?.isConnected);
      const distanceFromBottom =
        current.scrollHeight - current.scrollTop - current.clientHeight;
      bottomSettlePassesRef.current =
        latestMounted && distanceFromBottom <= 1
          ? bottomSettlePassesRef.current + 1
          : 0;
      if (
        bottomSettlePassesRef.current >= 4 &&
        performance.now() >= bottomIndicatorUntilRef.current
      ) {
        finishBottomScroll();
      } else if (performance.now() < bottomSettleDeadlineRef.current) {
        bottomSettleTimerRef.current = window.setTimeout(alignToLatest, 50);
      } else {
        current.scrollTop = current.scrollHeight;
        finishBottomScroll();
      }
    };

    if (behavior === "smooth")
      endRef.current?.scrollIntoView({ block: "end", behavior });
    alignToLatest();
    if (bottomLayoutFrameRef.current)
      cancelAnimationFrame(bottomLayoutFrameRef.current);
    bottomLayoutFrameRef.current = requestAnimationFrame(() => {
      bottomLayoutFrameRef.current = undefined;
      const current = conversationRef.current;
      if (!current || !autoFollowRef.current) return;
      conversationScrollControllerRef.current.markProgrammatic();
      current.scrollTop = current.scrollHeight;
    });
    setActiveConversationTurn(conversationTurns.at(-1)?.id);
  }

  function interruptBottomSettle(userInitiated = false) {
    if (bottomSettleTimerRef.current) {
      window.clearTimeout(bottomSettleTimerRef.current);
      bottomSettleTimerRef.current = undefined;
    }
    bottomSettleDeadlineRef.current = 0;
    bottomIndicatorUntilRef.current = 0;
    bottomSettlePassesRef.current = 0;
    pendingLatestScrollRef.current = undefined;
    programmaticScrollRef.current = false;
    setScrollingToBottom(false);
    const conversation = conversationRef.current;
    if (conversation) {
      const atBottom =
        !userInitiated &&
        isConversationAtBottom(conversation, hasNewerMessages);
      autoFollowRef.current = atBottom;
      setShowScrollToBottom(!atBottom);
    }
    if (bottomLayoutFrameRef.current) {
      cancelAnimationFrame(bottomLayoutFrameRef.current);
      bottomLayoutFrameRef.current = undefined;
    }
  }

  function handleConversationWheel(event: WheelEvent<HTMLElement>) {
    const container = event.currentTarget;
    const nested = nestedWheelScroller(event.target, container, event.deltaY);
    const bottomGap =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (!nested && event.deltaY > 0 && bottomGap <= 1) return;
    conversationScrollControllerRef.current.markUserIntent();
    interruptBottomSettle(true);
  }

  function scrollToTurn(turnId: string, index: number) {
    const conversation = conversationRef.current;
    if (!conversation) return;
    interruptBottomSettle(true);
    conversationScrollControllerRef.current.markUserIntent();
    autoFollowRef.current = false;
    setShowScrollToBottom(true);
    const element = turnRefs.current.get(turnId);
    // Element missing or detached: expand the paged window, then scroll in layout.
    if (!element || !element.isConnected) {
      pendingTurnTargetRef.current = turnId;
      setVisibleTurnWindow(
        windowContainingTurn(
          index,
          conversationTurns.length,
          conversationPageSize,
        ),
      );
      return;
    }
    scrollContainerToElementTop(conversation, element, 28);
    setActiveConversationTurn(turnId);
    requestAnimationFrame(updateTurnRailOverflow);
    element.classList.remove("turn-scroll-target");
    void element.offsetWidth;
    element.classList.add("turn-scroll-target");
    window.setTimeout(
      () => element.classList.remove("turn-scroll-target"),
      900,
    );
    turnButtonRefs.current.get(turnId)?.scrollIntoView({
      block: "nearest",
      behavior: "auto",
    });
  }
  return {
    updateTurnRailOverflow,
    setActiveConversationTurn,
    updateActiveTurn,
    refreshTurnPositions,
    handleConversationScroll,
    scrollToLatest,
    interruptBottomSettle,
    handleConversationWheel,
    scrollToTurn,
  };
}
