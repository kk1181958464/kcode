/**
 * KCode CLI PoC — drives the exact same agent runtime as the desktop app, but
 * renders the AgentEvent stream to a terminal via readline instead of IPC+React.
 *
 * Proves the runtime (electron/agent.ts and its tool loop) is host-agnostic:
 * the only glue needed is the electron-shim (aliased at build time) plus this
 * event renderer. Run with:  node dist-cli/cli/index.js  [workspacePath]
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import readline from "node:readline";
import {
  runAgent,
  resolveApproval,
  resolveApprovalWithScope,
} from "../electron/agent";
import { listProviders, saveProvider } from "../electron/store";
import { inspectProvider } from "../electron/provider-profile";
import type {
  ChatMessage,
  PermissionMode,
  ProviderConfig,
} from "../src/types";
import { LiveView } from "./tui/live-view";
import type { WriteSink } from "./tui/renderer";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";

function color(code: string, text: string) {
  return process.stdout.isTTY ? `${code}${text}${RESET}` : text;
}

/**
 * Small persisted CLI preferences under the same state dir the shim uses
 * (~/.kcode or $KCODE_HOME). Currently just the preferred permission mode so
 * `/mode` is remembered across runs.
 */
const SETTINGS_PATH = path.join(
  process.env.KCODE_HOME || path.join(os.homedir(), ".kcode"),
  "cli-settings.json",
);

