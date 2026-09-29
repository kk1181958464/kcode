// @git-diff-view/lowlight registers lowlight's `all` grammar set (~190
// highlight.js languages, ~1.5 MB). Vite resolves its `lowlight` import to
// this module instead (see vite.config.ts), so the diff viewer ships the
// common set plus the few extras this app's users commonly diff. Unlisted
// languages still render: the wrapper falls back to highlightAuto.
import { common, createLowlight } from "lowlight";
import cmake from "highlight.js/lib/languages/cmake";
import dart from "highlight.js/lib/languages/dart";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import dos from "highlight.js/lib/languages/dos";
import groovy from "highlight.js/lib/languages/groovy";
import nginx from "highlight.js/lib/languages/nginx";
import powershell from "highlight.js/lib/languages/powershell";
import protobuf from "highlight.js/lib/languages/protobuf";
import scala from "highlight.js/lib/languages/scala";

export { createLowlight };

export const all = {
  ...common,
  cmake,
  dart,
  dockerfile,
  dos,
  groovy,
  nginx,
  powershell,
  protobuf,
  scala,
};
