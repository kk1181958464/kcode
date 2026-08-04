import React, { memo, useMemo, useState } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import { Code2, Copy } from "lucide-react";
import { copyWithToast } from "../../lib/toast";
import {
  localPathFromMarkdownHref,
  revealLocalPath,
} from "../../lib/reveal-path";
import { openExternalUrl } from "./external";

const baseMarkdownComponents: Components = {
  pre: ({ children }) => {
    const code = String(
      (children as { props?: { children?: unknown } })?.props?.children ?? "",
    ).replace(/\n$/, "");
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
// blocks (``` / ~~~) intact. Block-level memoization means a streaming answer
// only re-parses its last growing block each flush instead of the whole
// message — keeping the main thread free so the composer never janks.
function splitMarkdownBlocks(src: string): string[] {
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
        remarkPlugins={[remarkGfm]}
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
