import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

const POSITION_KEY = "kcode.conversationSearchPosition";
const POSITION_MARGIN = 8;
const MAX_HIGHLIGHT_RANGES = 2_000;

interface SearchPosition {
  x: number;
  y: number;
}

function storedPosition(): SearchPosition | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(POSITION_KEY) || "null");
    if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) return value;
  } catch {
    // Ignore malformed positions from older builds.
  }
  return undefined;
}

interface HighlightValue {}

interface HighlightRegistry {
  set(name: string, highlight: HighlightValue): void;
  delete(name: string): void;
}

interface HighlightConstructor {
  new (...ranges: Range[]): HighlightValue;
}

function highlightApi() {
  const css = CSS as typeof CSS & { highlights?: HighlightRegistry };
  const ctor = window.Highlight as unknown as HighlightConstructor | undefined;
  return css.highlights && ctor
    ? { registry: css.highlights, Highlight: ctor }
    : undefined;
}

function clearHighlights() {
  const api = highlightApi();
  api?.registry.delete("conversation-search");
  api?.registry.delete("conversation-search-current");
}

function findRanges(root: HTMLElement, query: string) {
  const ranges: Range[] = [];
  const needle = query.toLocaleLowerCase();
  if (!needle) return ranges;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest(".conversation-search"))
        return NodeFilter.FILTER_REJECT;
      if (["SCRIPT", "STYLE"].includes(parent.tagName))
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    const lower = text.toLocaleLowerCase();
    let from = 0;
    while (from < lower.length) {
      const index = lower.indexOf(needle, from);
      if (index < 0) break;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + query.length);
      ranges.push(range);
      if (ranges.length >= MAX_HIGHLIGHT_RANGES) return ranges;
      from = index + Math.max(1, query.length);
    }
    node = walker.nextNode();
  }
  return ranges;
}

