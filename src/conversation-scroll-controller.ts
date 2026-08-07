/**
 * Portions of this state machine are adapted from AionUi's useAutoScroll
 * strategy (Apache-2.0). KCode keeps the implementation local so it can also
 * account for paged conversation windows and nested diff scrollers.
 */

export const SCROLL_PROGRAMMATIC_GUARD_MS = 150;
export const SCROLL_FOLLOW_THRESHOLD_PX = 4;
export const SCROLL_BUTTON_THRESHOLD_PX = 72;

export type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

export type ConversationScrollObservation = {
  bottomGap: number;
  atBottom: boolean;
  showScrollButton: boolean;
  userScrolledAway: boolean;
};

function bottomGap(metrics: ScrollMetrics) {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop);
}

export class ConversationScrollController {
  private lastScrollTop = 0;
  private lastProgrammaticScrollAt = 0;
  private userInputActive = false;
  private userScrolledAway = false;

  markProgrammatic(timestamp = Date.now()) {
    this.lastProgrammaticScrollAt = timestamp;
    this.userInputActive = false;
  }

  markUserIntent() {
    this.userInputActive = true;
  }

  reset(metrics?: ScrollMetrics) {
    this.lastScrollTop = metrics?.scrollTop ?? 0;
    this.lastProgrammaticScrollAt = 0;
    this.userInputActive = false;
    this.userScrolledAway = false;
  }

  observe(
    metrics: ScrollMetrics,
    hasNewerMessages = false,
    timestamp = Date.now(),
  ): ConversationScrollObservation {
    const nextScrollTop = metrics.scrollTop;
    const delta = nextScrollTop - this.lastScrollTop;
    const gap = bottomGap(metrics);
    const atBottom = !hasNewerMessages && gap <= SCROLL_FOLLOW_THRESHOLD_PX;
    const withinButtonThreshold =
      !hasNewerMessages && gap <= SCROLL_BUTTON_THRESHOLD_PX;
    const guarded =
      timestamp - this.lastProgrammaticScrollAt < SCROLL_PROGRAMMATIC_GUARD_MS;

    if (atBottom) {
      this.userScrolledAway = false;
      this.userInputActive = false;
    } else if (
      Math.abs(delta) > 2 &&
      (this.userInputActive || !guarded)
    ) {
      this.userScrolledAway = true;
      this.userInputActive = false;
    }

    this.lastScrollTop = nextScrollTop;
    return {
      bottomGap: gap,
      atBottom,
      showScrollButton: !withinButtonThreshold || this.userScrolledAway,
      userScrolledAway: this.userScrolledAway,
    };
  }

  shouldFollow() {
    return !this.userScrolledAway;
  }
}

function elementCanScrollInDirection(element: HTMLElement, deltaY: number) {
  if (element.scrollHeight <= element.clientHeight + 1) return false;
  const style = window.getComputedStyle(element);
  if (!/(auto|scroll|overlay)/.test(style.overflowY)) return false;
  if (deltaY < 0) return element.scrollTop > 0;
  if (deltaY > 0)
    return element.scrollTop + element.clientHeight < element.scrollHeight - 1;
  return false;
}

/**
 * Returns the nested scroll container that can consume this wheel movement.
 * The caller can leave that container alone and only hand the wheel to the
 * conversation when the nested view has reached its edge.
 */
export function nestedWheelScroller(
  target: EventTarget | null,
  boundary: HTMLElement,
  deltaY: number,
) {
  if (typeof Element === "undefined" || !(target instanceof Element))
    return undefined;
  let element: HTMLElement | null =
    target instanceof HTMLElement ? target : target.parentElement;
  while (element && element !== boundary) {
    if (elementCanScrollInDirection(element, deltaY)) return element;
    element = element.parentElement;
  }
  return undefined;
}

