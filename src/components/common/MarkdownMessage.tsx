import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Code2, Copy } from "lucide-react";
import { openExternalUrl } from "./external";

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
}: {
  content: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, href, ...props }) => (
          <a
            {...props}
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              if (!href || !/^https?:\/\//i.test(href)) return;
              event.preventDefault();
              openExternalUrl(href);
            }}
          >
            {children}
          </a>
        ),
        pre: ({ children }) => {
          const code = String(
            (children as { props?: { children?: unknown } })?.props?.children ??
              "",
          ).replace(/\n$/, "");
          return (
            <div className="code-block">
              <div className="code-toolbar">
                <span>
                  <Code2 size={13} />
                  代码
                </span>
                <button
                  title="复制代码"
                  onClick={() => void navigator.clipboard.writeText(code)}
                >
                  <Copy size={13} />
                  复制
                </button>
              </div>
              <pre>{children}</pre>
            </div>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});
