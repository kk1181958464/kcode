import React, { Suspense, lazy } from "react";
import type { DiffView as EagerDiffView } from "./DiffView";

// @git-diff-view pulls in highlight.js/lowlight; keep it out of the entry chunk.
const DiffViewImpl = lazy(() =>
  import("./DiffView").then((module) => ({ default: module.DiffView })),
);

type DiffViewProps = React.ComponentProps<typeof EagerDiffView>;

export function DiffView(props: DiffViewProps) {
  return (
    <Suspense
      fallback={
        <pre
          className={`diff-view-loading${props.className ? ` ${props.className}` : ""}`}
        >
          {props.text}
        </pre>
      }
    >
      <DiffViewImpl {...props} />
    </Suspense>
  );
}
