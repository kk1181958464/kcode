import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

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
}: {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onClose(): void;
  onRevealAll(): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const currentRef = useRef(0);
  const observerRef = useRef<MutationObserver | undefined>(undefined);
  const timerRef = useRef<number | undefined>(undefined);
  const queryRef = useRef("");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState({ current: 0, total: 0 });

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
  }, [open]);

  useEffect(() => {
    if (!open) return;
    queryRef.current = query;
    currentRef.current = 0;
    const timer = window.setTimeout(refresh, 80);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  if (!open) return null;
  return (
    <div className="conversation-search" role="search">
      <Search size={15} />
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
