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
import { listProviders, removeProvider, saveProvider } from "../electron/store";
import { inspectProvider } from "../electron/provider-profile";
import type {
  ChatMessage,
  PermissionMode,
  Protocol,
  ProviderConfig,
} from "../src/types";
import { LiveView } from "./tui/live-view";
import type { WriteSink } from "./tui/renderer";
import { resolveInitialPermissionMode } from "./runtime-policy";
import { sanitizeTerminalText } from "./tui/ansi";
import { TerminalPrompt } from "./tui/prompt";
import {
  createProviderId,
  defaultFirst,
  firstUsableSelection,
  isUsableProvider,
} from "./providers";

const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);
const terminalText = (value: unknown) =>
  sanitizeTerminalText(String(value ?? ""));

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

interface CliSettings {
  permissionMode?: PermissionMode;
  providerId?: string;
  modelId?: string;
}

function loadSettings(): CliSettings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(settings: CliSettings): void {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), {
      mode: 0o600,
    });
    fs.chmodSync(SETTINGS_PATH, 0o600);
  } catch {
    // Preferences are best-effort; a write failure must not break the session.
  }
}

function updateSettings(patch: Partial<CliSettings>): void {
  saveSettings({ ...loadSettings(), ...patch });
}

function rememberSelection(
  session: Pick<Session, "provider" | "modelId">,
): void {
  updateSettings({ providerId: session.provider.id, modelId: session.modelId });
}

// Line-queue input. readline.question() throws "readline was closed" on a
// piped stdin after EOF, so instead buffer 'line' events and hand them out on
// demand. This works identically for interactive TTY and piped input (tests).
// A completer gives Tab-completion for slash commands (typing "/" + Tab lists
// them; "/mo" + Tab → /model).
const interactiveInput = process.stdin.isTTY === true;
const rl = interactiveInput
  ? null
  : readline.createInterface({ input: process.stdin });
const lineQueue: string[] = [];
let lineWaiter: ((line: string | null) => void) | null = null;
let inputClosed = false;