function loadSettings(): { permissionMode?: PermissionMode } {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(settings: { permissionMode?: PermissionMode }): void {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch {
    // Preferences are best-effort; a write failure must not break the session.
  }
}

// Line-queue input. readline.question() throws "readline was closed" on a
// piped stdin after EOF, so instead buffer 'line' events and hand them out on
// demand. This works identically for interactive TTY and piped input (tests).
// A completer gives Tab-completion for slash commands (typing "/" + Tab lists
// them; "/mo" + Tab → /model).
const rl = readline.createInterface({
  input: process.stdin,
  completer(line: string): [string[], string] {
    if (!line.startsWith("/")) return [[], line];
    const names = COMMANDS.map((c) => c.name);
    const hits = names.filter((n) => n.startsWith(line));
    return [hits.length ? hits : names, line];
  },
});
const lineQueue: string[] = [];
let lineWaiter: ((line: string | null) => void) | null = null;
let inputClosed = false;

rl.on("line", (line) => {
  if (lineWaiter) {
    const resolve = lineWaiter;
    lineWaiter = null;
    resolve(line);
  } else lineQueue.push(line);
});
rl.on("close", () => {
  inputClosed = true;
  if (lineWaiter) {
    const resolve = lineWaiter;
    lineWaiter = null;
    resolve(null);
  }
});

/** Resolves to the next input line, or null once stdin is exhausted. */
function nextLine(prompt: string): Promise<string | null> {
  if (process.stdout.isTTY) process.stdout.write(prompt);
  if (lineQueue.length) return Promise.resolve(lineQueue.shift()!);
  if (inputClosed) return Promise.resolve(null);
  return new Promise((resolve) => (lineWaiter = resolve));
}

const ask = async (prompt: string) => (await nextLine(prompt)) ?? "/exit";

/**
 * Ensure a usable provider+model. Reuses the desktop store format under
 * ~/.kcode/providers.json. On first run it asks only for Base URL + API key,
 * then auto-discovers the provider's model list (and protocol) so the user
 * picks from a menu instead of typing a model id by hand. Manual entry is the
 * fallback when discovery isn't supported.
 */
async function ensureModel(): Promise<{ provider: ProviderConfig; modelId: string }> {
  let providers = await listProviders();
  let ready = providers.find((p) => p.enabled && p.hasApiKey && p.models.length);
  if (ready) return { provider: ready, modelId: ready.models[0].modelId };

  console.log(color(YELLOW, "尚未配置可用模型，进行一次性配置："));
  const baseUrl =
    (await ask("Base URL [https://api.deepseek.com]: ")).trim() ||
    "https://api.deepseek.com";
  const apiKey = (await ask("API Key: ")).trim();

  // Probe the provider's /models endpoint. inspectProvider auto-detects the
  // protocol family (openai/anthropic/gemini) and returns fully-formed models.
  process.stdout.write(color(DIM, "正在获取可用模型…\n"));
  let models: ProviderConfig["models"] = [];
  let protocol: ProviderConfig["protocol"] = "openai-chat";
  try {
    const probe = await inspectProvider({
      id: "cli-provider",
      name: "CLI Provider",
      protocol,
      baseUrl,
      enabled: true,
      models: [],
      apiKey,
    });
    models = probe.models;
    if (probe.suggestedProtocol) protocol = probe.suggestedProtocol;
    else if (models[0]?.protocol) protocol = models[0].protocol;
    if (!models.length)
      console.log(color(YELLOW, `未能自动获取模型列表：${probe.profile.message}`));
  } catch (error) {
    console.log(color(YELLOW, `模型探测失败：${errorMessage(error)}`));
  }

  let selected: ProviderConfig["models"] = [];
  if (models.length) {
    console.log(color(DIM, `发现 ${models.length} 个模型：`));
    models.forEach((m, i) => console.log(`  ${i + 1}. ${m.displayName}`));
    const pick = (
      await ask(color(CYAN, "选择编号(可多选,如 1 3 5;回车=全部): "))
    ).trim();
    if (!pick) {
      selected = models;
    } else {
      // Parse comma/space-separated 1-based indices, keep order, dedupe.
      const seen = new Set<number>();
      for (const tok of pick.split(/[,\s]+/)) {
        const idx = Number(tok) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < models.length && !seen.has(idx)) {
          seen.add(idx);
          selected.push(models[idx]);
        }
      }
      if (!selected.length) selected = [models[0]];
    }
  } else {
    // Fallback: provider has no listable models — take a manual id.
    const modelId = (await ask("模型 ID [deepseek-chat]: ")).trim() || "deepseek-chat";
    selected = [{ id: modelId, modelId, displayName: modelId, protocol }];
  }

  const provider: ProviderConfig = {
    id: "cli-provider",
    name: "CLI Provider",
    protocol,
    baseUrl,
    enabled: true,
    hasApiKey: true,
    // Only the selected models are saved; the first is the session default and
    // the rest are switchable via /model.
    models: selected,
  };
  await saveProvider(provider, apiKey);
  providers = await listProviders();
  ready = providers.find((p) => p.id === "cli-provider");
  if (!ready) throw new Error("模型配置失败");
  if (selected.length > 1)
    console.log(color(DIM, `已保存 ${selected.length} 个模型，/model 可切换。`));
  return { provider: ready, modelId: selected[0].modelId };
}

/**
 * A WriteSink over stdout that reports live terminal dimensions. When stdout is
 * not a TTY (piped/tests), the LiveView still works but width falls back to 80.
 */
const stdoutSink: WriteSink = {
  write: (data) => process.stdout.write(data),
  get columns() {
    return process.stdout.columns || 80;
  },
  get rows() {
    return process.stdout.rows || 24;
  },
};

/** Maps a tool name to its permission category, for session-scoped approval caching. */
function toolCategory(tool: string): string {
  if (tool === "run_command" || tool === "ssh_run" || tool === "start_process")
    return "runCommands";
  if (tool === "delete_path") return "deletePaths";
  return "workspaceWrite";
}

/**
 * Prompt the user to approve a tool the agent paused on (confirm mode). Returns
 * the decision; "session" also caches a session-wide allow for this command.
 */
