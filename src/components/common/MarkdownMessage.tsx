import React, { memo, useEffect, useId, useMemo, useState } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type Options as MarkdownOptions,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import { Code2, Copy } from "lucide-react";
import { copyWithToast } from "../../lib/toast";
import {
  localPathFromMarkdownHref,
  revealLocalPath,
} from "../../lib/reveal-path";
import { openExternalUrl } from "./external";

// KaTeX (JS + CSS + fonts) is large and most messages have no math, so the
// math plugins load on first use and are shared by every block afterwards.
type PluggableList = NonNullable<MarkdownOptions["remarkPlugins"]>;
type MathPlugins = { remark: PluggableList; rehype: PluggableList };
let mathPlugins: MathPlugins | null = null;
let mathPluginsPending: Promise<MathPlugins> | null = null;
const NO_REHYPE_PLUGINS: PluggableList = [];
const GFM_ONLY: PluggableList = [remarkGfm];

export function mayContainMath(content: string) {
  return content.includes("$") || /\\[([]/.test(content);
}

function loadMathPlugins() {
  mathPluginsPending ??= Promise.all([
    import("remark-math"),
    import("rehype-katex"),
    import("katex/dist/katex.min.css"),
  ]).then(([remarkMath, rehypeKatex]) => {
    mathPlugins = {
      remark: [remarkGfm, remarkMath.default],
      rehype: [rehypeKatex.default],
    };
    return mathPlugins;
  });
  return mathPluginsPending;
}

function useMathPlugins(content: string) {
  const needed = mayContainMath(content);
  const [loaded, setLoaded] = useState(mathPlugins);
  useEffect(() => {
    if (!needed || loaded) return;
    let active = true;
    void loadMathPlugins().then((plugins) => {
      if (active) setLoaded(plugins);
    });
    return () => {
      active = false;
    };
  }, [needed, loaded]);
  return needed ? loaded : null;
}

const MERMAID_CACHE_LIMIT = 32;
const mermaidSvgCache = new Map<string, string>();
const mermaidPending = new Map<string, Promise<string>>();

function cacheMermaidSvg(chart: string, svg: string) {
  mermaidSvgCache.delete(chart);
  mermaidSvgCache.set(chart, svg);
  while (mermaidSvgCache.size > MERMAID_CACHE_LIMIT)
    mermaidSvgCache.delete(mermaidSvgCache.keys().next().value as string);
}

const MermaidDiagram = memo(function MermaidDiagram({
  chart,
}: {
  chart: string;
}) {
  const id = `kcode-mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const normalizedChart = chart.trim();
    const cached = mermaidSvgCache.get(normalizedChart);
    if (cached) {
      setSvg(cached);
      setError("");
      return () => {
        active = false;
      };
    }
    setSvg("");
    setError("");
    const pending = mermaidPending.get(normalizedChart) ?? import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "default",
        });
        const result = await mermaid.render(id, normalizedChart);
        cacheMermaidSvg(normalizedChart, result.svg);
        return result.svg;
      });
    mermaidPending.set(normalizedChart, pending);
    void pending
      .then((result) => {
        mermaidPending.delete(normalizedChart);
        if (active) setSvg(result);
      })
      .catch(
        (reason) => {
          mermaidPending.delete(normalizedChart);
          if (active)
            setError(reason instanceof Error ? reason.message : String(reason));
        },
      );
    return () => {
      active = false;
    };
  }, [chart, id]);
  if (error)
    return (
      <div className="mermaid-error">
        <span>Mermaid 渲染失败</span>
        <code>{error}</code>
        <pre>{chart}</pre>
      </div>
    );
  if (!svg) return <div className="mermaid-loading">正在绘制流程图…</div>;
  return (
    <div
      className="mermaid-diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});

const baseMarkdownComponents: Components = {
  pre: ({ children }) => {
    const child = Array.isArray(children) ? children[0] : children;
    const childProps = (
      child as { props?: { className?: string; children?: unknown } }
    )?.props;
    const code = String(childProps?.children ?? "").replace(/\n$/, "");
    const language = childProps?.className?.match(/language-([\w-]+)/)?.[1];
    if (language === "mermaid") return <MermaidDiagram chart={code} />;
    return (
      <div className="code-block">
        <div className="code-toolbar">
          <span>
            <Code2 size={13} />
            代码
          </span>
          <button title="复制代码" onClick={() => void copyWithToast(code)}>
            <Copy size={13} />
            复制
          </button>
        </div>
        <pre>{children}</pre>
      </div>
    );
  },
};

// Split markdown into top-level blocks at blank lines, keeping fenced code
// blocks (``` / ~~~) intact. Live output stays in an append-only text node;
// once a segment settles, block memoization keeps later structural updates
// from re-parsing the complete message.
export function splitMarkdownBlocks(src: string): string[] {
  const lines = src.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (current.length) {
      blocks.push(current.join("\n"));
      current = [];
    }
  };
  for (const line of lines) {
    const marker = /^\s*(```+|~~~+)/.exec(line);
    if (marker) {
      const kind = marker[1][0]; // ` or ~
      if (!fence) fence = kind;
      else if (fence === kind) fence = null;
      current.push(line);
      continue;
    }
    if (!fence && line.trim() === "") flush();
    else current.push(line);
  }
  flush();
  return blocks;
}

/**
 * While streaming: promote only sealed top-level blocks to Markdown.
 * The open fence / unfinished last block stays in the append-only text leaf
 * so bottom-follow does not bounce on every token.
 */
export function partitionStreamingMarkdown(
  src: string,
  from = 0,
): {
  sealedContent: string;
  sealedEnd: number;
} {
  if (!src) return { sealedContent: "", sealedEnd: 0 };
  // Same flush rules as splitMarkdownBlocks: a blank line outside a fence
  // seals the preceding block. The unfinished last block (and any open fence)
  // stays in the append-only text leaf.
  //
  // `from` must be a sealedEnd previously returned for a prefix of `src`.
  // Sealed boundaries are always outside a fence with no pending content, so
  // scanning can resume there instead of rescanning the whole answer.
  const resume = from > 0 && from <= src.length ? from : 0;
  let fence: string | null = null;
  let sealedEnd = resume;
  let cursor = resume;
  let hasContent = false;
  // Visit every "\n"-separated segment, including a trailing empty one, to
  // match src.split("\n").
  for (;;) {
    const newline = src.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? src.length : newline;
    const line = src.slice(cursor, lineEnd);
    const lineLen = lineEnd - cursor + (newline === -1 ? 0 : 1);
    const marker = /^\s*(```+|~~~+)/.exec(line);
    if (marker) {
      const kind = marker[1][0];
      if (!fence) fence = kind;
      else if (fence === kind) fence = null;
      hasContent = true;
    } else if (!fence && line.trim() === "") {
      if (hasContent) {
        sealedEnd = cursor + lineLen;
        hasContent = false;
      } else if (sealedEnd > 0) {
        sealedEnd = cursor + lineLen;
      }
    } else {
      hasContent = true;
    }
    cursor += lineLen;
    if (newline === -1) break;
  }
  if (sealedEnd <= 0) return { sealedContent: "", sealedEnd: 0 };
  const sealedContent = src.slice(0, sealedEnd);
  return { sealedContent, sealedEnd };
}

/** True when `src` has an unclosed ``` / ~~~ fence (streaming code tail). */
export function isOpenMarkdownFence(src: string): boolean {
  if (!src) return false;
  let fence: string | null = null;
  for (const line of src.split("\n")) {
    const marker = /^\s*(```+|~~~+)/.exec(line);
    if (!marker) continue;
    const kind = marker[1][0];
    if (!fence) fence = kind;
    else if (fence === kind) fence = null;
  }
  return fence !== null;
}

/** Close a dangling ``` / ~~~ fence so a split timeline segment renders as a bounded code-block. */
export function closeOpenMarkdownFence(src: string): string {
  if (!src || !isOpenMarkdownFence(src)) return src;
  let fence: string | null = null;
  let marker = "```";
  for (const line of src.split("\n")) {
    const match = /^\s*(```+|~~~+)/.exec(line);
    if (!match) continue;
    const kind = match[1][0];
    if (!fence) {
      fence = kind;
      marker = match[1];
    } else if (fence === kind) {
      fence = null;
    }
  }
  if (!fence) return src;
  const trimmed = src.replace(/\s*$/, "");
  return `${trimmed}\n${marker}\n`;
}

const MarkdownBlock = memo(function MarkdownBlock({
  content,
  workspacePath,
}: {
  content: string;
  workspacePath: string;
}) {
  const components = useMemo<Components>(
    () => ({
      ...baseMarkdownComponents,
      a: ({ children, href, ...props }) => {
        const localPath = localPathFromMarkdownHref(href);
        const external = Boolean(href && /^https?:\/\//i.test(href));
        return (
          <a
            {...props}
            href={href}
            className={localPath ? "local-file-link" : undefined}
            target={external ? "_blank" : undefined}
            rel={external ? "noreferrer" : undefined}
            title={localPath ? "在文件资源管理器中显示" : props.title}
            onClick={(event: React.MouseEvent<HTMLAnchorElement>) => {
              if (localPath) {
                event.preventDefault();
                void revealLocalPath(localPath, workspacePath);
              } else if (external && href) {
                event.preventDefault();
                openExternalUrl(href);
              }
            }}
          >
            {children}
          </a>
        );
      },
    }),
    [workspacePath],
  );
  const math = useMathPlugins(content);
  return (
    <div className="markdown-block">
      <ReactMarkdown
        remarkPlugins={math?.remark ?? GFM_ONLY}
        rehypePlugins={math?.rehype ?? NO_REHYPE_PLUGINS}
        components={components}
        urlTransform={(url) =>
          localPathFromMarkdownHref(url) ? url : defaultUrlTransform(url)
        }
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

const MAX_INITIAL_BLOCKS = 120;
const INITIAL_TAIL_BLOCKS = 24;

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  workspacePath,
}: {
  content: string;
  workspacePath: string;
}) {
  const blocks = useMemo(() => splitMarkdownBlocks(content), [content]);
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = Math.max(0, blocks.length - MAX_INITIAL_BLOCKS);
  // Key blocks by their position in `blocks`: with index keys, every new block
  // shifts the truncated tail and forces all of it to re-parse.
  const truncated = !expanded && hiddenCount > 0;
  const headCount = truncated ? MAX_INITIAL_BLOCKS - INITIAL_TAIL_BLOCKS : 0;
  const tailStart = truncated ? blocks.length - INITIAL_TAIL_BLOCKS : 0;
  const renderBlock = (block: string, index: number) => (
    <MarkdownBlock
      key={`block-${index}`}
      content={block}
      workspacePath={workspacePath}
    />
  );
  return (
    <>
      {truncated ? (
        <>
          {blocks
            .slice(0, headCount)
            .map((block, index) => renderBlock(block, index))}
          <MarkdownBlock
            key="omitted"
            content={`> 省略了 ${hiddenCount} 个较早内容块，点击下方按钮展开。`}
            workspacePath={workspacePath}
          />
          {blocks
            .slice(tailStart)
            .map((block, index) => renderBlock(block, tailStart + index))}
        </>
      ) : (
        blocks.map(renderBlock)
      )}
      {hiddenCount > 0 && (
        <button
          type="button"
          className="markdown-expand"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起较早内容" : `展开全部 ${hiddenCount} 个内容块`}
        </button>
      )}
    </>
  );
});
