import React, { useMemo } from "react";
import { Virtuoso } from "react-virtuoso";
import { classifyDiffLine, shouldVirtualizeDiff } from "../../diff-rendering";

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

export const DiffView = React.memo(function DiffView({
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
});
