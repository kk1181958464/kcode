import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

export const editorTheme = [
  EditorView.theme(
    {
      "&": { height: "100%", backgroundColor: "#171b18", color: "#e4ebe6" },
      ".cm-content": {
        caretColor: "#8da2ff",
        fontFamily: "'Cascadia Code', Consolas, monospace",
        fontSize: "12.5px",
        lineHeight: "1.65",
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#8da2ff" },
      ".cm-gutters": {
        backgroundColor: "#151815",
        color: "#667068",
        border: "0",
      },
      ".cm-activeLineGutter": { backgroundColor: "#202620" },
      ".cm-activeLine": { backgroundColor: "rgba(255,255,255,.028)" },
      ".cm-selectionBackground, ::selection": {
        backgroundColor: "rgba(91,108,255,.34) !important",
      },
      ".cm-scroller": { overflow: "auto" },
    },
    { dark: true },
  ),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: tags.keyword, color: "#c9a7ff" },
      { tag: [tags.name, tags.deleted, tags.character], color: "#e4ebe6" },
      {
        tag: [tags.propertyName, tags.function(tags.variableName)],
        color: "#8fc7ff",
      },
      { tag: [tags.string, tags.special(tags.string)], color: "#a8d7a0" },
      { tag: [tags.number, tags.bool, tags.null], color: "#f3bd78" },
      { tag: [tags.comment, tags.meta], color: "#718078", fontStyle: "italic" },
      {
        tag: [tags.heading, tags.strong],
        color: "#d9e1ff",
        fontWeight: "bold",
      },
      { tag: tags.link, color: "#77c8c2", textDecoration: "underline" },
    ]),
  ),
];

export function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

export async function languageFor(path: string): Promise<Extension> {
  const extension = fileName(path).split(".").at(-1)?.toLowerCase();
  if (["js", "jsx", "mjs", "cjs"].includes(extension || ""))
    return import("@codemirror/lang-javascript").then(({ javascript }) =>
      javascript({ jsx: extension === "jsx" }),
    );
  if (["ts", "tsx", "mts", "cts"].includes(extension || ""))
    return import("@codemirror/lang-javascript").then(({ javascript }) =>
      javascript({ typescript: true, jsx: extension === "tsx" }),
    );
  if (["html", "htm", "vue", "svelte", "xml"].includes(extension || ""))
    return import("@codemirror/lang-html").then(({ html }) => html());
  if (["css", "scss", "less"].includes(extension || ""))
    return import("@codemirror/lang-css").then(({ css }) => css());
  if (["json", "jsonc"].includes(extension || ""))
    return import("@codemirror/lang-json").then(({ json }) => json());
  if (["md", "mdx"].includes(extension || ""))
    return import("@codemirror/lang-markdown").then(({ markdown }) =>
      markdown(),
    );
  if (["py", "pyw"].includes(extension || ""))
    return import("@codemirror/lang-python").then(({ python }) => python());
  if (extension === "php")
    return import("@codemirror/lang-php").then(({ php }) => php());
  return [];
}

export function formatSize(size: number) {
  if (size < 1_024) return `${size} B`;
  if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KB`;
  return `${(size / 1_048_576).toFixed(1)} MB`;
}
