import React, { memo, useEffect, useId, useMemo, useState } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Code2, Copy } from "lucide-react";
import { copyWithToast } from "../../lib/toast";
import {
  localPathFromMarkdownHref,
  revealLocalPath,
} from "../../lib/reveal-path";
import { openExternalUrl } from "./external";

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
export function partitionStreamingMarkdown(src: string): {
  sealedContent: string;
  sealedEnd: number;
} {
  if (!src) return { sealedContent: "", sealedEnd: 0 };
  // Same flush rules as splitMarkdownBlocks: a blank line outside a fence
  // seals the preceding block. The unfinished last block (and any open fence)
  // stays in the append-only text leaf.
  const lines = src.split("\n");
  let fence: string | null = null;
  let sealedEnd = 0;
  let cursor = 0;
  let hasContent = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLen = line.length + (i < lines.length - 1 ? 1 : 0);
    const marker = /^\s*(```+|~~~+)/.exec(line);
    if (marker) {
      const kind = marker[1][0];
      if (!fence) fence = kind;
      else if (fence === kind) fence = null;
      hasContent = true;
      cursor += lineLen;
      continue;
    }
    if (!fence && line.trim() === "") {
      if (hasContent) {
        sealedEnd = cursor + lineLen;
        hasContent = false;
      } else if (sealedEnd > 0) {
        sealedEnd = cursor + lineLen;
      }
      cursor += lineLen;
      continue;
    }
    hasContent = true;
    cursor += lineLen;
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
  return (
    <div className="markdown-block">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
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
  const visibleBlocks =
    expanded || hiddenCount === 0
      ? blocks
      : [
          ...blocks.slice(0, MAX_INITIAL_BLOCKS - INITIAL_TAIL_BLOCKS),
          `> 省略了 ${hiddenCount} 个较早内容块，点击下方按钮展开。`,
          ...blocks.slice(-INITIAL_TAIL_BLOCKS),
        ];
  return (
    <>
      {visibleBlocks.map((block, index) => (
        <MarkdownBlock
          key={index}
          content={block}
          workspacePath={workspacePath}
        />
      ))}
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
