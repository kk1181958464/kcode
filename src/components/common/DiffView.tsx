import React from "react";

export const DiffView = React.memo(function DiffView({
  text,
  className,
  wrapLines = false,
}: {
  text: string;
  className?: string;
  wrapLines?: boolean;
}) {
  const lines = text.split("\n");
  return (
    <pre
      className={`diff-view${wrapLines ? " is-wrapped" : ""}${className ? ` ${className}` : ""}`}
    >
      {lines.map((line, index) => {
        const kind =
          line.startsWith("+++") || line.startsWith("---")
            ? "meta"
            : line.startsWith("@@")
              ? "hunk"
              : line.startsWith("+")
                ? "add"
                : line.startsWith("-")
                  ? "del"
                  : line.startsWith("diff ") || line.startsWith("index ")
                    ? "meta"
                    : "context";
        return (
          <span key={index} className={`diff-line diff-${kind}`}>
            {line || " "}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
});