async function promptApproval(
  view: LiveView,
  requestId: string,
  activity: { id: string; tool: string; command?: string; path?: string; input?: Record<string, unknown> },
  workspacePath: string,
): Promise<void> {
  view.freeze();
  const detail =
    activity.command ??
    activity.path ??
    (typeof activity.input?.path === "string" ? activity.input.path : "") ??
    "";
  process.stdout.write(
    `${YELLOW}⚠ 待批准${RESET} ${BOLD}${activity.tool}${RESET}${detail ? ` ${DIM}${detail}${RESET}` : ""}\n`,
  );
  const answer = (await ask(`${CYAN}执行? [y=允许 / N=拒绝 / a=本会话都允许 / p=永久允许]: ${RESET}`))
    .trim()
    .toLowerCase();
  if (answer === "a" || answer === "p") {
    const scope = answer === "p" ? "permanent" : "session";
    resolveApprovalWithScope(
      requestId,
      activity.id,
      true,
      scope,
      activity.command,
      toolCategory(activity.tool),
      workspacePath,
    );
    process.stdout.write(
      `${GREEN}✓ 已允许（${scope === "permanent" ? "永久记住" : "本会话记住"}）${RESET}\n`,
    );
  } else if (answer === "y" || answer === "yes") {
    resolveApproval(requestId, activity.id, true);
    process.stdout.write(`${GREEN}✓ 已允许${RESET}\n`);
  } else {
    resolveApproval(requestId, activity.id, false);
    process.stdout.write(`${RED}✗ 已拒绝${RESET}\n`);
  }
}

/** Runs one turn through the diff-rendered LiveView; returns the answer text. */
async function runTurn(
  messages: ChatMessage[],
  provider: ProviderConfig,
  modelId: string,
  workspacePath: string,
  permissionMode: PermissionMode,
): Promise<string> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  const view = new LiveView(stdoutSink);
  const requestId = `cli-${Date.now()}`;
  const pendingApprovals: Promise<void>[] = [];
  try {
    for await (const event of runAgent(
      requestId,
      {
        providerId: provider.id,
        modelId,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        permissionMode,
        workspacePath,
      },
      controller.signal,
    )) {
      const terminal = view.push(event);
      // In confirm mode the agent pauses on a tool with a "waiting" activity.
      // The approval key is only registered once the generator resumes PAST
      // this yield, so we must NOT block the loop here (that would deadlock).
      // Fire the prompt concurrently: the loop continues, the generator resumes
      // and registers the key, then the async prompt resolves it.
      if (event.type === "activity" && event.activity.status === "waiting") {
        pendingApprovals.push(
          promptApproval(view, requestId, event.activity, workspacePath),
        );
      }
      if (terminal) break;
    }
    await Promise.all(pendingApprovals);
  } finally {
    view.dispose();
    process.off("SIGINT", onSigint);
  }
  return view.answerText();
}

/** Session state the slash-command router can mutate. */
interface Session {
  provider: ProviderConfig;
  modelId: string;
  permissionMode: PermissionMode;
  messages: ChatMessage[];
}

/** Single source of truth for slash commands: help text, router, completion. */
const COMMANDS: { name: string; desc: string }[] = [
  { name: "/help", desc: "显示可用命令" },
  { name: "/model", desc: "在已配置模型间切换" },
  { name: "/mode", desc: "切换审批模式（confirm ↔ full-access）" },
  { name: "/clear", desc: "清空当前对话上下文" },
  { name: "/exit", desc: "退出" },
  { name: "/quit", desc: "退出" },
];

function commandListText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return (
    "可用命令：\n" +
    COMMANDS.map((c) => `  ${c.name.padEnd(width + 2)}${c.desc}`).join("\n")
  );
}
const HELP = commandListText();

/** Let the user pick another configured provider×model. */
async function switchModel(session: Session): Promise<void> {
  const providers = await listProviders();
  const options = providers
    .filter((p) => p.enabled && p.hasApiKey)
    .flatMap((p) => p.models.map((m) => ({ provider: p, model: m })));
  if (!options.length) {
    console.log(color(YELLOW, "没有其它已配置的模型。"));
    return;
  }
  options.forEach((o, i) => {
    const current =
      o.provider.id === session.provider.id && o.model.modelId === session.modelId;
    console.log(
      `  ${i + 1}. ${o.provider.name} / ${o.model.displayName}${current ? color(DIM, " (当前)") : ""}`,
    );
  });
  const pick = (await ask(color(CYAN, "选择编号: "))).trim();
  const idx = Number(pick) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) {
    console.log(color(YELLOW, "已取消。"));
    return;
  }
  session.provider = options[idx].provider;
  session.modelId = options[idx].model.modelId;
  console.log(color(DIM, `已切换到 ${session.provider.name} / ${session.modelId}`));
}

