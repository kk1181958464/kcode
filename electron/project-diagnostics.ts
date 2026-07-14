import { readFile } from "node:fs/promises";
import path from "node:path";

export type DiagnosticKind = "typecheck" | "test" | "lint" | "build";

const candidates: Record<DiagnosticKind, string[]> = {
  typecheck: ["typecheck", "type-check", "check:types", "check-types"],
  test: ["test"],
  lint: ["lint"],
  build: ["build"],
};

export async function resolveProjectDiagnostic(
  root: string,
  kind: DiagnosticKind,
) {
  let manifest: { scripts?: Record<string, unknown> };
  try {
    manifest = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
  } catch {
    return {
      available: [] as string[],
      message: "当前项目没有可读取的 package.json，已跳过 npm 项目诊断。",
    };
  }
  const scripts = Object.fromEntries(
    Object.entries(manifest.scripts ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const script = candidates[kind].find((name) => scripts[name]);
  if (script)
    return {
      script,
      command: `npm run ${script}`,
      available: Object.keys(scripts).sort(),
    };
  const available = Object.keys(scripts).sort();
  return {
    available,
    message: `项目未配置 ${kind} 脚本，已跳过。${available.length ? `可用脚本：${available.join("、")}` : "package.json 中没有 scripts。"}`,
  };
}
