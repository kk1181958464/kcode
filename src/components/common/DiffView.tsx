import React, { useEffect, useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import {
  DiffView as GitDiffView,
  DiffModeEnum,
  DiffFile,
  getLang,
  setEnableFastDiffTemplate,
} from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view-pure.css";
import { classifyDiffLine, shouldVirtualizeDiff } from "../../diff-rendering";
import {
  displayDiffPath,
  parseUnifiedDiffFiles,
  toDiffViewHunks,
  type UnifiedDiffFile,
} from "../../lib/unified-diff";

setEnableFastDiffTemplate(true);

function diffClassName(className: string | undefined, wrapLines: boolean) {
  return `diff-view${wrapLines ? " is-wrapped" : ""}${className ? ` ${className}` : ""}`;
}

function DiffLine({
  line,
  newline = false,
}: {
  line: string;
  newline?: boolean;
}) {
  return (
    <span className={`diff-line diff-${classifyDiffLine(line)}`}>
      {line || " "}
      {newline && "\n"}
    </span>
  );
}

function PlainDiffView({
  text,
  className,
  wrapLines = false,
  virtualize = false,
}: {
  text: string;
  className?: string;
  wrapLines?: boolean;
  virtualize?: boolean;
}) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const rootClassName = diffClassName(className, wrapLines);
  if (shouldVirtualizeDiff(lines.length, virtualize))
    return (
      <Virtuoso
        className={`${rootClassName} diff-view-virtualized`}
        data={lines}
        defaultItemHeight={18}
        increaseViewportBy={480}
        overscan={300}
        computeItemKey={(index) => index}
        itemContent={(_, line) => <DiffLine line={line} />}
      />
    );
  return (
    <pre className={rootClassName}>
      {lines.map((line, index) => (
        <DiffLine key={index} line={line} newline />
      ))}
    </pre>
  );
}

function useDocumentTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  useEffect(() => {
    const root = document.documentElement;
    const sync = () =>
      setTheme(root.dataset.theme === "dark" ? "dark" : "light");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

function RichFileDiff({
  file,
  theme,
  mode,
  wrapLines,
}: {
  file: UnifiedDiffFile;
  theme: "light" | "dark";
  mode: "split" | "unified";
  wrapLines: boolean;
}) {
  const path = file.newPath !== "/dev/null" ? file.newPath : file.oldPath;
  const lang = getLang(path) || "plaintext";
  const viewMode =
    mode === "unified" ? DiffModeEnum.Unified : DiffModeEnum.SplitGitHub;

  const diffFile = useMemo(() => {
    try {
      const instance = DiffFile.createInstance({
        oldFile: {
          fileName: file.oldPath,
          fileLang: lang,
        },
        newFile: {
          fileName: file.newPath,
          fileLang: lang,
        },
        hunks: toDiffViewHunks(file),
      });
      instance.initTheme(theme);
      instance.init();
      instance.buildSplitDiffLines();
      instance.buildUnifiedDiffLines();
      return instance;
    } catch (error) {
      console.warn("[DiffView] DiffFile init failed", error);
      return null;
    }
  }, [file.hunks, file.newPath, file.oldPath, lang, theme]);

  useEffect(() => {
    return () => {
      try {
        diffFile?.clearId();
      } catch {
        /* ignore */
      }
    };
  }, [diffFile]);

  if (!diffFile)
    return (
      <PlainDiffView
        text={file.hunks.join("\n")}
        wrapLines={wrapLines}
        virtualize
      />
    );

  return (
    <div className="git-rich-diff-host">
      <GitDiffView
        diffFile={diffFile}
        diffViewMode={viewMode}
        diffViewTheme={theme}
        diffViewHighlight
        diffViewWrap={wrapLines}
        diffViewFontSize={12}
      />
    </div>
  );
}

export const DiffView = React.memo(function DiffView({
  text,
  className,
  wrapLines = false,
  virtualize = false,
  rich = true,
  mode = "split",
}: {
  text: string;
  className?: string;
  wrapLines?: boolean;
  virtualize?: boolean;
  /** Prefer GitHub-style viewer when the text is a parseable unified diff. */
  rich?: boolean;
  mode?: "split" | "unified";
}) {
  const theme = useDocumentTheme();
  const files = useMemo(
    () => (rich ? parseUnifiedDiffFiles(text) : []),
    [rich, text],
  );

  if (!rich || files.length === 0)
    return (
      <PlainDiffView
        text={text}
        className={className}
        wrapLines={wrapLines}
        virtualize={virtualize}
      />
    );

  return (
    <div
      className={`git-rich-diff theme-${theme}${className ? ` ${className}` : ""}`}
      data-theme={theme}
    >
      {files.map((file, index) => {
        const path =
          file.newPath !== "/dev/null" ? file.newPath : file.oldPath;
        return (
          <section key={`${path}-${index}`} className="git-rich-diff-file">
            {files.length > 1 && (
              <header className="git-rich-diff-file-head">
                <strong>{displayDiffPath(file)}</strong>
                <small>{path}</small>
              </header>
            )}
            <RichFileDiff
              file={file}
              theme={theme}
              mode={mode}
              wrapLines={wrapLines}
            />
          </section>
        );
      })}
    </div>
  );
});