export function ConversationSearch({
  open,
  containerRef,
  onClose,
  onRevealAll,
  live = false,
}: {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onClose(): void;
  onRevealAll(): void;
  live?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<
    | {
        pointerId: number;
        offsetX: number;
        offsetY: number;
      }
    | undefined
  >(undefined);
  const rangesRef = useRef<Range[]>([]);
  const currentRef = useRef(0);
  const observerRef = useRef<MutationObserver | undefined>(undefined);
  const timerRef = useRef<number | undefined>(undefined);
  const queryRef = useRef("");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState({ current: 0, total: 0 });
  const [position, setPosition] = useState<SearchPosition | undefined>(
    storedPosition,
  );
  const [dragging, setDragging] = useState(false);

  const clampPosition = (candidate: SearchPosition) => {
    const element = searchRef.current;
    const parent = element?.offsetParent as HTMLElement | null;
    if (!element || !parent) return candidate;
    return {
      x: Math.max(
        POSITION_MARGIN,
        Math.min(
          candidate.x,
          parent.clientWidth - element.offsetWidth - POSITION_MARGIN,
        ),
      ),
      y: Math.max(
        POSITION_MARGIN,
        Math.min(
          candidate.y,
          parent.clientHeight - element.offsetHeight - POSITION_MARGIN,
        ),
      ),
    };
  };

  const beginDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const element = searchRef.current;
    const parent = element?.offsetParent as HTMLElement | null;
    if (!element || !parent) return;
    event.preventDefault();
    const elementRect = element.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const current = {
      x: elementRect.left - parentRect.left,
      y: elementRect.top - parentRect.top,
    };
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - elementRect.left,
      offsetY: event.clientY - elementRect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    setPosition(current);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current;
    const element = searchRef.current;
    const parent = element?.offsetParent as HTMLElement | null;
    if (!drag || drag.pointerId !== event.pointerId || !parent) return;
    const parentRect = parent.getBoundingClientRect();
    setPosition(
      clampPosition({
        x: event.clientX - parentRect.left - drag.offsetX,
        y: event.clientY - parentRect.top - drag.offsetY,
      }),
    );
  };

  const endDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    setDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    setPosition((current) => {
      if (!current) return current;
      const next = clampPosition(current);
      localStorage.setItem(POSITION_KEY, JSON.stringify(next));
      return next;
    });
  };

  useLayoutEffect(() => {
    if (!open || !position) return;
    const element = searchRef.current;
    const parent = element?.offsetParent as HTMLElement | null;
    if (!element || !parent) return;
    const keepVisible = () =>
      setPosition((current) => {
        if (!current) return current;
        const next = clampPosition(current);
        localStorage.setItem(POSITION_KEY, JSON.stringify(next));
        return next;
      });
    keepVisible();
    const observer = new ResizeObserver(keepVisible);
    observer.observe(parent);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  const showCurrent = (nextIndex: number) => {
    const api = highlightApi();
    const ranges = rangesRef.current;
    if (!api || !ranges.length) return;
    const index = (nextIndex + ranges.length) % ranges.length;
    currentRef.current = index;
    api.registry.set("conversation-search", new api.Highlight(...ranges));
    api.registry.set(
      "conversation-search-current",
      new api.Highlight(ranges[index]),
    );
    const element = ranges[index].startContainer.parentElement;
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
    setResult({ current: index + 1, total: ranges.length });
  };

  const refresh = () => {
    const root = containerRef.current;
    const api = highlightApi();
    clearHighlights();
    const normalizedQuery = queryRef.current.trim();
    if (!root || !api || !normalizedQuery) {
      rangesRef.current = [];
      currentRef.current = 0;
      setResult({ current: 0, total: 0 });
      return;
    }
    const ranges = findRanges(root, normalizedQuery);
    rangesRef.current = ranges;
    if (!ranges.length) {
      setResult({ current: 0, total: 0 });
      return;
    }
    showCurrent(Math.min(currentRef.current, ranges.length - 1));
  };

  useEffect(() => {
    if (!open) {
      clearHighlights();
      return;
    }
    const style = document.createElement("style");
    style.dataset.conversationSearchHighlights = "true";
    style.textContent = `
      ::highlight(conversation-search) {
        background: color-mix(in srgb, var(--warning) 34%, transparent);
        color: inherit;
      }
      ::highlight(conversation-search-current) {
        background: color-mix(in srgb, var(--accent) 68%, white);
        color: #10131a;
      }
    `;
    document.head.appendChild(style);
    onRevealAll();
    requestAnimationFrame(() => inputRef.current?.focus());
    const refocus = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", refocus);
    const root = containerRef.current;
    if (!root) {
      style.remove();
      window.removeEventListener("keydown", refocus);
      return;
    }
    if (live) return () => {
      style.remove();
      window.removeEventListener("keydown", refocus);
      clearHighlights();
    };
    observerRef.current = new MutationObserver(() => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(refresh, 160);
    });
    observerRef.current.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => {
      observerRef.current?.disconnect();
      if (timerRef.current) window.clearTimeout(timerRef.current);
      window.removeEventListener("keydown", refocus);
      style.remove();
      clearHighlights();
    };
  }, [open, live]);

  useEffect(() => {
    if (!open) return;
    queryRef.current = query;
    currentRef.current = 0;
    const timer = window.setTimeout(refresh, 80);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  if (!open) return null;
  return (
    <div
      ref={searchRef}
      className={`conversation-search ${dragging ? "dragging" : ""}`}
      role="search"
      style={
        position
          ? { left: position.x, top: position.y, right: "auto" }
          : undefined
      }
    >
      <span
        className="conversation-search-drag"
        title="拖动搜索框"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <Search size={15} />
      </span>
      <input
        ref={inputRef}
        value={query}
        placeholder="搜索当前对话输出"
        aria-label="搜索当前对话输出"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            showCurrent(currentRef.current + (event.shiftKey ? -1 : 1));
          } else if (event.key === "Escape") onClose();
        }}
      />
      <span className="conversation-search-count">
        {query ? `${result.current}/${result.total}` : ""}
      </span>
      <button
        type="button"
        title="上一个匹配"
        onClick={() => showCurrent(currentRef.current - 1)}
        disabled={!result.total}
      >
        <ChevronUp size={15} />
      </button>
      <button
        type="button"
        title="下一个匹配"
        onClick={() => showCurrent(currentRef.current + 1)}
        disabled={!result.total}
      >
        <ChevronDown size={15} />
      </button>
      <button type="button" title="关闭搜索" onClick={onClose}>
        <X size={15} />
      </button>
    </div>
  );
}