rl?.on("line", (line) => {
  if (lineWaiter) {
    const resolve = lineWaiter;
    lineWaiter = null;
    resolve(line);
  } else lineQueue.push(line);
});
rl?.on("close", () => {
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

const promptSink: WriteSink = {
  write: (data) => process.stdout.write(data),
  get columns() {
    return process.stdout.columns || 80;
  },
  get rows() {
    return process.stdout.rows || 24;
  },
};
const terminalPrompt = interactiveInput
  ? new TerminalPrompt({ input: process.stdin, output: promptSink })
  : null;

async function ask(
  label: string,
  options: {
    placeholder?: string;
    initialValue?: string;
    secret?: boolean;
  } = {},
): Promise<string> {
  if (terminalPrompt) {
    return (
      (await terminalPrompt.ask({
        label: terminalText(label).replace(/:\s*$/, ""),
        ...options,
      })) ?? "/exit"
    );
  }
  return (await nextLine(label)) ?? "/exit";
}

async function selectDefaultModel(
  models: ProviderConfig["models"],
  title: string,
  preferredModelId?: string,
): Promise<string> {
  const preferredIndex = Math.max(
    0,
    models.findIndex((model) => model.modelId === preferredModelId),
  );
  if (terminalPrompt) {
    const picked = await terminalPrompt.select(
      title,
      models.map((model) => ({
        label: model.displayName,
        description: model.modelId,
        value: model.modelId,
      })),
      preferredIndex,
    );
    if (!picked) throw new Error("已取消渠道配置");
    return picked;
  }
  models.forEach((model, index) =>
    console.log(`  ${index + 1}. ${terminalText(model.displayName)}`),
  );
  const pick = (await ask(`选择模型编号 [${preferredIndex + 1}]: `)).trim();
  const index = Number(pick || preferredIndex + 1) - 1;
  return models[
    Number.isInteger(index) && index >= 0 && index < models.length
      ? index
      : preferredIndex
  ].modelId;
}

async function configureProvider(
  existing?: ProviderConfig,
): Promise<{ provider: ProviderConfig; modelId: string }> {
  const providers = await listProviders();
  const name = (
    await ask("1 / 5  渠道名称", {
      initialValue: existing?.name,
      placeholder: "例如：公司中转 / DeepSeek / OpenAI",
    })
  ).trim();
  if (!name || name === "/exit") throw new Error("未提供渠道名称");
  const baseUrl = (
    await ask("2 / 5  模型服务地址", {
      initialValue: existing?.baseUrl,
      placeholder: "https://api.deepseek.com",
    })
  ).trim();
  if (!baseUrl || baseUrl === "/exit") throw new Error("未提供模型服务地址");
  const protocolOptions: Array<{
    label: string;
    description: string;
    value: Protocol | "auto";
  }> = [
    { label: "自动检测", description: "根据地址和模型接口识别", value: "auto" },
    {
      label: "OpenAI Responses",
      description: "openai-responses",
      value: "openai-responses",
    },
    {
      label: "OpenAI Chat Completions",
      description: "openai-chat",
      value: "openai-chat",
    },
    {
      label: "Anthropic Messages",
      description: "anthropic-messages",
      value: "anthropic-messages",
    },
    {
      label: "Gemini Generate Content",
      description: "gemini-generate-content",
      value: "gemini-generate-content",
    },
  ];
  let configuredProtocol: Protocol | "auto" = existing?.protocol ?? "auto";
  if (terminalPrompt) {
    const selected = await terminalPrompt.select(
      "3 / 5  接口协议",
      protocolOptions,
      Math.max(
        0,
        protocolOptions.findIndex(
          (option) => option.value === configuredProtocol,
        ),
      ),
    );
    if (!selected) throw new Error("已取消渠道配置");
    configuredProtocol = selected;
  } else {
    console.log("接口协议：");
    protocolOptions.forEach((option, index) =>
      console.log(`  ${index + 1}. ${option.label} (${option.description})`),
    );
    const pick = (await ask("3 / 5  选择协议编号 [1]: ")).trim();
    const index = Number(pick || "1") - 1;
    configuredProtocol =
      protocolOptions[
        Number.isInteger(index) && index >= 0 && index < protocolOptions.length
          ? index
          : 0
      ].value;
  }
  const apiKey = (
    await ask("4 / 5  API Key", {
      placeholder: existing?.hasApiKey
        ? "重新输入以同步模型或修改连接"
        : "输入内容不会显示",
      secret: true,
    })
  ).trim();
  if (!apiKey || apiKey === "/exit") throw new Error("未提供 API Key");

  const id =
    existing?.id ??
    createProviderId(
      name,
      providers.map((provider) => provider.id),
    );
  let protocol: Protocol =
    configuredProtocol === "auto" ? "openai-chat" : configuredProtocol;
  process.stdout.write(color(DIM, "正在检测协议并同步模型…\n"));
  const probe = await inspectProvider({
    id,
    name,
    protocol,
    baseUrl,
    enabled: true,
    models: existing?.models ?? [],
    apiKey,
  });
  if (configuredProtocol === "auto") {
    if (probe.suggestedProtocol) protocol = probe.suggestedProtocol;
    else if (probe.models[0]?.protocol) protocol = probe.models[0].protocol;
  }

  let models = probe.models.map((model) => ({ ...model, protocol }));
  let modelId: string;
  if (models.length) {
    modelId = await selectDefaultModel(
      models,
      `5 / 5  选择默认模型（发现 ${models.length} 个）`,
      existing?.models[0]?.modelId,
    );
    models = defaultFirst(models, modelId);
  } else {
    console.log(
      color(
        YELLOW,
        `未能自动获取模型列表：${terminalText(probe.profile.message)}`,
      ),
    );
    modelId = (
      await ask("5 / 5  模型 ID", {
        initialValue: existing?.models[0]?.modelId,
        placeholder: "deepseek-chat",
      })
    ).trim();
    if (!modelId || modelId === "/exit") throw new Error("未提供模型 ID");
    models = [
      { id: `${id}:${modelId}`, modelId, displayName: modelId, protocol },
    ];
  }

  const next: ProviderConfig = {
    id,
    name,
    protocol,
    baseUrl,
    enabled: existing?.enabled ?? true,
    hasApiKey: true,
    models,
    profile: probe.profile,
  };
  await saveProvider(next, apiKey);
  const saved = (await listProviders()).find((provider) => provider.id === id);
  if (!saved) throw new Error("渠道配置失败");
  console.log(
    color(
      GREEN,
      `已保存渠道 ${terminalText(saved.name)}，共 ${saved.models.length} 个模型。`,
    ),
  );
  return { provider: saved, modelId };
}

async function syncProviderModels(
  provider: ProviderConfig,
): Promise<{ provider: ProviderConfig; modelId: string }> {
  const apiKey = (
    await ask(`同步 ${provider.name} · API Key`, {
      placeholder: "输入内容不会显示",
      secret: true,
    })
  ).trim();
  if (!apiKey || apiKey === "/exit") throw new Error("未提供 API Key");
  process.stdout.write(color(DIM, "正在同步模型…\n"));
  const probe = await inspectProvider({
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    models: provider.models,
    apiKey,
  });
  const protocol = provider.protocol;
  let models = probe.models.map((model) => ({ ...model, protocol }));
  if (!models.length)
    throw new Error(probe.profile.message || "渠道没有返回可识别的模型列表");
  const modelId = await selectDefaultModel(
    models,
    `选择 ${provider.name} 的默认模型`,
    provider.models[0]?.modelId,
  );
  models = defaultFirst(models, modelId);
  await saveProvider(
    { ...provider, protocol, models, profile: probe.profile },
    apiKey,
  );
  const saved = (await listProviders()).find((item) => item.id === provider.id);
  if (!saved) throw new Error("渠道同步后未找到保存结果");
  console.log(
    color(
      GREEN,
      `已同步 ${terminalText(saved.name)} 的 ${models.length} 个模型。`,
    ),
  );
  return { provider: saved, modelId };
}

/** Ensure at least one usable provider exists, creating the first one if needed. */
async function ensureModel(): Promise<{
  provider: ProviderConfig;
  modelId: string;
}> {
  const providers = await listProviders();
  const settings = loadSettings();
  const preferred = providers.find(
    (provider) =>
      provider.id === settings.providerId && isUsableProvider(provider),
  );
  if (preferred) {
    const modelId = preferred.models.some(
      (model) => model.modelId === settings.modelId,
    )
      ? settings.modelId!
      : preferred.models[0].modelId;
    return { provider: preferred, modelId };
  }
  const ready = firstUsableSelection(providers);
  if (ready) return ready;
  console.log("");
  console.log(color(BOLD, "首次配置"));
  console.log(
    color(DIM, "添加第一个模型渠道。之后可使用 /provider 管理多个渠道。\n"),
  );
  return configureProvider();
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
  activity: {
    id: string;
    tool: string;
    command?: string;
    path?: string;
    input?: Record<string, unknown>;
  },
  workspacePath: string,
): Promise<void> {
  view.freeze();
  const detail =
    activity.command ??
    activity.path ??
    (typeof activity.input?.path === "string" ? activity.input.path : "") ??
    "";
  const safeTool = terminalText(activity.tool);
  const safeDetail = terminalText(detail);
  process.stdout.write(
    `${YELLOW}⚠ 待批准${RESET} ${BOLD}${safeTool}${RESET}${safeDetail ? ` ${DIM}${safeDetail}${RESET}` : ""}\n`,
  );
  const answer = (
    await ask(
      `${CYAN}执行? [y=允许 / N=拒绝 / a=本会话都允许 / p=永久允许]: ${RESET}`,
    )
  )
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
  { name: "/provider", desc: "添加和管理模型渠道" },
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
  const currentIndex = Math.max(
    0,
    options.findIndex(
      (option) =>
        option.provider.id === session.provider.id &&
        option.model.modelId === session.modelId,
    ),
  );
  if (terminalPrompt) {
    const picked = await terminalPrompt.select(
      "切换模型",
      options.map((option) => ({
        label: `${option.provider.name} / ${option.model.displayName}`,
        description: option.model.modelId,
        value: option,
      })),
      currentIndex,
    );
    if (!picked) return;
    session.provider = picked.provider;
    session.modelId = picked.model.modelId;
    rememberSelection(session);
    console.log(
      color(DIM, `已切换到 ${session.provider.name} / ${session.modelId}`),
    );
    return;
  }
  options.forEach((o, i) => {
    const current =
      o.provider.id === session.provider.id &&
      o.model.modelId === session.modelId;
    console.log(
      `  ${i + 1}. ${terminalText(o.provider.name)} / ${terminalText(o.model.displayName)}${current ? color(DIM, " (当前)") : ""}`,
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
  rememberSelection(session);
  console.log(
    color(DIM, `已切换到 ${session.provider.name} / ${session.modelId}`),
  );
}

async function refreshSessionSelection(
  session: Session,
  preferredProviderId?: string,
): Promise<void> {
  const providers = await listProviders();
  const current = providers.find(
    (provider) => provider.id === (preferredProviderId ?? session.provider.id),
  );
  if (current && isUsableProvider(current)) {
    session.provider = current;
    if (!current.models.some((model) => model.modelId === session.modelId))
      session.modelId = current.models[0].modelId;
    rememberSelection(session);
    return;
  }
  const fallback = firstUsableSelection(providers);
  if (fallback) {
    session.provider = fallback.provider;
    session.modelId = fallback.modelId;
    rememberSelection(session);
    console.log(
      color(
        DIM,
        `当前渠道不可用，已切换到 ${terminalText(fallback.provider.name)} / ${terminalText(fallback.modelId)}`,
      ),
    );
    return;
  }
  const created = await configureProvider();
  session.provider = created.provider;
  session.modelId = created.modelId;
  rememberSelection(session);
}

function printProviders(providers: ProviderConfig[], session: Session): void {
  if (!providers.length) {
    console.log(color(YELLOW, "尚未配置模型渠道。"));
    return;
  }
  console.log(color(BOLD, "模型渠道"));
  providers.forEach((provider, index) => {
    const current = provider.id === session.provider.id ? " · 当前" : "";
    const status = provider.enabled
      ? provider.hasApiKey
        ? "已启用"
        : "缺少 Key"
      : "已停用";
    console.log(
      `  ${index + 1}. ${terminalText(provider.name)} · ${status} · ${provider.models.length} 个模型${current}`,
    );
    console.log(
      color(
        DIM,
        `     ${provider.protocol} · ${terminalText(provider.baseUrl)}`,
      ),
    );
  });
}

async function chooseProviderModel(
  provider: ProviderConfig,
  session: Session,
): Promise<void> {
  if (!isUsableProvider(provider)) {
    console.log(color(YELLOW, "该渠道尚未启用、缺少 API Key 或没有模型。"));
    return;
  }
  const modelId = await selectDefaultModel(
    provider.models,
    `选择 ${provider.name} 的模型`,
    provider.id === session.provider.id
      ? session.modelId
      : provider.models[0].modelId,
  );
  session.provider = provider;
  session.modelId = modelId;
  rememberSelection(session);
  console.log(
    color(
      DIM,
      `已切换到 ${terminalText(provider.name)} / ${terminalText(modelId)}`,
    ),
  );
}

async function manageOneProvider(
  provider: ProviderConfig,
  session: Session,
): Promise<void> {
  if (!terminalPrompt) return;
  for (;;) {
    const action = await terminalPrompt.select(
      `${provider.name} · ${provider.models.length} 个模型`,
      [
        {
          label: "设为当前渠道 / 选择模型",
          description: provider.enabled ? "切换当前会话" : "渠道已停用",
          value: "use" as const,
        },
        {
          label: "编辑连接并同步模型",
          description: "名称、地址、协议和 API Key",
          value: "edit" as const,
        },
        {
          label: "同步模型列表",
          description: "保留名称、地址和协议",
          value: "sync" as const,
        },
        {
          label: "仅修改渠道名称",
          description: provider.name,
          value: "rename" as const,
        },
        {
          label: provider.enabled ? "停用渠道" : "启用渠道",
          description: "配置保留，可随时恢复",
          value: "toggle" as const,
        },
        {
          label: "删除渠道",
          description: "删除配置与本地保存的 API Key",
          value: "delete" as const,
        },
        { label: "返回渠道列表", value: "back" as const },
      ],
    );
    if (!action || action === "back") return;
    if (action === "use") {
      await chooseProviderModel(provider, session);
      return;
    }
    if (action === "edit") {
      const wasCurrent = session.provider.id === provider.id;
      const updated = await configureProvider(provider);
      provider = updated.provider;
      if (wasCurrent) {
        session.provider = provider;
        session.modelId = updated.modelId;
        rememberSelection(session);
      }
      return;
    }
    if (action === "sync") {
      const wasCurrent = session.provider.id === provider.id;
      const updated = await syncProviderModels(provider);
      provider = updated.provider;
      if (wasCurrent) {
        session.provider = provider;
        session.modelId = updated.modelId;
        rememberSelection(session);
      }
      continue;
    }
    if (action === "rename") {
      const name = (
        await ask("渠道名称", {
          initialValue: provider.name,
          placeholder: provider.name,
        })
      ).trim();
      if (!name || name === "/exit") continue;
      const providers = await saveProvider({ ...provider, name });
      provider = providers.find((item) => item.id === provider.id) ?? {
        ...provider,
        name,
      };
      if (session.provider.id === provider.id) session.provider = provider;
      if (session.provider.id === provider.id) rememberSelection(session);
      console.log(color(GREEN, `已重命名为 ${terminalText(name)}`));
      continue;
    }
    if (action === "toggle") {
      if (provider.enabled && session.provider.id === provider.id) {
        const alternatives = (await listProviders()).filter(
          (item) => item.id !== provider.id && isUsableProvider(item),
        );
        if (!alternatives.length) {
          console.log(
            color(YELLOW, "当前是唯一可用渠道，请先添加或启用另一个渠道。"),
          );
          continue;
        }
      }
      const providers = await saveProvider({
        ...provider,
        enabled: !provider.enabled,
      });
      provider = providers.find((item) => item.id === provider.id) ?? {
        ...provider,
        enabled: !provider.enabled,
      };
      console.log(
        color(
          GREEN,
          `${terminalText(provider.name)} 已${provider.enabled ? "启用" : "停用"}`,
        ),
      );
      await refreshSessionSelection(session);
      continue;
    }
    if (action === "delete") {
      if (session.provider.id === provider.id) {
        const alternatives = (await listProviders()).filter(
          (item) => item.id !== provider.id && isUsableProvider(item),
        );
        if (!alternatives.length) {
          console.log(
            color(YELLOW, "当前是唯一可用渠道，请先添加或启用另一个渠道。"),
          );
          continue;
        }
      }
      const confirmation = (
        await ask(`输入渠道名称确认删除：${provider.name}`, {
          placeholder: provider.name,
        })
      ).trim();
      if (confirmation !== provider.name) {
        console.log(color(YELLOW, "名称不匹配，已取消删除。"));
        continue;
      }
      await removeProvider(provider.id);
      console.log(color(GREEN, `已删除渠道 ${terminalText(provider.name)}`));
      await refreshSessionSelection(session);
      return;
    }
  }
}

async function manageProviders(session: Session): Promise<void> {
  const providers = await listProviders();
  if (!terminalPrompt) {
    printProviders(providers, session);
    console.log(
      color(DIM, "交互终端中使用 /provider 可添加、编辑和删除渠道。"),
    );
    return;
  }
  for (;;) {
    const latest = await listProviders();
    const selected = await terminalPrompt.select("模型渠道", [
      {
        label: "＋ 添加渠道",
        description: "自动检测协议并同步模型",
        value: "add" as const,
      },
      ...latest.map((provider) => ({
        label: `${provider.enabled ? "●" : "○"} ${provider.name}${provider.id === session.provider.id ? "（当前）" : ""}`,
        description: `${provider.protocol} · ${provider.models.length} 个模型`,
        value: provider,
      })),
      { label: "返回", value: "back" as const },
    ]);
    if (!selected || selected === "back") return;
    if (selected === "add") {
      try {
        const created = await configureProvider();
        session.provider = created.provider;
        session.modelId = created.modelId;
        rememberSelection(session);
      } catch (error) {
        console.log(
          color(YELLOW, `添加渠道未完成：${terminalText(errorMessage(error))}`),
        );
      }
      continue;
    }
    try {
      await manageOneProvider(selected, session);
    } catch (error) {
      console.log(
        color(YELLOW, `渠道操作未完成：${terminalText(errorMessage(error))}`),
      );
    }
  }
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
      updateSettings({ permissionMode: session.permissionMode });
      console.log(color(DIM, `审批模式：${session.permissionMode}（已记住）`));
      return "handled";
    case "model":
      await switchModel(session);
      return "handled";
    case "provider":
    case "providers":
      await manageProviders(session);
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
    else if (!arg.startsWith("--") && workspacePath === undefined)
      workspacePath = arg;
  }
  return { workspacePath, yolo };
}

async function main() {
  const { workspacePath: rawPath, yolo } = parseArgs(process.argv.slice(2));
  const workspacePath = path.resolve(rawPath || process.cwd());
  // Non-interactive sessions cannot answer approval prompts, so they default
  // to read-only. Full access always requires an explicit command-line flag.
  // A remembered `/mode` preference only applies to interactive sessions.
  const interactive = interactiveInput;
  const saved = loadSettings();
  const permissionMode = resolveInitialPermissionMode({
    interactive,
    yolo,
    saved: saved.permissionMode,
  });

  console.log(color(BOLD, "KCode"));
  console.log(color(DIM, `工作区  ${terminalText(workspacePath)}`));
  const { provider, modelId } = await ensureModel();
  const session: Session = { provider, modelId, permissionMode, messages: [] };
  rememberSelection(session);
  console.log(
    color(
      DIM,
      `模型: ${terminalText(provider.name)} / ${terminalText(modelId)} · 审批: ${permissionMode}`,
    ),
  );
  if (!interactive && !yolo)
    console.log(
      color(
        DIM,
        "（非交互输入默认使用 read-only；显式传入 --yolo 才允许修改）",
      ),
    );
  console.log(color(DIM, "输入 / 可查看命令，Ctrl+C 中断当前回合。\n"));

  for (;;) {
    const input = (
      terminalPrompt
        ? ((await terminalPrompt.ask({
            placeholder: "描述任务，输入 / 查看命令",
            commands: COMMANDS,
          })) ?? "/exit")
        : await ask(color(CYAN, "› "))
    ).trim();
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
  rl?.close();
}

main().catch((error) => {
  console.error(
    color(RED, `致命错误: ${terminalText(error?.message ?? error)}`),
  );
  process.exit(1);
});