/** Handle a slash command. Returns how the caller should proceed. */
async function handleSlashCommand(
  input: string,
  session: Session,
): Promise<"handled" | "exit" | "send"> {
  if (!input.startsWith("/")) return "send";
  const [cmd] = input.slice(1).split(/\s+/);
  switch (cmd) {
    case "":
      // Bare "/" — show the command list (Tab also completes commands).
      console.log(HELP);
      return "handled";
    case "exit":
    case "quit":
      return "exit";
    case "help":
      console.log(HELP);
      return "handled";
    case "clear":
      session.messages = [];
      console.log(color(DIM, "已清空对话上下文。"));
      return "handled";
    case "mode":
      session.permissionMode =
        session.permissionMode === "confirm" ? "full-access" : "confirm";
      saveSettings({ permissionMode: session.permissionMode });
      console.log(color(DIM, `审批模式：${session.permissionMode}（已记住）`));
      return "handled";
    case "model":
      await switchModel(session);
      return "handled";
    default:
      console.log(color(YELLOW, `未知命令 ${input}，输入 /help 查看。`));
      return "handled";
  }
}

/** Extract flags (--x) and the first positional arg (workspace path). */
function parseArgs(argv: string[]): { workspacePath?: string; yolo: boolean } {
  let workspacePath: string | undefined;
  let yolo = false;
  for (const arg of argv) {
    if (arg === "--yolo" || arg === "--full-access") yolo = true;
    else if (!arg.startsWith("--") && workspacePath === undefined) workspacePath = arg;
  }
  return { workspacePath, yolo };
}

async function main() {
  const { workspacePath: rawPath, yolo } = parseArgs(process.argv.slice(2));
  const workspacePath = path.resolve(rawPath || process.cwd());
  // confirm by default for safety; but a non-interactive stdin cannot answer a
  // y/N prompt, so fall back to full-access there (piped/automated runs). A
  // remembered `/mode` preference (persisted) wins for interactive sessions.
  const interactive = process.stdin.isTTY === true;
  const saved = loadSettings();
  const permissionMode: PermissionMode =
    yolo || !interactive
      ? "full-access"
      : (saved.permissionMode ?? "confirm");

  console.log(color(BOLD, "KCode CLI"));
  console.log(color(DIM, `工作区: ${workspacePath}`));
  const { provider, modelId } = await ensureModel();
  const session: Session = { provider, modelId, permissionMode, messages: [] };
  console.log(color(DIM, `模型: ${provider.name} / ${modelId} · 审批: ${permissionMode}`));
  if (!interactive && !yolo)
    console.log(color(DIM, "（非交互输入，已自动使用 full-access）"));
  console.log(color(DIM, "输入任务，Ctrl+C 中断当前回合，/help 查看命令。\n"));

  for (;;) {
    const input = (await ask(color(CYAN, "› "))).trim();
    if (!input) continue;
    const action = await handleSlashCommand(input, session);
    if (action === "exit") break;
    if (action === "handled") continue;
    session.messages.push({
      id: `user:${Date.now()}`,
      role: "user",
      content: input,
      createdAt: Date.now(),
    });
    const answer = await runTurn(
      session.messages,
      session.provider,
      session.modelId,
      workspacePath,
      session.permissionMode,
    );
    // Persist the assistant reply so the next turn carries prior context.
    if (answer.trim())
      session.messages.push({
        id: `assistant:${Date.now()}`,
        role: "assistant",
        content: answer,
        createdAt: Date.now(),
      });
    process.stdout.write("\n");
  }
  rl.close();
}

main().catch((error) => {
  console.error(color(RED, `致命错误: ${error?.message ?? error}`));
  process.exit(1);
});
