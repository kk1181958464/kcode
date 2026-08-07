import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import postcss from "postcss";
import safeParser from "postcss-safe-parser";
import { PurgeCSS } from "purgecss";

const root = process.cwd();
const sourceFiles = ["src/styles.css"];
const writeChanges = process.argv.includes("--write");
const verbose = process.argv.includes("--verbose");

const sourceParts = await Promise.all(
  sourceFiles.map(async (file) => ({
    file,
    css: await readFile(path.join(root, file), "utf8"),
  })),
);

const mergedCss = sourceParts
  .map(({ file, css }) =>
    sourceParts.length > 1
      ? `/* Source: ${file} */\n${css.trim()}\n`
      : css.trim(),
  )
  .join("\n");

const runtimeSelectors = `
  <html data-theme="light" data-accent="indigo">
  <html data-theme="dark" data-accent="violet">
  <html data-accent="emerald"><html data-accent="blue">
  <html data-accent="orange"><html data-accent="mono">
  <div data-truncated="true" data-has-static="true"></div>
  <div class="active open on online offline connecting connected disconnected
    running waiting success completed complete failed failure denied blocked cancelled
    recoverable current pending idle disabled selected compact expanded visible verification
    dragging scrolling drop-target collapsed sidebar-collapsed status-collapsed browser-open
    settings-open remote-editor-mode drag-active is-active is-running is-blocked is-success
    is-waiting has-failures has-file-stats has-limits no-diff live-only revealable
    explorer-collapsed directory file symlink degraded healthy unavailable confirm
    spinning spin up down user assistant tool system"></div>
`;

const [result] = await new PurgeCSS().purge({
  content: [
    "index.html",
    "src/**/*.{ts,tsx,html}",
    { raw: runtimeSelectors, extension: "html" },
  ],
  css: [{ raw: mergedCss, name: "styles.css" }],
  defaultExtractor: (content) => content.match(/[A-Za-z0-9_:/-]+/g) ?? [],
  dynamicAttributes: [
    "data-theme",
    "data-accent",
    "data-truncated",
    "data-has-static",
  ],
  safelist: {
    standard: [
      "light",
      "dark",
      "indigo",
      "violet",
      "emerald",
      "blue",
      "orange",
      "mono",
    ],
    deep: [/^cm-/, /^diff-/, /^hljs-/, /^virtuoso/],
    greedy: [/data-theme/, /data-accent/, /data-truncated/, /data-has-static/],
    variables: [],
    keyframes: [],
  },
  fontFace: true,
  keyframes: true,
  variables: false,
  rejected: true,
});

if (!result) {
  throw new Error("PurgeCSS did not return a result");
}

const cssRoot = postcss().process(result.css, {
  from: undefined,
  parser: safeParser,
}).root;

const scopeForRule = (rule) => {
  const scope = [];
  let parent = rule.parent;
  while (parent && parent.type !== "root") {
    if (parent.type === "atrule") {
      scope.unshift(`@${parent.name} ${parent.params}`);
    } else if (parent.type === "rule") {
      scope.unshift(`selector(${parent.selector.replace(/\s+/g, " ").trim()})`);
    }
    parent = parent.parent;
  }
  return scope.join(" > ");
};

// Retire declarations from old visual layers only when a later rule in the
// exact same cascade scope and with the exact same selector overrides them.
// Repeated declarations within one rule are retained as syntax fallbacks.
const declarationsByKey = new Map();
cssRoot.walkRules((rule) => {
  const selector = rule.selector.replace(/\s+/g, " ").trim();
  const scope = scopeForRule(rule);
  for (const declaration of rule.nodes.filter((node) => node.type === "decl")) {
    const key = `${scope}::${selector}::${declaration.prop.toLowerCase()}`;
    const entries = declarationsByKey.get(key) ?? [];
    entries.push({ declaration, rule });
    declarationsByKey.set(key, entries);
  }
});

let overriddenDeclarations = 0;
for (const entries of declarationsByKey.values()) {
  const ruleGroups = [];
  for (const entry of entries) {
    const lastGroup = ruleGroups.at(-1);
    if (lastGroup?.rule === entry.rule) {
      lastGroup.entries.push(entry);
    } else {
      ruleGroups.push({ rule: entry.rule, entries: [entry] });
    }
  }

  let laterHasImportant = false;
  let laterHasNormal = false;
  for (let index = ruleGroups.length - 1; index >= 0; index -= 1) {
    const group = ruleGroups[index];
    for (const { declaration } of group.entries) {
      const isOverridden = declaration.important
        ? laterHasImportant
        : laterHasImportant || laterHasNormal;
      if (isOverridden) {
        declaration.remove();
        overriddenDeclarations += 1;
      }
    }
    laterHasImportant ||= group.entries.some(
      ({ declaration }) => declaration.important,
    );
    laterHasNormal ||= group.entries.some(
      ({ declaration }) => !declaration.important,
    );
  }
}

cssRoot.walkRules((rule) => {
  if (rule.nodes.length === 0) rule.remove();
});

// PurgeCSS keeps the cascade intact. Only remove byte-for-byte duplicate rules
// in the same at-rule scope; different override declarations remain ordered.
const seenRules = new Set();
let duplicateRules = 0;
cssRoot.walkRules((rule) => {
  const scope = scopeForRule(rule);
  const body = rule.nodes
    .map((node) => node.toString().replace(/\s+/g, " ").trim())
    .join(";");
  const signature = `${scope}::${rule.selector}::${body}`;
  if (seenRules.has(signature)) {
    duplicateRules += 1;
    rule.remove();
    return;
  }
  seenRules.add(signature);
});

const outputCss = `${cssRoot.toString().trim()}\n`;
const sourceBytes = Buffer.byteLength(`${mergedCss.trim()}\n`);
const outputBytes = Buffer.byteLength(outputCss);
const reduction = sourceBytes
  ? (((sourceBytes - outputBytes) / sourceBytes) * 100).toFixed(1)
  : "0.0";

console.log(`CSS source: ${sourceBytes.toLocaleString()} bytes`);
console.log(`CSS output: ${outputBytes.toLocaleString()} bytes`);
console.log(`Reduction: ${reduction}%`);
console.log(`Rejected selectors: ${result.rejected?.length ?? 0}`);
console.log(`Overridden declarations: ${overriddenDeclarations}`);
console.log(`Exact duplicate rules: ${duplicateRules}`);
if (verbose && result.rejected?.length) {
  console.log("Rejected selector list:");
  for (const selector of result.rejected) console.log(`  ${selector}`);
}

if (!writeChanges) {
  console.log("Dry run only. Re-run with --write to update src/styles.css.");
  process.exit(0);
}

await writeFile(path.join(root, "src/styles.css"), outputCss, "utf8");
console.log("Wrote src/styles.css.");
