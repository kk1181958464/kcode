// Renders a unified diff with per-line coloring: additions green, deletions
// red, hunk headers blue-grey, everything else neutral. Makes it obvious at a
// glance which lines changed instead of showing a flat single-color block.
export function DiffView({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const lines = text.split("\n");
  return (
    <pre className={`diff-view${className ? ` ${className}` : ""}`}>
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
}
