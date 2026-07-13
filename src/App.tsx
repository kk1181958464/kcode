import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Code2,
  Copy,
  Cpu,
  FileCode2,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  GripVertical,
  LockOpen,
  Minus,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Terminal,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { inferContextWindow, inferReasoningConfig } from "./types";
import {
  AGENT_STATIC_TOKENS,
  compactConversation,
  estimateMessageTokens,
} from "./context";
import type { ContextLedger } from "./context";
import type {
  AgentActivity,
  AgentCheckpoint,
  AgentToolName,
  BrowserRecordingFile,
  ChatMessage,
  ContextFile,
  ModelConfig,
  ProviderConfig,
  PermissionMode,
  PermissionPolicy,
  ReasoningEffort,
  WorkspaceFolder,
  GitWorkspaceState,
  ImageAttachment,
  ReasoningMode,
} from "./types";

const uid = () => crypto.randomUUID();
type SettingsSection = "general" | "models" | "permissions" | "recordings";
type TaskRecord = {
  id: string;
  name: string;
  workspacePath: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  activities: AgentActivity[];
  modelSelection?: string;
  reasoningEffort?: ReasoningEffort;
  runningId?: string;
  startedAt?: number;
  usage?: { input: number; output: number; cached: number };
  usageResolved?: boolean;
  contextSummary?: string;
  compactedMessageCount?: number;
  contextLedger?: ContextLedger;
  pendingTokenEstimate?: number;
  pendingCalibrationKey?: string;
  summarySnapshots?: {
    id: string;
    createdAt: number;
    summary: string;
    ledger: ContextLedger;
    modelGenerated: boolean;
    durationMs?: number;
    usage?: { input: number; output: number };
  }[];
  imageSemantics?: Record<string, string>;
  summaryMeta?: {
    modelGenerated: boolean;
    durationMs: number;
    usage?: { input: number; output: number };
  };
  durationMs?: number;
  usedContextCount?: number;
};
const initialTask = (): TaskRecord => ({
  id: uid(),
  name: "kcode",
  workspacePath: "D:\\project\\kcode",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
  activities: [],
  reasoningEffort: "auto",
});
function storedTasks(): TaskRecord[] {
  try {
    return (
      JSON.parse(localStorage.getItem("kcode.tasks") || "[]") as TaskRecord[]
    ).map((task) => ({ ...task, runningId: undefined, startedAt: undefined }));
  } catch {
    return [];
  }
}
function storedActiveTask() {
  const all = storedTasks();
  return (
    all.find(
      (task) => task.id === localStorage.getItem("kcode.activeTaskId"),
    ) ?? all[0]
  );
}
const effortLabels: Record<ReasoningEffort, string> = {
  auto: "自动",
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  thinking: "思考",
};
const savedEfforts: ReasoningEffort[] = [
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "thinking",
];
const policyForMode = (mode: PermissionMode): PermissionPolicy =>
  Object.fromEntries(
    [
      "workspaceWrite",
      "deletePaths",
      "runCommands",
      "longRunningProcesses",
      "network",
      "gitPublish",
    ].map((key) => [
      key,
      mode === "full-access"
        ? "allow"
        : mode === "read-only"
          ? "deny"
          : "confirm",
    ]),
  ) as PermissionPolicy;
function reasoningEffortsForModel(model?: ModelConfig): ReasoningEffort[] {
  if (!model) return ["auto"];
  return model.reasoningEfforts?.length
    ? model.reasoningEfforts
    : (inferReasoningConfig(model.modelId, model.protocol).reasoningEfforts ?? [
        "auto",
      ]);
}
function normalizeEffort(
  effort: ReasoningEffort,
  supported: ReasoningEffort[],
): ReasoningEffort {
  if (supported.includes(effort)) return effort;
  if (effort === "max" && supported.includes("xhigh")) return "xhigh";
  if (supported.includes("medium")) return "medium";
  return supported[0] ?? "auto";
}
const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const formatDuration = (milliseconds: number) =>
  milliseconds < 1000
    ? "<1 秒"
    : `${Math.floor(milliseconds / 60000) ? `${Math.floor(milliseconds / 60000)} 分 ` : ""}${Math.floor((milliseconds % 60000) / 1000)} 秒`;
function storedTokenCalibration(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem("kcode.tokenCalibration") || "{}");
  } catch {
    return {};
  }
}
const previewProviders: ProviderConfig[] = [
  {
    id: "preview-openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com",
    protocol: "openai-responses",
    enabled: true,
    hasApiKey: true,
    models: [
      {
        id: "preview-openai:gpt",
        modelId: "gpt-5",
        displayName: "GPT-5",
        protocol: "openai-responses",
      },
      {
        id: "preview-openai:gpt-5.5",
        modelId: "gpt-5.5",
        displayName: "GPT-5.5",
        protocol: "openai-responses",
      },
      {
        id: "preview-openai:gpt-5.6-sol",
        modelId: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        protocol: "openai-responses",
      },
    ],
  },
  {
    id: "preview-anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    protocol: "anthropic-messages",
    enabled: true,
    hasApiKey: true,
    models: [
      {
        id: "preview-anthropic:claude",
        modelId: "claude-sonnet",
        displayName: "Claude Sonnet",
        protocol: "anthropic-messages",
      },
    ],
  },
  {
    id: "preview-chat",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    protocol: "openai-chat",
    enabled: true,
    hasApiKey: true,
    models: [
      {
        id: "preview-chat:deepseek",
        modelId: "deepseek/deepseek-chat-v3",
        displayName: "DeepSeek Chat V3",
        protocol: "openai-chat",
      },
    ],
  },
];

function ProviderModal({
  initial,
  onClose,
  onSaved,
}: {
  initial?: ProviderConfig;
  onClose(): void;
  onSaved(items: ProviderConfig[]): void;
}) {
  const [provider, setProvider] = useState<ProviderConfig>(
    initial ?? {
      id: uid(),
      name: "",
      baseUrl: "",
      protocol: "openai-chat",
      enabled: true,
      hasApiKey: false,
      models: [],
    },
  );
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncedModelCount, setSyncedModelCount] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const patch = (next: Partial<ProviderConfig>) =>
    setProvider((value) => ({ ...value, ...next }));

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) =>
      event.key === "Escape" && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    setSyncedModelCount(null);
  }, [apiKey, provider.baseUrl, provider.protocol]);

  async function save() {
    if (!provider.name.trim() || !provider.baseUrl.trim())
      return setError("请填写供应商名称和 Base URL");
    setBusy(true);
    setError("");
    try {
      onSaved(await window.kcode.providers.save(provider, apiKey || undefined));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function addModel() {
    if (!modelId.trim()) return;
    const model: ModelConfig = {
      id: `${provider.id}:${modelId.trim()}`,
      modelId: modelId.trim(),
      displayName: modelId.trim(),
      protocol: provider.protocol,
      ...inferReasoningConfig(modelId.trim(), provider.protocol),
      contextWindow: inferContextWindow(modelId.trim()),
    };
    patch({
      models: [
        ...provider.models.filter((m) => m.modelId !== model.modelId),
        model,
      ],
    });
    setModelId("");
  }
  async function discover() {
    setSyncing(true);
    setSyncedModelCount(null);
    setError("");
    try {
      await window.kcode.providers.save(provider, apiKey || undefined);
      const discovered = await window.kcode.providers.discover(provider.id);
      const models = discovered.map((model) => {
        const existing = provider.models.find(
          (item) => item.modelId === model.modelId,
        );
        return existing
          ? {
              ...model,
              contextWindow: existing.contextWindow ?? model.contextWindow,
              reasoningMode: existing.reasoningMode ?? model.reasoningMode,
              reasoningEfforts:
                existing.reasoningEfforts ?? model.reasoningEfforts,
            }
          : model;
      });
      patch({ models });
      setSyncedModelCount(models.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }
  async function remove() {
    if (!initial) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    if (!window.kcode) {
      setError("浏览器预览不会删除本地供应商配置");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onSaved(await window.kcode.providers.remove(initial.id));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-title"
      >
        <header>
          <div>
            <span className="eyebrow">模型通道</span>
            <h2 id="provider-title">{initial ? "编辑供应商" : "添加供应商"}</h2>
          </div>
          <button
            className="icon"
            onClick={onClose}
            title="关闭"
            aria-label="关闭供应商设置"
          >
            <X size={18} />
          </button>
        </header>
        <div className="form-grid">
          <label>
            名称
            <input
              autoFocus
              value={provider.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="例如 DeepSeek"
            />
          </label>
          <label>
            协议
            <select
              value={provider.protocol}
              onChange={(e) => {
                const protocol = e.target.value as ProviderConfig["protocol"];
                patch({
                  protocol,
                  models: provider.models.map((model) => ({
                    ...model,
                    protocol,
                  })),
                });
              }}
            >
              <option value="openai-responses">OpenAI Responses API</option>
              <option value="openai-chat">OpenAI Chat Completions</option>
              <option value="anthropic-messages">Anthropic Messages</option>
              <option value="gemini-generate-content">
                Gemini GenerateContent
              </option>
            </select>
          </label>
          <label className="wide">
            Base URL
            <input
              value={provider.baseUrl}
              onChange={(e) => patch({ baseUrl: e.target.value })}
              placeholder="https://api.example.com"
            />
          </label>
          <label className="wide">
            API Key
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                provider.hasApiKey ? "已安全保存，留空则不修改" : "sk-..."
              }
            />
          </label>
        </div>
        <div className="model-editor">
          <div className="section-title">
            <div>
              <h3>可用模型</h3>
              <p>从服务端同步模型列表，也可手动添加模型 ID。</p>
            </div>
            <div className="model-sync-area">
              {syncedModelCount !== null && (
                <span className="sync-result">
                  <CheckCircle2 size={13} />
                  {syncedModelCount > 0
                    ? `已同步 ${syncedModelCount} 个`
                    : "未发现模型"}
                </span>
              )}
              <button
                className="sync-models"
                disabled={syncing || busy || (!apiKey && !provider.hasApiKey)}
                onClick={discover}
              >
                <RefreshCw size={14} className={syncing ? "spinning" : ""} />
                {syncing ? "同步中" : "同步模型"}
              </button>
            </div>
          </div>
          <div className="model-add">
            <input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addModel()}
              placeholder="模型 ID，例如 deepseek-chat"
            />
            <button className="icon framed" onClick={addModel} title="添加模型">
              <Plus size={17} />
            </button>
          </div>
          <div className="model-list">
            {provider.models.length === 0 ? (
              <p className="empty">尚未添加模型</p>
            ) : (
              provider.models.map((model) => (
                <div className="provider-model-row" key={model.id}>
                  <Cpu size={15} />
                  <span className="provider-model-name">
                    {model.displayName}
                  </span>
                  <label
                    className="provider-model-context"
                    title="此模型在 Agent 中可使用的上下文窗口"
                  >
                    <span>上下文</span>
                    <input
                      type="number"
                      min="1024"
                      step="1024"
                      value={
                        model.contextWindow ??
                        inferContextWindow(model.modelId) ??
                        ""
                      }
                      placeholder="未配置"
                      onChange={(event) => {
                        const value = event.target.value;
                        patch({
                          models: provider.models.map((item) =>
                            item.id === model.id
                              ? {
                                  ...item,
                                  contextWindow: value
                                    ? Math.max(1024, Math.round(Number(value)))
                                    : undefined,
                                }
                              : item,
                          ),
                        });
                      }}
                    />
                    <small>Token</small>
                  </label>
                  <button
                    className="icon"
                    onClick={() =>
                      patch({
                        models: provider.models.filter(
                          (m) => m.id !== model.id,
                        ),
                      })
                    }
                    title="移除"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <footer>
          {initial ? (
            <button
              className={`danger-button ${confirmingDelete ? "confirm" : ""}`}
              disabled={busy || syncing}
              onClick={remove}
            >
              <Trash2 size={14} />
              {confirmingDelete ? "再次点击确认删除" : "删除供应商"}
            </button>
          ) : (
            <label className="toggle">
              <input
                type="checkbox"
                checked={provider.enabled}
                onChange={(e) => patch({ enabled: e.target.checked })}
              />
              <span />
              启用此供应商
            </label>
          )}
          <div>
            {initial && (
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={provider.enabled}
                  onChange={(e) => patch({ enabled: e.target.checked })}
                />
                <span />
                启用
              </label>
            )}
            <button className="secondary" onClick={onClose}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy || syncing}
              onClick={save}
            >
              {busy ? "处理中..." : "保存"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function SettingsPanel({
  providers,
  setProviders,
  initialSection,
  reasoningEfforts,
  defaultReasoningEffort,
  onDefaultReasoningEffortChange,
  autoFollowEnabled,
  onAutoFollowChange,
  statusPanelEnabled,
  onStatusPanelChange,
  permissionMode,
  onPermissionModeChange,
  permissionPolicy,
  onPermissionPolicyChange,
  onClose,
}: {
  providers: ProviderConfig[];
  setProviders(v: ProviderConfig[]): void;
  initialSection: SettingsSection;
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
  onDefaultReasoningEffortChange(value: ReasoningEffort): void;
  autoFollowEnabled: boolean;
  onAutoFollowChange(value: boolean): void;
  statusPanelEnabled: boolean;
  onStatusPanelChange(value: boolean): void;
  permissionMode: PermissionMode;
  onPermissionModeChange(value: PermissionMode): void;
  permissionPolicy: PermissionPolicy;
  onPermissionPolicyChange(value: PermissionPolicy): void;
  onClose(): void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [editing, setEditing] = useState<ProviderConfig | undefined>();
  const [adding, setAdding] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(
    new Set(),
  );
  const [confirmingProvider, setConfirmingProvider] = useState<string>();
  const [recordings, setRecordings] = useState<BrowserRecordingFile[]>([]);
  useEffect(() => {
    if (section === "recordings" && window.kcode?.browser)
      void window.kcode.browser.recordings().then(setRecordings);
  }, [section]);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) =>
      event.key === "Escape" && !adding && !editing && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [adding, editing, onClose]);
  async function toggleProvider(
    event: React.MouseEvent,
    provider: ProviderConfig,
  ) {
    event.stopPropagation();
    if (!window.kcode) {
      setProviders(
        providers.map((item) =>
          item.id === provider.id ? { ...item, enabled: !item.enabled } : item,
        ),
      );
      return;
    }
    setProviders(
      await window.kcode.providers.save({
        ...provider,
        enabled: !provider.enabled,
      }),
    );
  }
  async function removeModel(provider: ProviderConfig, modelId: string) {
    const nextProvider = {
      ...provider,
      models: provider.models.filter((model) => model.id !== modelId),
    };
    if (!window.kcode) {
      setProviders(
        providers.map((item) =>
          item.id === provider.id ? nextProvider : item,
        ),
      );
      return;
    }
    setProviders(await window.kcode.providers.save(nextProvider));
  }
  async function updateModelReasoning(
    provider: ProviderConfig,
    modelId: string,
    mode: ReasoningMode,
    efforts?: ReasoningEffort[],
  ) {
    const model = provider.models.find((item) => item.id === modelId);
    if (!model) return;
    const defaults: Record<ReasoningMode, ReasoningEffort[]> = {
      none: ["auto"],
      effort: ["low", "medium", "high", "xhigh"],
      toggle: ["auto", "thinking"],
      budget: ["auto", "low", "medium", "high", "xhigh"],
      fixed: ["thinking"],
    };
    const nextProvider = {
      ...provider,
      models: provider.models.map((item) =>
        item.id === modelId
          ? {
              ...item,
              reasoningMode: mode,
              reasoningEfforts: efforts?.length ? efforts : defaults[mode],
            }
          : item,
      ),
    };
    if (!window.kcode)
      setProviders(
        providers.map((item) =>
          item.id === provider.id ? nextProvider : item,
        ),
      );
    else setProviders(await window.kcode.providers.save(nextProvider));
  }
  async function updateModelContext(
    provider: ProviderConfig,
    modelId: string,
    contextWindow?: number,
  ) {
    const nextProvider = {
      ...provider,
      models: provider.models.map((item) =>
        item.id === modelId
          ? {
              ...item,
              contextWindow:
                contextWindow && contextWindow > 0
                  ? Math.max(1024, Math.round(contextWindow))
                  : undefined,
            }
          : item,
      ),
    };
    if (!window.kcode)
      setProviders(
        providers.map((item) =>
          item.id === provider.id ? nextProvider : item,
        ),
      );
    else setProviders(await window.kcode.providers.save(nextProvider));
  }
  async function removeProvider(provider: ProviderConfig) {
    if (confirmingProvider !== provider.id) {
      setConfirmingProvider(provider.id);
      return;
    }
    if (!window.kcode)
      setProviders(providers.filter((item) => item.id !== provider.id));
    else setProviders(await window.kcode.providers.remove(provider.id));
    setConfirmingProvider(undefined);
    setExpandedProviders((current) => {
      const next = new Set(current);
      next.delete(provider.id);
      return next;
    });
  }
  return (
    <div
      className="settings-layer"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside className="settings-panel" aria-label="设置">
        <header>
          <div>
            <span className="eyebrow">KCode</span>
            <h2>设置</h2>
            <p>管理工作台偏好、模型通道与操作权限。</p>
          </div>
          <button
            className="icon"
            onClick={onClose}
            title="关闭"
            aria-label="关闭设置"
          >
            <X size={18} />
          </button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分区">
            <button
              className={section === "general" ? "active" : ""}
              onClick={() => setSection("general")}
            >
              <SlidersHorizontal size={16} />
              <span>通用</span>
            </button>
            <button
              className={section === "models" ? "active" : ""}
              onClick={() => setSection("models")}
            >
              <Cpu size={16} />
              <span>模型</span>
              <small>
                {providers.filter((provider) => provider.enabled).length}
              </small>
            </button>
            <button
              className={section === "permissions" ? "active" : ""}
              onClick={() => setSection("permissions")}
            >
              <ShieldCheck size={16} />
              <span>权限</span>
            </button>
            <button
              className={section === "recordings" ? "active" : ""}
              onClick={() => setSection("recordings")}
            >
              <RefreshCw size={16} />
              <span>录制</span>
              <small>{recordings.length || ""}</small>
            </button>
          </nav>
          <div className="settings-content">
            {section === "recordings" && (
              <section className="settings-section">
                <div className="settings-section-header">
                  <h3>网页录制</h3>
                  <p>管理已完成和中断自动保存的录制文件。</p>
                </div>
                <div className="settings-group recording-history">
                  {recordings.length ? (
                    recordings.map((item) => (
                      <div className="settings-row" key={item.id}>
                        <span>
                          <strong>{item.name}</strong>
                          <small>
                            {item.status === "interrupted"
                              ? "中断保存"
                              : "已完成"}{" "}
                            · {item.operations} 个操作 · {item.requests} 个请求
                            · {new Date(item.startedAt).toLocaleString()}
                          </small>
                        </span>
                        <div className="recording-actions">
                          <button
                            className="icon"
                            title="打开文件位置"
                            onClick={() =>
                              void window.kcode.browser.revealRecording(item.id)
                            }
                          >
                            <FolderOpen size={14} />
                          </button>
                          <button
                            className="icon danger"
                            title="删除录制"
                            onClick={() =>
                              void window.kcode.browser
                                .removeRecording(item.id)
                                .then(setRecordings)
                            }
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="settings-empty">暂无网页录制</div>
                  )}
                </div>
              </section>
            )}
            {section === "general" && (
              <section className="settings-section">
                <div className="settings-section-header">
                  <h3>通用</h3>
                  <p>调整当前工作台的默认行为。</p>
                </div>
                <div className="settings-group">
                  <div className="settings-row">
                    <span>
                      <strong>默认推理强度</strong>
                      <small>新任务优先使用的推理设置</small>
                    </span>
                    <div className="settings-segmented">
                      {reasoningEfforts.map((effort) => (
                        <button
                          key={effort}
                          className={
                            defaultReasoningEffort === effort ? "active" : ""
                          }
                          onClick={() => onDefaultReasoningEffortChange(effort)}
                        >
                          {effortLabels[effort]}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-row">
                    <span>
                      <strong>流式输出自动跟随</strong>
                      <small>生成内容时保持在最新位置</small>
                    </span>
                    <button
                      className={`setting-switch ${autoFollowEnabled ? "on" : ""}`}
                      role="switch"
                      aria-checked={autoFollowEnabled}
                      onClick={() => onAutoFollowChange(!autoFollowEnabled)}
                    >
                      <span />
                    </button>
                  </div>
                  <div className="settings-row">
                    <span>
                      <strong>任务状态栏</strong>
                      <small>在工作台右侧显示目标和用量</small>
                    </span>
                    <button
                      className={`setting-switch ${statusPanelEnabled ? "on" : ""}`}
                      role="switch"
                      aria-checked={statusPanelEnabled}
                      onClick={() => onStatusPanelChange(!statusPanelEnabled)}
                    >
                      <span />
                    </button>
                  </div>
                  <div className="settings-row">
                    <span>
                      <strong>诊断日志</strong>
                      <small>查看主进程、模型请求和界面崩溃记录</small>
                    </span>
                    <button
                      className="secondary"
                      onClick={() => void window.kcode.logs.reveal()}
                    >
                      <FolderOpen size={14} />
                      打开日志目录
                    </button>
                  </div>
                </div>
                <div className="permission-detail-list">
                  {(
                    [
                      ["workspaceWrite", "工作区文件修改"],
                      ["deletePaths", "删除文件"],
                      ["runCommands", "运行命令"],
                      ["longRunningProcesses", "长期进程"],
                      ["network", "网络访问"],
                      ["gitPublish", "Git 提交与推送"],
                    ] as [keyof PermissionPolicy, string][]
                  ).map(([key, label]) => (
                    <label key={key}>
                      <span>{label}</span>
                      <select
                        value={permissionPolicy[key]}
                        onChange={(event) =>
                          onPermissionPolicyChange({
                            ...permissionPolicy,
                            [key]: event.target
                              .value as PermissionPolicy[typeof key],
                          })
                        }
                      >
                        <option value="allow">允许</option>
                        <option value="confirm">每次确认</option>
                        <option value="deny">禁止</option>
                      </select>
                    </label>
                  ))}
                </div>
              </section>
            )}
            {section === "models" && (
              <section className="settings-section">
                <div className="settings-section-header with-action">
                  <div>
                    <h3>模型</h3>
                    <p>
                      配置 Responses、Chat Completions、Anthropic Messages 和
                      Gemini 通道。
                    </p>
                  </div>
                  <button
                    className="add-provider"
                    onClick={() => setAdding(true)}
                  >
                    <Plus size={16} />
                    添加供应商
                  </button>
                </div>
                <div className="provider-list">
                  {providers.map((p) => (
                    <div key={p.id} className="provider-block">
                      <div
                        className={`provider-row ${p.enabled ? "" : "disabled"}`}
                      >
                        <button
                          className="provider-main"
                          onClick={() => setEditing(p)}
                        >
                          <span
                            className={`provider-mark ${p.enabled ? "active" : ""}`}
                          >
                            <Cpu size={17} />
                          </span>
                          <span>
                            <strong>{p.name}</strong>
                            <small>
                              {p.models.length} 个模型 ·{" "}
                              {p.protocol === "openai-responses"
                                ? "Responses"
                                : p.protocol === "openai-chat"
                                  ? "Chat Completions"
                                  : p.protocol === "anthropic-messages"
                                    ? "Anthropic Messages"
                                    : "Gemini"}
                            </small>
                          </span>
                          <span
                            className={`status ${p.hasApiKey ? "connected" : ""}`}
                          >
                            <i />
                            {p.hasApiKey ? "已连接" : "未配置"}
                          </span>
                        </button>
                        <div className="provider-actions">
                          {p.models.length > 0 && (
                            <button
                              className="provider-expand"
                              title={
                                expandedProviders.has(p.id)
                                  ? "收起模型"
                                  : "展开模型"
                              }
                              aria-expanded={expandedProviders.has(p.id)}
                              onClick={() =>
                                setExpandedProviders((current) => {
                                  const next = new Set(current);
                                  next.has(p.id)
                                    ? next.delete(p.id)
                                    : next.add(p.id);
                                  return next;
                                })
                              }
                            >
                              <ChevronDown size={15} />
                            </button>
                          )}
                          <button
                            className={`switch ${p.enabled ? "on" : ""}`}
                            role="switch"
                            aria-checked={p.enabled}
                            aria-label={`${p.enabled ? "停用" : "启用"} ${p.name}`}
                            onClick={(event) => void toggleProvider(event, p)}
                          >
                            <span />
                          </button>
                          <button
                            className={`remove-provider ${confirmingProvider === p.id ? "confirm" : ""}`}
                            title={
                              confirmingProvider === p.id
                                ? `确认删除 ${p.name}`
                                : `删除供应商 ${p.name}`
                            }
                            aria-label={
                              confirmingProvider === p.id
                                ? `确认删除 ${p.name}`
                                : `删除供应商 ${p.name}`
                            }
                            onBlur={() => setConfirmingProvider(undefined)}
                            onClick={() => void removeProvider(p)}
                          >
                            {confirmingProvider === p.id ? (
                              <Check size={14} />
                            ) : (
                              <Trash2 size={14} />
                            )}
                          </button>
                        </div>
                      </div>
                      {p.models.length > 0 && expandedProviders.has(p.id) && (
                        <div className="settings-model-list">
                          {p.models.map((model) => (
                            <div key={model.id}>
                              <span className="settings-model-icon">
                                <Cpu size={13} />
                              </span>
                              <span>
                                <strong>{model.displayName}</strong>
                                <small>{model.modelId}</small>
                              </span>
                              <div className="model-reasoning-config">
                                <label
                                  className="model-context-input"
                                  title="上下文窗口（Token）"
                                >
                                  <span>上下文</span>
                                  <input
                                    type="number"
                                    min="1024"
                                    step="1024"
                                    placeholder="未配置"
                                    defaultValue={
                                      model.contextWindow ??
                                      inferContextWindow(model.modelId) ??
                                      ""
                                    }
                                    onBlur={(event) =>
                                      void updateModelContext(
                                        p,
                                        model.id,
                                        event.target.value
                                          ? Number(event.target.value)
                                          : undefined,
                                      )
                                    }
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter")
                                        event.currentTarget.blur();
                                    }}
                                  />
                                </label>
                                <select
                                  value={
                                    model.reasoningMode ??
                                    inferReasoningConfig(
                                      model.modelId,
                                      model.protocol,
                                    ).reasoningMode
                                  }
                                  onChange={(event) =>
                                    void updateModelReasoning(
                                      p,
                                      model.id,
                                      event.target.value as ReasoningMode,
                                    )
                                  }
                                  title="推理模式"
                                >
                                  <option value="none">无推理配置</option>
                                  <option value="effort">原生强度</option>
                                  <option value="toggle">思考开关</option>
                                  <option value="budget">思考预算</option>
                                  <option value="fixed">固定思考</option>
                                </select>
                                <div className="model-effort-toggles">
                                  {savedEfforts.map((effort) => {
                                    const configured = model.reasoningEfforts ??
                                      inferReasoningConfig(
                                        model.modelId,
                                        model.protocol,
                                      ).reasoningEfforts ?? ["auto"];
                                    return (
                                      <button
                                        key={effort}
                                        className={
                                          configured.includes(effort)
                                            ? "active"
                                            : ""
                                        }
                                        onClick={() => {
                                          const next = configured.includes(
                                            effort,
                                          )
                                            ? configured.filter(
                                                (item) => item !== effort,
                                              )
                                            : [...configured, effort];
                                          if (next.length)
                                            void updateModelReasoning(
                                              p,
                                              model.id,
                                              model.reasoningMode ??
                                                inferReasoningConfig(
                                                  model.modelId,
                                                  model.protocol,
                                                ).reasoningMode ??
                                                "none",
                                              next,
                                            );
                                        }}
                                      >
                                        {effortLabels[effort]}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                              <button
                                className="remove-model"
                                title={`删除模型 ${model.displayName}`}
                                aria-label={`删除模型 ${model.displayName}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void removeModel(p, model.id);
                                }}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}
            {section === "permissions" && (
              <section className="settings-section">
                <div className="settings-section-header">
                  <h3>权限</h3>
                  <p>设置 Agent 对当前工作区的默认操作边界。</p>
                </div>
                <div
                  className="permission-options"
                  role="radiogroup"
                  aria-label="默认权限策略"
                >
                  <button
                    role="radio"
                    aria-checked={permissionMode === "confirm"}
                    className={permissionMode === "confirm" ? "active" : ""}
                    onClick={() => onPermissionModeChange("confirm")}
                  >
                    <span className="permission-option-icon">
                      <ShieldCheck size={17} />
                    </span>
                    <span>
                      <strong>变更前确认</strong>
                      <small>写入文件或运行命令前请求确认</small>
                    </span>
                    {permissionMode === "confirm" && <Check size={15} />}
                  </button>
                  <button
                    role="radio"
                    aria-checked={permissionMode === "read-only"}
                    className={permissionMode === "read-only" ? "active" : ""}
                    onClick={() => onPermissionModeChange("read-only")}
                  >
                    <span className="permission-option-icon">
                      <FileCode2 size={17} />
                    </span>
                    <span>
                      <strong>只读模式</strong>
                      <small>允许读取和分析，不执行修改操作</small>
                    </span>
                    {permissionMode === "read-only" && <Check size={15} />}
                  </button>
                  <button
                    role="radio"
                    aria-checked={permissionMode === "full-access"}
                    className={
                      permissionMode === "full-access" ? "active danger" : ""
                    }
                    onClick={() => onPermissionModeChange("full-access")}
                  >
                    <span className="permission-option-icon">
                      <LockOpen size={17} />
                    </span>
                    <span>
                      <strong>完全访问</strong>
                      <small>允许直接写入文件和运行命令，无需逐次确认</small>
                    </span>
                    {permissionMode === "full-access" && <Check size={15} />}
                  </button>
                </div>
              </section>
            )}
          </div>
        </div>
        {(adding || editing) && (
          <ProviderModal
            initial={editing}
            onClose={() => {
              setAdding(false);
              setEditing(undefined);
            }}
            onSaved={setProviders}
          />
        )}
      </aside>
    </div>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
        pre: ({ children }) => {
          const code = String(
            (children as { props?: { children?: unknown } })?.props?.children ??
              "",
          ).replace(/\n$/, "");
          return (
            <div className="code-block">
              <div className="code-toolbar">
                <span>
                  <Code2 size={13} />
                  代码
                </span>
                <button
                  title="复制代码"
                  onClick={() => void navigator.clipboard.writeText(code)}
                >
                  <Copy size={13} />
                  复制
                </button>
              </div>
              <pre>{children}</pre>
            </div>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function MessageItem({
  message,
  running,
  onRetry,
  attachments = [],
}: {
  message: ChatMessage;
  running: boolean;
  onRetry(): void;
  attachments?: ContextFile[];
}) {
  const [previewImage, setPreviewImage] = useState<ImageAttachment>();
  const isError =
    message.role === "assistant" && message.content.startsWith("请求失败：");
  return (
    <article className={`message ${message.role} ${isError ? "failed" : ""}`}>
      <div className={`message-avatar ${message.role}`}>
        {message.role === "user" ? <UserRound size={15} /> : <Bot size={16} />}
      </div>
      <div className="message-content">
        <div className="message-meta">
          <span>
            {message.role === "user" ? "你" : message.model || "Agent"}
          </span>
          {running && (
            <span className="run-state">
              <i />
              生成中
            </span>
          )}
          {isError && (
            <span className="error-state">
              <CircleAlert size={12} />
              执行失败
            </span>
          )}
          <time>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
          <div className="message-actions">
            <button
              title="复制消息"
              onClick={() =>
                void navigator.clipboard.writeText(message.content)
              }
            >
              <Copy size={13} />
            </button>
            {isError && (
              <button title="重试" onClick={onRetry}>
                <RotateCcw size={13} />
              </button>
            )}
          </div>
        </div>
        <div className="message-body">
          {message.images && message.images.length > 0 && (
            <div className="message-images">
              {message.images.map((image) => (
                <button
                  key={image.id}
                  type="button"
                  onClick={() => setPreviewImage(image)}
                  title={`查看原图：${image.name}`}
                >
                  <img src={image.dataUrl} alt={image.name} />
                </button>
              ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="message-attachments">
              {attachments.map((file) => (
                <span key={file.id} title={file.name}>
                  <FileCode2 size={12} />
                  {file.name}
                </span>
              ))}
            </div>
          )}
          {message.content ? (
            message.role === "assistant" && !isError ? (
              <MarkdownMessage content={message.content} />
            ) : (
              message.content
            )
          ) : running ? (
            <div className="thinking">
              <span />
              <span />
              <span />
              正在思考
            </div>
          ) : null}
        </div>
      </div>
      {previewImage && (
        <div
          className="image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`查看图片 ${previewImage.name}`}
          onMouseDown={(event) =>
            event.target === event.currentTarget && setPreviewImage(undefined)
          }
        >
          <div className="image-lightbox-content">
            <button
              className="image-lightbox-close"
              type="button"
              title="关闭"
              onClick={() => setPreviewImage(undefined)}
            >
              <X size={18} />
            </button>
            <img src={previewImage.dataUrl} alt={previewImage.name} />
            <span>{previewImage.name}</span>
          </div>
        </div>
      )}
    </article>
  );
}

function ActivityItem({
  activity,
  requestId,
  workspacePath,
  onActivityChange,
}: {
  activity: AgentActivity;
  requestId?: string;
  workspacePath: string;
  onActivityChange(activity: AgentActivity): void;
}) {
  const [expanded, setExpanded] = useState(activity.status === "waiting");
  const [undoing, setUndoing] = useState(false);
  const [restoreConflict, setRestoreConflict] = useState(false);
  const pending = activity.status === "waiting";
  const detail = activity.diff || activity.output;
  const readableFailure =
    activity.errorSummary ||
    (activity.output && !/[\uFFFD]{1,}|[□�]{1,}/.test(activity.output)
      ? activity.output
      : activity.tool === "run_command"
        ? "命令执行失败，请查看详细输出。"
        : "工具执行失败，请查看详细输出。");
  useEffect(() => {
    if (activity.status === "failed") setExpanded(true);
  }, [activity.status]);
  async function restore(event?: React.MouseEvent, force = false) {
    event?.stopPropagation();
    if (!window.kcode || undoing || activity.undone) return;
    setUndoing(true);
    const result = await window.kcode.chat.undo(
      workspacePath,
      activity.id,
      force,
    );
    if (result.conflict) setRestoreConflict(true);
    else {
      setRestoreConflict(false);
      onActivityChange({
        ...activity,
        undone: result.success,
        undoable: !result.success,
        output: result.success ? result.message : `恢复失败：${result.message}`,
      });
      if (!result.success) setExpanded(true);
    }
    setUndoing(false);
  }
  return (
    <article className={`agent-activity ${activity.status}`}>
      <div
        className="activity-head"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpanded((value) => !value);
          }
        }}
        aria-expanded={expanded}
      >
        <span className="activity-icon">
          {activity.tool === "run_command" ? (
            <Terminal size={14} />
          ) : (
            <FileCode2 size={14} />
          )}
        </span>
        <span className="activity-title">
          <strong>{activity.title}</strong>
          <small>
            {activity.command ||
              activity.path ||
              String(activity.input.query || "")}
          </small>
        </span>
        {activity.additions !== undefined && (
          <span className="diff-count">
            <b>+{activity.additions}</b>
            <i>-{activity.deletions}</i>
          </span>
        )}
        {activity.undoable && activity.status === "success" && (
          <button
            className="activity-undo"
            disabled={undoing || activity.undone}
            onClick={(event) => void restore(event)}
            title="恢复到本次修改前的版本"
          >
            <RotateCcw size={13} />
            {activity.undone ? "已恢复" : undoing ? "恢复中" : "恢复"}
          </button>
        )}
        <span className="activity-status">
          {pending
            ? "等待确认"
            : activity.status === "running"
              ? "执行中"
              : activity.status === "success"
                ? "完成"
                : activity.status === "denied"
                  ? "已阻止"
                  : "失败"}
        </span>
        <ChevronDown size={14} />
      </div>
      {expanded && (
        <div className="activity-detail">
          {pending && requestId && (
            <div className="approval-actions">
              <span>此操作会修改工作区或执行命令</span>
              <button
                onClick={() =>
                  void window.kcode.chat.approve(requestId, activity.id, false)
                }
              >
                拒绝
              </button>
              <button
                className="allow"
                onClick={() =>
                  void window.kcode.chat.approve(requestId, activity.id, true)
                }
              >
                允许
              </button>
            </div>
          )}
          {activity.status === "failed" && (
            <div className="activity-error-reason">
              <CircleAlert size={14} />
              <span>
                <strong>失败原因</strong>
                <small>{readableFailure}</small>
              </span>
            </div>
          )}
          {detail && activity.errorSummary && (
            <div className="activity-output-label">详细输出</div>
          )}
          {detail && (
            <pre className={activity.diff ? "activity-diff" : ""}>{detail}</pre>
          )}
        </div>
      )}
      {restoreConflict && (
        <div
          className="restore-backdrop"
          onClick={(event) => event.stopPropagation()}
        >
          <div
            className="restore-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`restore-${activity.id}`}
          >
            <div className="restore-dialog-icon">
              <RotateCcw size={17} />
            </div>
            <div>
              <strong id={`restore-${activity.id}`}>文件后来又被修改过</strong>
              <p>
                恢复 <b>{activity.path}</b>{" "}
                会覆盖此版本之后的所有修改。是否仍要恢复到本次修改前？
              </p>
            </div>
            <footer>
              <button onClick={() => setRestoreConflict(false)}>取消</button>
              <button
                className="danger"
                onClick={() => void restore(undefined, true)}
              >
                仍然恢复
              </button>
            </footer>
          </div>
        </div>
      )}
    </article>
  );
}

const fileTools: AgentToolName[] = [
  "write_file",
  "apply_patch",
  "move_path",
  "delete_path",
];
const commandTools: AgentToolName[] = [
  "run_command",
  "start_process",
  "stop_process",
  "diagnostics",
];

function ExecutionSummary({
  activities,
  running,
  requestId,
  workspacePath,
  onActivityChange,
}: {
  activities: AgentActivity[];
  running: boolean;
  requestId?: string;
  workspacePath: string;
  onActivityChange(activity: AgentActivity): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const commands = activities.filter((activity) =>
    commandTools.includes(activity.tool),
  ).length;
  const files = new Set(
    activities
      .filter((activity) => fileTools.includes(activity.tool))
      .map((activity) => activity.path)
      .filter(Boolean),
  ).size;
  const failures = activities.filter(
    (activity) => activity.status === "failed",
  ).length;
  const waiting = activities.some((activity) => activity.status === "waiting");
  useEffect(() => {
    if (waiting) setExpanded(true);
  }, [waiting]);
  if (!activities.length) return null;
  return (
    <section className={`execution-summary ${failures ? "has-failures" : ""}`}>
      <button
        className="execution-summary-head"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="execution-summary-icon">
          {running ? (
            <RefreshCw className="spinning" size={15} />
          ) : (
            <Terminal size={15} />
          )}
        </span>
        <span>
          <strong>{running ? "正在执行" : "执行记录"}</strong>
          <small>
            {commands ? `运行了 ${commands} 个命令` : "已检查工作区"}
            {files ? ` · 修改了 ${files} 个文件` : ""}
            {failures ? ` · ${failures} 项失败` : ""}
          </small>
        </span>
        <ChevronDown size={14} />
      </button>
      {expanded && (
        <div className="execution-summary-detail">
          {activities.map((activity) => (
            <ActivityItem
              key={activity.id}
              activity={activity}
              requestId={requestId}
              workspacePath={workspacePath}
              onActivityChange={onActivityChange}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function FileChangesSummary({ activities }: { activities: AgentActivity[] }) {
  const changed = activities.filter(
    (activity) =>
      fileTools.includes(activity.tool) &&
      activity.status === "success" &&
      activity.path &&
      !activity.undone,
  );
  const grouped = new Map<string, { additions: number; deletions: number }>();
  for (const activity of changed) {
    const key = activity.path!;
    const current = grouped.get(key) ?? { additions: 0, deletions: 0 };
    current.additions += activity.additions ?? 0;
    current.deletions += activity.deletions ?? 0;
    grouped.set(key, current);
  }
  if (!grouped.size) return null;
  const additions = [...grouped.values()].reduce(
    (sum, item) => sum + item.additions,
    0,
  );
  const deletions = [...grouped.values()].reduce(
    (sum, item) => sum + item.deletions,
    0,
  );
  return (
    <section className="file-changes-summary">
      <header>
        <span className="file-changes-icon">
          <FileCode2 size={15} />
        </span>
        <span>
          <strong>已编辑 {grouped.size} 个文件</strong>
          <small>
            <b>+{additions}</b> <i>-{deletions}</i>
          </small>
        </span>
      </header>
      <div>
        {[...grouped.entries()].map(([file, stats]) => (
          <div className="changed-file-row" key={file}>
            <span>{file}</span>
            <small>
              <b>+{stats.additions}</b> <i>-{stats.deletions}</i>
            </small>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function App() {
  const [tasks, setTasks] = useState<TaskRecord[]>(() =>
    localStorage.getItem("kcode.tasks") === null
      ? [initialTask()]
      : storedTasks(),
  );
  const [taskStorageReady, setTaskStorageReady] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState(
    () => localStorage.getItem("kcode.activeTaskId") || "",
  );
  const [pendingFolder, setPendingFolder] = useState<WorkspaceFolder | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<
    | { kind: "workspace"; path: string; name: string; count: number }
    | { kind: "task"; task: TaskRecord }
  >();
  const [newTaskName, setNewTaskName] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("kcode.sidebarWidth"));
    return Number.isFinite(saved) && saved >= 210 && saved <= 420 ? saved : 256;
  });
  const [draggedTaskId, setDraggedTaskId] = useState<string>();
  const [taskDropTarget, setTaskDropTarget] = useState<string>();
  const [draggedWorkspace, setDraggedWorkspace] = useState<string>();
  const [workspaceDropTarget, setWorkspaceDropTarget] = useState<string>();
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(
    () => {
      try {
        return new Set(
          JSON.parse(
            localStorage.getItem("kcode.collapsedWorkspaces") || "[]",
          ) as string[],
        );
      } catch {
        return new Set();
      }
    },
  );
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => storedActiveTask()?.messages ?? [],
  );
  const [activities, setActivities] = useState<AgentActivity[]>(
    () => storedActiveTask()?.activities ?? [],
  );
  const [input, setInput] = useState("");
  const [settings, setSettings] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general");
  const [autoFollowEnabled, setAutoFollowEnabled] = useState(
    () => localStorage.getItem("kcode.autoFollow") !== "false",
  );
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => {
    const saved = localStorage.getItem("kcode.permissionMode");
    return saved === "read-only" || saved === "full-access" ? saved : "confirm";
  });
  const [permissionPolicy, setPermissionPolicy] = useState<PermissionPolicy>(
    () => {
      try {
        return (
          JSON.parse(
            localStorage.getItem("kcode.permissionPolicy") || "null",
          ) ?? policyForMode("confirm")
        );
      } catch {
        return policyForMode("confirm");
      }
    },
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [statusOpen, setStatusOpen] = useState(
    () => localStorage.getItem("kcode.statusPanel") !== "false",
  );
  const [selected, setSelected] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuProvider, setModelMenuProvider] = useState<string>();
  const [providerModelChoices, setProviderModelChoices] = useState<
    Record<string, string>
  >({});
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const [defaultReasoningEffort, setDefaultReasoningEffort] =
    useState<ReasoningEffort>(() => {
      const saved = localStorage.getItem("kcode.defaultReasoningEffort");
      return savedEfforts.includes(saved as ReasoningEffort)
        ? (saved as ReasoningEffort)
        : "auto";
    });
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    () => {
      const saved = localStorage.getItem("kcode.defaultReasoningEffort");
      return savedEfforts.includes(saved as ReasoningEffort)
        ? (saved as ReasoningEffort)
        : "auto";
    },
  );
  const [attachedFiles, setAttachedFiles] = useState<ContextFile[]>([]);
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([]);
  const [contextError, setContextError] = useState("");
  const [usedContextCount, setUsedContextCount] = useState(
    () => storedActiveTask()?.usedContextCount ?? 0,
  );
  const [runningId, setRunningId] = useState<string>();
  const [browserState, setBrowserState] = useState<{
    open: boolean;
    sessionId?: string;
    requestId?: string;
    title?: string;
    url?: string;
    width?: number;
    recording?: boolean;
  }>({ open: false });
  useEffect(() => window.kcode?.browser?.onState(setBrowserState), []);
  const [usage, setUsage] = useState(
    () => storedActiveTask()?.usage ?? { input: 0, output: 0, cached: 0 },
  );
  const [usageResolved, setUsageResolved] = useState(() =>
    Boolean(storedActiveTask()?.usageResolved),
  );
  const [tokenCalibration, setTokenCalibration] = useState<
    Record<string, number>
  >(storedTokenCalibration);
  const [gitState, setGitState] = useState<GitWorkspaceState>({
    available: false,
    files: 0,
    additions: 0,
    deletions: 0,
    summary: "",
    diff: "",
  });
  const [gitDiffOpen, setGitDiffOpen] = useState(false);
  const [gitRefreshing, setGitRefreshing] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string>();
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [checkpoints, setCheckpoints] = useState<AgentCheckpoint[]>([]);
  const [summarizingTasks, setSummarizingTasks] = useState<Set<string>>(
    () => new Set(),
  );
  const [durationMs, setDurationMs] = useState(
    () => storedActiveTask()?.durationMs ?? 0,
  );
  const currentRequest = useRef<string | undefined>(undefined);
  const requestTasksRef = useRef(new Map<string, string>());
  const activeTaskIdRef = useRef(activeTaskId);
  const tasksRef = useRef(tasks);
  const previewTimerRef = useRef<number | undefined>(undefined);
  const followFrameRef = useRef<number | undefined>(undefined);
  const requestStartedRef = useRef<number | undefined>(undefined);
  const contextByMessageRef = useRef(new Map<string, ContextFile[]>());
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const effortPickerRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const conversationRef = useRef<HTMLElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const autoFollowRef = useRef(true);
  const turnRefs = useRef(new Map<string, HTMLDivElement>());
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? tasks[0];
  useEffect(() => {
    if (!window.kcode?.state) {
      setTaskStorageReady(true);
      return;
    }
    let cancelled = false;
    void window.kcode.state
      .load("tasks")
      .then(async (stored) => {
        if (cancelled) return;
        if (Array.isArray(stored)) {
          const loaded = stored as TaskRecord[];
          const selectedTask =
            loaded.find(
              (task) => task.id === localStorage.getItem("kcode.activeTaskId"),
            ) ?? loaded[0];
          setTasks(loaded);
          setActiveTaskId(selectedTask?.id ?? "");
          setMessages(selectedTask?.messages ?? []);
          setActivities(selectedTask?.activities ?? []);
          setRunningId(undefined);
          currentRequest.current = undefined;
        } else await window.kcode.state.save("tasks", tasksRef.current);
        localStorage.removeItem("kcode.tasks");
        setTaskStorageReady(true);
      })
      .catch((error) => {
        if (!cancelled) {
          setContextError(
            `数据库加载失败：${error instanceof Error ? error.message : String(error)}`,
          );
          setTaskStorageReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (window.kcode?.browser)
      void window.kcode.browser.activate(activeTask?.id);
  }, [activeTask?.id]);
  const summaryBusy = Boolean(
    activeTask && summarizingTasks.has(activeTask.id),
  );
  const conversationTurns = useMemo(
    () =>
      messages
        .filter((message) => message.role === "user")
        .map((user) => {
          const index = messages.findIndex((message) => message.id === user.id);
          const assistant = messages
            .slice(index + 1)
            .find((message) => message.role === "assistant");
          return {
            id: user.id,
            question: user.content,
            answer: assistant?.content || "正在生成…",
          };
        }),
    [messages],
  );
  useEffect(() => {
    setActiveTurnId(conversationTurns[0]?.id);
  }, [activeTaskId]);

  function updateActiveTurn(container: HTMLElement) {
    const threshold =
      container.getBoundingClientRect().top +
      Math.min(180, container.clientHeight * 0.3);
    let current = conversationTurns[0]?.id;
    for (const turn of conversationTurns) {
      const element = turnRefs.current.get(turn.id);
      if (element && element.getBoundingClientRect().top <= threshold)
        current = turn.id;
    }
    setActiveTurnId(current);
  }
  const workspaceGroups = useMemo(() => {
    const groups = new Map<string, TaskRecord[]>();
    for (const task of tasks)
      groups.set(task.workspacePath, [
        ...(groups.get(task.workspacePath) ?? []),
        task,
      ]);
    return [...groups.entries()].map(([workspacePath, conversations]) => ({
      workspacePath,
      name: workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || "工作区",
      conversations,
    }));
  }, [tasks]);

  async function refreshGitState() {
    if (!window.kcode?.workspace.gitState || !activeTask?.workspacePath) return;
    setGitRefreshing(true);
    try {
      setGitState(
        await window.kcode.workspace.gitState(activeTask.workspacePath),
      );
    } catch (error) {
      setGitState({
        available: false,
        files: 0,
        additions: 0,
        deletions: 0,
        summary: "",
        diff: "",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setGitRefreshing(false);
    }
  }
  useEffect(() => {
    void refreshGitState();
    setGitDiffOpen(false);
  }, [activeTaskId]);
  useEffect(() => {
    window.kcode?.chat
      .checkpoints?.()
      .then((items) =>
        setCheckpoints(items.filter((item) => item.status !== "done")),
      );
  }, []);
  useEffect(() => {
    if (
      !activities.some(
        (activity) =>
          activity.status === "success" &&
          ["write_file", "apply_patch", "move_path", "delete_path"].includes(
            activity.tool,
          ),
      )
    )
      return;
    const timer = window.setTimeout(() => void refreshGitState(), 300);
    return () => window.clearTimeout(timer);
  }, [activities]);

  useEffect(() => {
    activeTaskIdRef.current = activeTaskId;
  }, [activeTaskId]);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    if (!activeTaskId && tasks[0]) setActiveTaskId(tasks[0].id);
  }, [activeTaskId, tasks]);
  useEffect(() => {
    if (taskStorageReady && window.kcode?.state) {
      const timer = window.setTimeout(
        () =>
          void window.kcode.state
            .save("tasks", tasks)
            .catch((error) =>
              setContextError(
                `数据库保存失败：${error instanceof Error ? error.message : String(error)}`,
              ),
            ),
        250,
      );
      if (activeTaskId)
        localStorage.setItem("kcode.activeTaskId", activeTaskId);
      return () => window.clearTimeout(timer);
    }
    if (!window.kcode?.state)
      localStorage.setItem("kcode.tasks", JSON.stringify(tasks));
    if (activeTaskId) localStorage.setItem("kcode.activeTaskId", activeTaskId);
  }, [tasks, activeTaskId, taskStorageReady]);
  useEffect(() => {
    if (!activeTaskId) return;
    setTasks((all) =>
      all.map((task) =>
        task.id === activeTaskId
          ? { ...task, messages, activities, updatedAt: Date.now() }
          : task,
      ),
    );
  }, [messages, activities, activeTaskId]);

  function openSettings(section: SettingsSection) {
    setSettingsSection(section);
    setSettings(true);
  }

  function updateDefaultReasoningEffort(value: ReasoningEffort) {
    setDefaultReasoningEffort(value);
    localStorage.setItem("kcode.defaultReasoningEffort", value);
    setReasoningEffort(normalizeEffort(value, efforts));
  }

  function selectModel(value: string) {
    setSelected(value);
    if (activeTaskId)
      setTasks((all) =>
        all.map((task) =>
          task.id === activeTaskId
            ? { ...task, modelSelection: value, updatedAt: Date.now() }
            : task,
        ),
      );
  }

  function selectReasoningEffort(value: ReasoningEffort) {
    setReasoningEffort(value);
    if (activeTaskId)
      setTasks((all) =>
        all.map((task) =>
          task.id === activeTaskId
            ? { ...task, reasoningEffort: value, updatedAt: Date.now() }
            : task,
        ),
      );
  }

  function updateAutoFollow(value: boolean) {
    setAutoFollowEnabled(value);
    localStorage.setItem("kcode.autoFollow", String(value));
  }

  function updateStatusPanel(value: boolean) {
    setStatusOpen(value);
    localStorage.setItem("kcode.statusPanel", String(value));
  }

  function updatePermissionMode(value: PermissionMode) {
    setPermissionMode(value);
    localStorage.setItem("kcode.permissionMode", value);
    const policy = policyForMode(value);
    setPermissionPolicy(policy);
    localStorage.setItem("kcode.permissionPolicy", JSON.stringify(policy));
  }
  function updatePermissionPolicy(value: PermissionPolicy) {
    setPermissionPolicy(value);
    localStorage.setItem("kcode.permissionPolicy", JSON.stringify(value));
  }

  function startSidebarResize(event: React.PointerEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    document.body.classList.add("resizing-sidebar");
    const move = (moveEvent: PointerEvent) =>
      setSidebarWidth(
        Math.min(420, Math.max(210, startWidth + moveEvent.clientX - startX)),
      );
    const stop = (upEvent: PointerEvent) => {
      const width = Math.min(
        420,
        Math.max(210, startWidth + upEvent.clientX - startX),
      );
      setSidebarWidth(width);
      localStorage.setItem("kcode.sidebarWidth", String(width));
      document.body.classList.remove("resizing-sidebar");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function reorderTask(targetId: string) {
    if (!draggedTaskId || draggedTaskId === targetId) return;
    setTasks((current) => {
      const from = current.findIndex((task) => task.id === draggedTaskId);
      const to = current.findIndex((task) => task.id === targetId);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  function reorderWorkspace(targetPath: string) {
    if (!draggedWorkspace || draggedWorkspace === targetPath) return;
    setTasks((current) => {
      const paths = [...new Set(current.map((task) => task.workspacePath))];
      const from = paths.indexOf(draggedWorkspace),
        to = paths.indexOf(targetPath);
      if (from < 0 || to < 0) return current;
      paths.splice(to, 0, paths.splice(from, 1)[0]);
      return paths.flatMap((workspacePath) =>
        current.filter((task) => task.workspacePath === workspacePath),
      );
    });
  }

  function toggleWorkspace(workspacePath: string) {
    setCollapsedWorkspaces((current) => {
      const next = new Set(current);
      next.has(workspacePath)
        ? next.delete(workspacePath)
        : next.add(workspacePath);
      localStorage.setItem(
        "kcode.collapsedWorkspaces",
        JSON.stringify([...next]),
      );
      return next;
    });
  }

  async function removeWorkspace(workspacePath: string) {
    const removed = tasks.filter(
      (task) => task.workspacePath === workspacePath,
    );
    if (window.kcode) {
      await Promise.all(
        removed.map((task) => window.kcode.chat.cancelSummary(task.id)),
      );
      const requestIds = removed.flatMap((task) =>
        task.messages
          .filter((message) => message.id.startsWith("assistant:"))
          .map((message) => message.id.slice("assistant:".length)),
      );
      const activityIds = removed.flatMap((task) =>
        task.activities.map((activity) => activity.id),
      );
      await window.kcode.chat.cleanup(requestIds, activityIds);
      requestIds.forEach((id) => requestTasksRef.current.delete(id));
    }
    const nextTasks = tasks.filter(
      (task) => task.workspacePath !== workspacePath,
    );
    setTasks(nextTasks);
    if (activeTask?.workspacePath === workspacePath) {
      const next = nextTasks[0];
      if (next) {
        setActiveTaskId(next.id);
        setMessages(next.messages);
        setActivities(next.activities);
        setRunningId(next.runningId);
        currentRequest.current = next.runningId;
        requestStartedRef.current = next.startedAt;
        setSelected(next.modelSelection || selected);
        setReasoningEffort(next.reasoningEffort || defaultReasoningEffort);
      } else {
        setActiveTaskId("");
        setMessages([]);
        setActivities([]);
        setRunningId(undefined);
        currentRequest.current = undefined;
        requestStartedRef.current = undefined;
        setInput("");
        setAttachedFiles([]);
        setAttachedImages([]);
        setUsage({ input: 0, output: 0, cached: 0 });
        setUsageResolved(false);
        setDurationMs(0);
      }
    }
  }

  useEffect(() => {
    if (!window.kcode) {
      setProviders(previewProviders);
      return;
    }
    window.kcode.providers.list().then(setProviders);
  }, []);
  const models = useMemo(
    () =>
      providers
        .filter((p) => p.enabled)
        .flatMap((p) => p.models.map((m) => ({ provider: p, model: m }))),
    [providers],
  );
  useEffect(() => {
    if (!models.length) {
      setSelected("");
      return;
    }
    const saved = activeTask?.modelSelection;
    const fallback = `${models[0].provider.id}|${models[0].model.id}`;
    const next = models.some((x) => `${x.provider.id}|${x.model.id}` === saved)
      ? saved!
      : models.some((x) => `${x.provider.id}|${x.model.id}` === selected)
        ? selected
        : fallback;
    if (next !== selected) setSelected(next);
    if (activeTask && activeTask.modelSelection !== next)
      setTasks((all) =>
        all.map((task) =>
          task.id === activeTask.id ? { ...task, modelSelection: next } : task,
        ),
      );
  }, [models, selected]);
  useEffect(() => {
    const closeMenus = (event: MouseEvent) => {
      if (
        modelPickerRef.current &&
        !modelPickerRef.current.contains(event.target as Node)
      )
        setModelMenuOpen(false);
      if (
        effortPickerRef.current &&
        !effortPickerRef.current.contains(event.target as Node)
      )
        setEffortMenuOpen(false);
    };
    document.addEventListener("mousedown", closeMenus);
    return () => document.removeEventListener("mousedown", closeMenus);
  }, []);
  useEffect(() => {
    if (!runningId) return;
    const update = () =>
      requestStartedRef.current &&
      setDurationMs(Date.now() - requestStartedRef.current);
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [runningId]);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void startNewTask();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);
  useEffect(
    () =>
      window.kcode?.chat.onEvent((id, event) => {
        const taskId = requestTasksRef.current.get(id);
        if (!taskId) return;
        const isActive = taskId === activeTaskIdRef.current;
        if (event.type === "activity") {
          const updateActivities = (all: AgentActivity[]) => {
            const exists = all.some((item) => item.id === event.activity.id);
            return exists
              ? all.map((item) =>
                  item.id === event.activity.id ? event.activity : item,
                )
              : [...all, event.activity];
          };
          setTasks((all) =>
            all.map((task) =>
              task.id === taskId
                ? {
                    ...task,
                    activities: updateActivities(task.activities),
                    updatedAt: Date.now(),
                  }
                : task,
            ),
          );
          if (isActive) setActivities(updateActivities);
          return;
        }
        if (event.type === "text") {
          const updateMessages = (all: ChatMessage[]) =>
            all.map((m) =>
              m.id === `assistant:${id}`
                ? { ...m, content: m.content + event.delta }
                : m,
            );
          setTasks((all) =>
            all.map((task) =>
              task.id === taskId
                ? {
                    ...task,
                    messages: updateMessages(task.messages),
                    updatedAt: Date.now(),
                  }
                : task,
            ),
          );
          if (isActive) setMessages(updateMessages);
        }
        if (event.type === "usage") {
          const nextUsage = {
            input: event.input,
            output: event.output,
            cached: event.cached ?? 0,
          };
          const task = tasksRef.current.find((item) => item.id === taskId);
          if (
            event.input > 0 &&
            task?.pendingTokenEstimate &&
            task.pendingCalibrationKey
          ) {
            const observed = Math.min(
              2.5,
              Math.max(0.5, event.input / task.pendingTokenEstimate),
            );
            setTokenCalibration((current) => {
              const previous = current[task.pendingCalibrationKey!] ?? 1;
              const next = {
                ...current,
                [task.pendingCalibrationKey!]:
                  Math.round((previous * 0.75 + observed * 0.25) * 1000) / 1000,
              };
              localStorage.setItem(
                "kcode.tokenCalibration",
                JSON.stringify(next),
              );
              return next;
            });
          }
          setTasks((all) =>
            all.map((item) =>
              item.id === taskId
                ? {
                    ...item,
                    usage: nextUsage,
                    usageResolved: true,
                    pendingTokenEstimate: undefined,
                    pendingCalibrationKey: undefined,
                  }
                : item,
            ),
          );
          if (isActive) {
            setUsage(nextUsage);
            setUsageResolved(true);
          }
        }
        if (event.type === "error") {
          const updateMessages = (all: ChatMessage[]) =>
            all.map((m) =>
              m.id === `assistant:${id}`
                ? { ...m, content: `请求失败：${event.message}` }
                : m,
            );
          setTasks((all) =>
            all.map((task) =>
              task.id === taskId
                ? {
                    ...task,
                    messages: updateMessages(task.messages),
                    runningId: undefined,
                    updatedAt: Date.now(),
                  }
                : task,
            ),
          );
          if (isActive) setMessages(updateMessages);
          if (isActive && requestStartedRef.current) {
            const value = Date.now() - requestStartedRef.current;
            setDurationMs(value);
            setTasks((all) =>
              all.map((task) =>
                task.id === taskId ? { ...task, durationMs: value } : task,
              ),
            );
          }
          if (isActive) {
            currentRequest.current = undefined;
            setRunningId(undefined);
          }
          setTasks((all) =>
            all.map((task) =>
              task.id === taskId ? { ...task, usageResolved: true } : task,
            ),
          );
          if (isActive) setUsageResolved(true);
          requestTasksRef.current.delete(id);
        }
        if (event.type === "done") {
          setTasks((all) =>
            all.map((task) => {
              if (task.id !== taskId) return task;
              const assistantIndex = task.messages.findIndex(
                (message) => message.id === `assistant:${id}`,
              );
              const assistant = task.messages[assistantIndex];
              const user = [...task.messages.slice(0, assistantIndex)]
                .reverse()
                .find(
                  (message) =>
                    message.role === "user" && message.images?.length,
                );
              const imageSemantics = { ...(task.imageSemantics ?? {}) };
              if (assistant?.content && user?.images)
                for (const image of user.images)
                  imageSemantics[image.id] = assistant.content.slice(0, 4_000);
              return {
                ...task,
                runningId: undefined,
                usageResolved: true,
                imageSemantics,
                updatedAt: Date.now(),
              };
            }),
          );
          if (isActive && requestStartedRef.current) {
            const value = Date.now() - requestStartedRef.current;
            setDurationMs(value);
            setTasks((all) =>
              all.map((task) =>
                task.id === taskId ? { ...task, durationMs: value } : task,
              ),
            );
          }
          if (isActive) {
            currentRequest.current = undefined;
            setRunningId(undefined);
            setUsageResolved(true);
          }
          requestTasksRef.current.delete(id);
        }
      }) ?? (() => undefined),
    [],
  );
  useEffect(() => {
    if (!autoFollowEnabled || !autoFollowRef.current) return;
    if (followFrameRef.current) cancelAnimationFrame(followFrameRef.current);
    followFrameRef.current = requestAnimationFrame(() => {
      const conversation = conversationRef.current;
      if (conversation) conversation.scrollTop = conversation.scrollHeight;
    });
    return () => {
      if (followFrameRef.current) cancelAnimationFrame(followFrameRef.current);
    };
  }, [autoFollowEnabled, messages, activities]);

  async function clearCurrentConversation() {
    const requestId = currentRequest.current;
    if (requestId && window.kcode) await window.kcode.chat.cancel(requestId);
    if (previewTimerRef.current) window.clearInterval(previewTimerRef.current);
    currentRequest.current = undefined;
    setRunningId(undefined);
    setMessages([]);
    setActivities([]);
    setInput("");
    setAttachedFiles([]);
    setAttachedImages([]);
    setContextError("");
    setUsedContextCount(0);
    setUsage({ input: 0, output: 0, cached: 0 });
    setUsageResolved(false);
    setDurationMs(0);
    const currentModelId = models.find(
      (item) => `${item.provider.id}|${item.model.id}` === selected,
    )?.model.modelId;
    setReasoningEffort(
      normalizeEffort(
        defaultReasoningEffort,
        reasoningEffortsForModel(
          models.find((item) => item.model.modelId === currentModelId)?.model,
        ),
      ),
    );
    requestStartedRef.current = undefined;
    contextByMessageRef.current.clear();
    autoFollowRef.current = true;
  }

  async function startNewTask() {
    setContextError("");
    try {
      if (window.kcode && !window.kcode.workspace)
        throw new Error("桌面主进程版本较旧，请重启应用后再试");
      const folder = window.kcode
        ? await window.kcode.workspace.pickFolder()
        : { name: "kcode", path: "D:\\project\\kcode" };
      if (!folder) return;
      setPendingFolder(folder);
      setNewTaskName("");
    } catch (error) {
      setContextError(error instanceof Error ? error.message : String(error));
    }
  }

  async function createTask() {
    if (!pendingFolder) return;
    const now = Date.now();
    const task: TaskRecord = {
      id: uid(),
      name: newTaskName.trim() || pendingFolder.name,
      workspacePath: pendingFolder.path,
      createdAt: now,
      updatedAt: now,
      messages: [],
      activities: [],
      modelSelection: selected,
      reasoningEffort,
    };
    setTasks((all) => [task, ...all]);
    setActiveTaskId(task.id);
    setMessages([]);
    setActivities([]);
    setPendingFolder(null);
    setNewTaskName("");
  }

  async function switchTask(task: TaskRecord) {
    if (task.id === activeTaskId) return;
    currentRequest.current = task.runningId;
    setRunningId(task.runningId);
    requestStartedRef.current = task.startedAt;
    setActiveTaskId(task.id);
    setMessages(task.messages);
    setActivities(task.activities);
    setSelected(task.modelSelection || selected);
    setReasoningEffort(task.reasoningEffort || defaultReasoningEffort);
    setInput("");
    setAttachedFiles([]);
    setUsage(task.usage ?? { input: 0, output: 0, cached: 0 });
    setUsageResolved(Boolean(task.usageResolved));
    setDurationMs(task.durationMs ?? 0);
    setUsedContextCount(task.usedContextCount ?? 0);
    setAttachedImages([]);
    contextByMessageRef.current.clear();
    autoFollowRef.current = true;
  }

  async function createConversation(workspacePath: string) {
    const now = Date.now();
    const task: TaskRecord = {
      id: uid(),
      name: "新对话",
      workspacePath,
      createdAt: now,
      updatedAt: now,
      messages: [],
      activities: [],
      modelSelection: selected,
      reasoningEffort,
    };
    setTasks((all) => [task, ...all]);
    setActiveTaskId(task.id);
    setMessages([]);
    setActivities([]);
    setInput("");
    setAttachedFiles([]);
    setUsage({ input: 0, output: 0, cached: 0 });
    setUsageResolved(false);
    setDurationMs(0);
    setAttachedImages([]);
    currentRequest.current = undefined;
    setRunningId(undefined);
    contextByMessageRef.current.clear();
  }

  async function removeTask(task: TaskRecord) {
    if (window.kcode) {
      await window.kcode.chat.cancelSummary(task.id);
      const requestIds = task.messages
        .filter((message) => message.id.startsWith("assistant:"))
        .map((message) => message.id.slice("assistant:".length));
      await window.kcode.chat.cleanup(
        requestIds,
        task.activities.map((activity) => activity.id),
      );
      requestIds.forEach((id) => requestTasksRef.current.delete(id));
    }
    const nextTasks = tasks.filter((item) => item.id !== task.id);
    setTasks(nextTasks);
    if (task.id === activeTaskId) {
      const next = nextTasks[0];
      if (next) {
        setActiveTaskId(next.id);
        setMessages(next.messages);
        setActivities(next.activities);
        setRunningId(next.runningId);
        currentRequest.current = next.runningId;
        requestStartedRef.current = next.startedAt;
        setSelected(next.modelSelection || selected);
        setReasoningEffort(next.reasoningEffort || defaultReasoningEffort);
      } else {
        setActiveTaskId("");
        setMessages([]);
        setActivities([]);
        setRunningId(undefined);
        currentRequest.current = undefined;
        requestStartedRef.current = undefined;
        setInput("");
        setAttachedFiles([]);
        setAttachedImages([]);
        setUsage({ input: 0, output: 0, cached: 0 });
        setUsageResolved(false);
        setDurationMs(0);
      }
    }
  }

  async function pickContextFiles() {
    setContextError("");
    try {
      const files = window.kcode
        ? await window.kcode.context.pickFiles()
        : [
            {
              id: uid(),
              name: "README.md",
              path: "D:/project/kcode/README.md",
              content: "# KCode\n\nMulti-provider desktop coding agent.",
              size: 55,
            },
          ];
      setAttachedFiles((current) => {
        const merged = [...current];
        for (const file of files)
          if (
            !merged.some((item) => item.path === file.path) &&
            merged.length < 8
          )
            merged.push(file);
        return merged;
      });
    } catch (error) {
      setContextError(error instanceof Error ? error.message : String(error));
    }
  }

  async function pasteImages(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    const allowed = new Set([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]);
    try {
      const remaining = Math.max(0, 4 - attachedImages.length);
      if (!remaining) throw new Error("每次最多粘贴 4 张图片");
      const images = await Promise.all(
        files.slice(0, remaining).map(async (file, index) => {
          if (!allowed.has(file.type))
            throw new Error(`不支持 ${file.type || "未知"} 图片格式`);
          if (file.size > 5 * 1024 * 1024)
            throw new Error(`${file.name || `图片 ${index + 1}`} 超过 5 MB`);
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
          return {
            id: uid(),
            name: file.name || `粘贴图片 ${Date.now()}-${index + 1}.png`,
            mediaType: file.type as ImageAttachment["mediaType"],
            dataUrl,
            size: file.size,
          };
        }),
      );
      setAttachedImages((current) => [...current, ...images]);
      setContextError(
        files.length > remaining
          ? `最多添加 4 张图片，已忽略 ${files.length - remaining} 张`
          : "",
      );
    } catch (error) {
      setContextError(error instanceof Error ? error.message : String(error));
    }
  }

  function compactActiveConversation() {
    if (!activeTask) return;
    if (!selectedContextWindow) {
      setContextError("请先为当前模型配置上下文窗口");
      return;
    }
    const compacted = compactConversation(
      activeTask,
      selectedContextWindow,
      true,
    );
    if (!compacted) {
      setContextError("当前对话较短，保留最近一轮后暂无可压缩内容");
      return;
    }
    setTasks((all) =>
      all.map((task) =>
        task.id === activeTask.id
          ? {
              ...task,
              ...compacted,
              summarySnapshots: summarySnapshot(task),
              summaryMeta: { modelGenerated: false, durationMs: 0 },
              updatedAt: Date.now(),
            }
          : task,
      ),
    );
    setContextError(
      `已按 Token 预算压缩 ${compacted.compactedMessageCount} 条较早消息，最近对话和关键状态继续保留`,
    );
  }

  async function improveSummaryWithModel(
    task: TaskRecord,
    local: NonNullable<ReturnType<typeof compactConversation>>,
  ) {
    if (!window.kcode?.chat.summarize) return local;
    const target = models.find(
      (item) => `${item.provider.id}|${item.model.id}` === task.modelSelection,
    );
    if (!target) return local;
    try {
      const result = await window.kcode.chat.summarize({
        taskId: task.id,
        providerId: target.provider.id,
        modelId: target.model.modelId,
        source: local.contextSummary,
        ledger: local.contextLedger,
      });
      return {
        ...local,
        contextSummary: result.summary,
        contextLedger: result.ledger,
        summaryMeta: {
          modelGenerated: true,
          durationMs: result.durationMs,
          usage: result.usage,
        },
      };
    } catch {
      return local;
    }
  }

  function summarySnapshot(task: TaskRecord) {
    if (!task.contextSummary) return task.summarySnapshots ?? [];
    return [
      {
        id: uid(),
        createdAt: Date.now(),
        summary: task.contextSummary,
        ledger: task.contextLedger ?? {
          goals: [],
          decisions: [],
          changedFiles: [],
          validations: [],
          failures: [],
          pending: [],
        },
        modelGenerated: task.summaryMeta?.modelGenerated ?? false,
        durationMs: task.summaryMeta?.durationMs,
        usage: task.summaryMeta?.usage,
      },
      ...(task.summarySnapshots ?? []),
    ].slice(0, 3);
  }

  async function rebuildActiveSummary() {
    if (!activeTask || !selectedContextWindow) return;
    const taskId = activeTask.id;
    const local = compactConversation(
      {
        ...activeTask,
        contextSummary: undefined,
        contextLedger: undefined,
        compactedMessageCount: 0,
      },
      selectedContextWindow,
      true,
    );
    if (!local) return setContextError("当前对话暂无足够内容用于生成摘要");
    setSummarizingTasks((current) => new Set(current).add(taskId));
    try {
      const compacted = await improveSummaryWithModel(activeTask, local);
      setTasks((all) =>
        all.map((task) =>
          task.id === taskId
            ? {
                ...task,
                ...compacted,
                summarySnapshots: summarySnapshot(task),
                summaryMeta:
                  "summaryMeta" in compacted
                    ? (compacted.summaryMeta as TaskRecord["summaryMeta"])
                    : { modelGenerated: false, durationMs: 0 },
                updatedAt: Date.now(),
              }
            : task,
        ),
      );
      if (activeTaskIdRef.current === taskId)
        setContextError(
          compacted === local
            ? "已使用本地规则重新生成摘要"
            : "已使用当前模型重新生成摘要和事实账本",
        );
    } finally {
      setSummarizingTasks((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
    }
  }

  function restoreFullContext() {
    if (!activeTask) return;
    setTasks((all) =>
      all.map((task) =>
        task.id === activeTask.id
          ? {
              ...task,
              contextSummary: undefined,
              contextLedger: undefined,
              compactedMessageCount: 0,
              updatedAt: Date.now(),
            }
          : task,
      ),
    );
    setSummaryOpen(false);
    setContextError("已恢复完整上下文；聊天记录没有被删除");
  }

  function restoreSummarySnapshot(
    snapshot: NonNullable<TaskRecord["summarySnapshots"]>[number],
  ) {
    if (!activeTask) return;
    setTasks((all) =>
      all.map((task) =>
        task.id === activeTask.id
          ? {
              ...task,
              contextSummary: snapshot.summary,
              contextLedger: snapshot.ledger,
              summaryMeta: {
                modelGenerated: snapshot.modelGenerated,
                durationMs: snapshot.durationMs ?? 0,
                usage: snapshot.usage,
              },
              updatedAt: Date.now(),
            }
          : task,
      ),
    );
    setContextError("已恢复所选摘要版本");
  }

  async function send(override?: string) {
    let text = (override ?? input).trim();
    const target = models.find(
      (x) => `${x.provider.id}|${x.model.id}` === selected,
    );
    if (
      (!text && !attachedImages.length) ||
      !target ||
      !activeTask ||
      runningId ||
      summaryBusy
    )
      return;
    if (activeTask?.name === "新对话") {
      const title = text.replace(/\s+/g, " ").slice(0, 28) || "新对话";
      setTasks((all) =>
        all.map((task) =>
          task.id === activeTask.id
            ? { ...task, name: title, updatedAt: Date.now() }
            : task,
        ),
      );
    }
    const retrying = override !== undefined;
    const cleanMessages = messages.filter(
      (message) =>
        !(
          message.role === "assistant" &&
          message.content.startsWith("请求失败：")
        ),
    );
    const user: ChatMessage =
      retrying && cleanMessages.at(-1)?.role === "user"
        ? (cleanMessages.at(-1) as ChatMessage)
        : {
            id: uid(),
            role: "user",
            content: text || "请分析这些图片",
            createdAt: Date.now(),
            images: attachedImages,
          };
    const nextMessages =
      retrying && cleanMessages.at(-1)?.role === "user"
        ? cleanMessages
        : [...cleanMessages, user];
    if (!retrying) contextByMessageRef.current.set(user.id, attachedFiles);
    let requestSummary = activeTask?.contextSummary;
    let requestLedger = activeTask?.contextLedger;
    let compactedCount = activeTask?.compactedMessageCount ?? 0;
    let contextNotice = "";
    const attachmentTokens = attachedFiles.reduce(
      (total, file) => total + Math.ceil(file.content.length / 3),
      0,
    );
    const outputReserve = selectedContextWindow
      ? Math.max(
          8_000,
          Math.floor(selectedContextWindow * (supportsReasoning ? 0.18 : 0.12)),
        )
      : 8_000;
    const rawEstimatedTokens =
      AGENT_STATIC_TOKENS +
      attachmentTokens +
      outputReserve +
      estimateMessageTokens(nextMessages.slice(compactedCount)) +
      Math.ceil((requestSummary?.length ?? 0) / 3);
    const requestCalibrationKey = `${target.provider.id}|${target.model.modelId}`;
    const estimatedTokens = Math.max(
      usage.input,
      Math.ceil(
        rawEstimatedTokens * (tokenCalibration[requestCalibrationKey] ?? 1),
      ),
    );
    const contextRatio = selectedContextWindow
      ? estimatedTokens / selectedContextWindow
      : 0;
    if (contextRatio >= 0.85 && contextRatio < 0.92)
      contextNotice = "上下文已达到 85%，系统将在 92% 时自动压缩";
    if (selectedContextWindow && contextRatio >= 0.92 && activeTask) {
      let compacted = compactConversation(
        { ...activeTask, messages: nextMessages },
        selectedContextWindow,
      );
      if (contextRatio >= 0.99 && !compacted)
        compacted = compactConversation(
          { ...activeTask, messages: nextMessages },
          selectedContextWindow,
          true,
        );
      if (compacted) {
        requestSummary = compacted.contextSummary;
        requestLedger = compacted.contextLedger;
        compactedCount = compacted.compactedMessageCount ?? compactedCount;
        setTasks((all) =>
          all.map((task) =>
            task.id === activeTask.id
              ? {
                  ...task,
                  ...compacted,
                  summarySnapshots: summarySnapshot(task),
                  summaryMeta: { modelGenerated: false, durationMs: 0 },
                  updatedAt: Date.now(),
                }
              : task,
          ),
        );
        contextNotice = `上下文达到 ${Math.round(contextRatio * 100)}%，已自动压缩 ${compactedCount} 条较早消息`;
        const localVersion = compacted.compactedMessageCount;
        void improveSummaryWithModel(activeTask, compacted).then((improved) => {
          if (improved === compacted) return;
          setTasks((all) =>
            all.map((task) =>
              task.id === activeTask.id &&
              task.compactedMessageCount === localVersion
                ? {
                    ...task,
                    contextSummary: improved.contextSummary,
                    contextLedger: improved.contextLedger,
                    summaryMeta:
                      "summaryMeta" in improved
                        ? (improved.summaryMeta as TaskRecord["summaryMeta"])
                        : task.summaryMeta,
                    updatedAt: Date.now(),
                  }
                : task,
            ),
          );
        });
      }
    }
    const requestMessages = nextMessages.slice(compactedCount);
    const history = requestMessages.map(({ id, role, content, images }) => {
      const files =
        role === "user" ? (contextByMessageRef.current.get(id) ?? []) : [];
      const fileContext = files
        .map(
          (file) =>
            `<context_file name="${file.name}">\n${file.content}\n</context_file>`,
        )
        .join("\n\n");
      return {
        role,
        content: fileContext ? `${content}\n\n${fileContext}` : content,
        images,
      };
    });
    if (requestSummary) {
      history.unshift({
        role: "user",
        content: `<conversation_summary>\n以下是较早对话的压缩摘要，请延续其中的目标、决策和执行状态：\n${requestSummary}\n${requestLedger ? `\n<fact_ledger>${JSON.stringify(requestLedger)}</fact_ledger>` : ""}\n</conversation_summary>`,
        images: undefined,
      });
    }
    const payloadBytes = new TextEncoder().encode(
      JSON.stringify(history),
    ).byteLength;
    if (payloadBytes > 24 * 1024 * 1024) {
      setContextError(
        `请求内容 ${(payloadBytes / 1024 / 1024).toFixed(1)} MB，超过 24 MB 限制；请压缩上下文或减少图片/附件`,
      );
      return;
    }
    autoFollowRef.current = true;
    requestStartedRef.current = Date.now();
    setUsedContextCount(contextByMessageRef.current.get(user.id)?.length ?? 0);
    if (activeTask?.id)
      setTasks((all) =>
        all.map((task) =>
          task.id === activeTask.id
            ? {
                ...task,
                usedContextCount:
                  contextByMessageRef.current.get(user.id)?.length ?? 0,
              }
            : task,
        ),
      );
    setAttachedFiles([]);
    setAttachedImages([]);
    setContextError(contextNotice);
    setMessages(nextMessages);
    setInput("");
    setUsage({ input: 0, output: 0, cached: 0 });
    setUsageResolved(false);
    setDurationMs(0);
    if (!window.kcode) {
      const id = `preview:${uid()}`;
      const response = `我已经检查了当前项目${contextByMessageRef.current.get(user.id)?.length ? `和 **${contextByMessageRef.current.get(user.id)?.length} 个上下文文件**` : ""}。当前使用${effortLabels[reasoningEffort]}推理强度，下一步建议优先完成：\n\n1. 接入工作区文件读取与代码搜索\n2. 建立工具调用的权限确认流程\n3. 在任务右侧展示实时执行进度\n\n\`\`\`ts\nconst result = await agent.run({\n  workspace: \"D:/project/kcode\",\n  model: \"${target.model.modelId}\",\n});\n\`\`\`\n\n> 当前模型通道正常，桌面端可以继续接入 Agent 工具循环。`;
      const chunks = response.match(/[\s\S]{1,12}/g) ?? [response];
      currentRequest.current = id;
      setRunningId(id);
      setMessages([
        ...nextMessages,
        {
          id: `assistant:${id}`,
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          model: target.model.displayName,
        },
      ]);
      let index = 0;
      previewTimerRef.current = window.setInterval(() => {
        const chunk = chunks[index++];
        if (chunk)
          setMessages((all) =>
            all.map((message) =>
              message.id === `assistant:${id}`
                ? { ...message, content: message.content + chunk }
                : message,
            ),
          );
        if (index >= chunks.length) {
          if (previewTimerRef.current)
            window.clearInterval(previewTimerRef.current);
          previewTimerRef.current = undefined;
          currentRequest.current = undefined;
          setRunningId(undefined);
          setUsage({ input: 312, output: 168, cached: 0 });
          setUsageResolved(true);
          if (requestStartedRef.current)
            setDurationMs(Date.now() - requestStartedRef.current);
        }
      }, 45);
      return;
    }
    const id = await window.kcode.chat.start({
      taskId: activeTask?.id,
      providerId: target.provider.id,
      modelId: target.model.modelId,
      messages: history,
      reasoningEffort,
      permissionMode,
      permissionPolicy,
      workspacePath: activeTask?.workspacePath || "D:\\project\\kcode",
      contextWindow: selectedContextWindow,
    });
    const taskId = activeTask?.id;
    if (!taskId) return;
    requestTasksRef.current.set(id, taskId);
    currentRequest.current = id;
    setRunningId(id);
    const assistantMessage: ChatMessage = {
      id: `assistant:${id}`,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      model: target.model.displayName,
    };
    setMessages((all) => [...all, assistantMessage]);
    setTasks((all) =>
      all.map((task) =>
        task.id === taskId
          ? {
              ...task,
              messages: [...nextMessages, assistantMessage],
              runningId: id,
              startedAt: requestStartedRef.current,
              pendingTokenEstimate: rawEstimatedTokens,
              pendingCalibrationKey: requestCalibrationKey,
              updatedAt: Date.now(),
            }
          : task,
      ),
    );
  }
  async function cancel() {
    if (runningId) {
      if (window.kcode) await window.kcode.chat.cancel(runningId);
      if (previewTimerRef.current)
        window.clearInterval(previewTimerRef.current);
      previewTimerRef.current = undefined;
      if (requestStartedRef.current)
        setDurationMs(Date.now() - requestStartedRef.current);
      currentRequest.current = undefined;
      setRunningId(undefined);
      if (activeTask?.id)
        setTasks((all) =>
          all.map((task) =>
            task.id === activeTask.id
              ? { ...task, runningId: undefined, updatedAt: Date.now() }
              : task,
          ),
        );
      requestTasksRef.current.delete(runningId);
    }
  }
  async function resumeCheckpoint(checkpoint: AgentCheckpoint) {
    if (!activeTask || runningId || summaryBusy) return;
    await window.kcode.chat.removeCheckpoint(checkpoint.id);
    const id = await window.kcode.chat.start({
      ...checkpoint.request,
      taskId: activeTask.id,
      messages: messages.map(({ role, content, images }) => ({
        role,
        content,
        images,
      })),
      permissionMode,
      permissionPolicy,
      contextWindow: selectedContextWindow,
    });
    requestTasksRef.current.set(id, activeTask.id);
    currentRequest.current = id;
    setRunningId(id);
    requestStartedRef.current = Date.now();
    const assistant: ChatMessage = {
      id: `assistant:${id}`,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      model: selectedTarget?.model.displayName,
    };
    setMessages((all) => [...all, assistant]);
    setTasks((all) =>
      all.map((task) =>
        task.id === activeTask.id
          ? {
              ...task,
              messages: [...task.messages, assistant],
              runningId: id,
              startedAt: Date.now(),
            }
          : task,
      ),
    );
    setCheckpoints((items) =>
      items.filter((item) => item.id !== checkpoint.id),
    );
  }

  const connected = providers.some((provider) => provider.hasApiKey);
  const selectedTarget = models.find(
    (item) => `${item.provider.id}|${item.model.id}` === selected,
  );
  const selectedContextWindow =
    selectedTarget?.model.contextWindow ??
    inferContextWindow(selectedTarget?.model.modelId || "");
  const selectedCalibrationKey = selectedTarget
    ? `${selectedTarget.provider.id}|${selectedTarget.model.modelId}`
    : "";
  const calibrationFactor = tokenCalibration[selectedCalibrationKey] ?? 1;
  const localContextTokens = Math.ceil(
    (AGENT_STATIC_TOKENS +
      Math.ceil((activeTask?.contextSummary?.length ?? 0) / 3) +
      estimateMessageTokens(
        messages.slice(activeTask?.compactedMessageCount ?? 0),
      )) *
      calibrationFactor,
  );
  const contextTokens = Math.max(usage.input, localContextTokens);
  const selectedConnected = Boolean(selectedTarget?.provider.hasApiKey);
  const efforts = reasoningEffortsForModel(selectedTarget?.model);
  const supportsReasoning = efforts.some((effort) => effort !== "auto");
  useEffect(() => {
    setReasoningEffort((current) => {
      const next = normalizeEffort(current, efforts);
      if (next !== current && activeTaskId)
        setTasks((all) =>
          all.map((task) =>
            task.id === activeTaskId
              ? { ...task, reasoningEffort: next }
              : task,
          ),
        );
      return next;
    });
    setEffortMenuOpen(false);
    if (selectedTarget)
      setProviderModelChoices((current) => ({
        ...current,
        [selectedTarget.provider.id]: selectedTarget.model.id,
      }));
  }, [selected, supportsReasoning]);
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const taskComplete =
    messages.some(
      (message) =>
        message.role === "assistant" &&
        message.content &&
        !message.content.startsWith("请求失败："),
    ) && !runningId;
  function handleModelMenuKeyDown(event: React.KeyboardEvent) {
    if (!modelMenuOpen) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        setModelMenuOpen(true);
        requestAnimationFrame(() =>
          modelPickerRef.current
            ?.querySelector<HTMLButtonElement>(
              '[role="option"][aria-selected="true"]',
            )
            ?.focus(),
        );
      }
      return;
    }
    const options = Array.from(
      modelPickerRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="option"]',
      ) ?? [],
    );
    const currentIndex = options.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    if (event.key === "Escape") {
      event.preventDefault();
      setModelMenuOpen(false);
      modelTriggerRef.current?.focus();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : event.key === "ArrowDown"
              ? Math.min(options.length - 1, Math.max(0, currentIndex + 1))
              : Math.max(
                  0,
                  currentIndex < 0 ? options.length - 1 : currentIndex - 1,
                );
      options[nextIndex]?.focus();
    } else if (event.key === "Tab") {
      setModelMenuOpen(false);
    }
  }

  return (
    <div className="window-root">
      <header className="window-titlebar" aria-label="窗口标题栏">
        <span>KCode</span>
        <div className="window-controls">
          <button
            title="最小化"
            aria-label="最小化"
            onClick={() => void window.kcode.window.minimize()}
          >
            <Minus size={14} />
          </button>
          <button
            title="最大化或还原"
            aria-label="最大化或还原"
            onClick={() => void window.kcode.window.toggleMaximize()}
          >
            <Square size={11} />
          </button>
          <button
            className="window-close"
            title="关闭"
            aria-label="关闭"
            onClick={() => void window.kcode.window.close()}
          >
            <X size={14} />
          </button>
        </div>
      </header>
      <div
        className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"} ${statusOpen ? "" : "status-collapsed"} ${browserState.open ? "browser-open" : ""}`}
        style={
          {
            "--sidebar-width": `${sidebarWidth}px`,
            "--browser-width": `${browserState.width ?? 520}px`,
          } as React.CSSProperties
        }
      >
        <aside className="sidebar">
          <div className="brand">
            <span>K</span>
            <div>
              <strong>KCode</strong>
              <small>Agent workspace</small>
            </div>
          </div>
          <button className="new-task" onClick={() => void startNewTask()}>
            <span className="new-task-icon">
              <Plus size={15} />
            </span>
            <span>新建任务</span>
            <kbd>Ctrl N</kbd>
          </button>
          <div className="workspace-label">工作区与对话</div>
          <div className="workspace-tree">
            {workspaceGroups.map((group) => (
              <section
                className={`workspace-group ${draggedWorkspace === group.workspacePath ? "dragging" : ""} ${workspaceDropTarget === group.workspacePath && draggedWorkspace !== group.workspacePath ? "drop-target" : ""}`}
                key={group.workspacePath}
                draggable
                onDragStart={(event) => {
                  if ((event.target as HTMLElement).closest(".task-row"))
                    return;
                  setDraggedWorkspace(group.workspacePath);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", group.workspacePath);
                }}
                onDragOver={(event) => {
                  if (!draggedWorkspace) return;
                  event.preventDefault();
                  setWorkspaceDropTarget(group.workspacePath);
                }}
                onDrop={(event) => {
                  if (!draggedWorkspace) return;
                  event.preventDefault();
                  reorderWorkspace(group.workspacePath);
                  setDraggedWorkspace(undefined);
                  setWorkspaceDropTarget(undefined);
                }}
                onDragEnd={() => {
                  setDraggedWorkspace(undefined);
                  setWorkspaceDropTarget(undefined);
                }}
              >
                <header title={group.workspacePath}>
                  <span className="workspace-grip" title="拖动工作区排序">
                    <GripVertical size={13} />
                  </span>
                  <button
                    className="workspace-collapse"
                    title={
                      collapsedWorkspaces.has(group.workspacePath)
                        ? "展开对话"
                        : "折叠对话"
                    }
                    aria-expanded={
                      !collapsedWorkspaces.has(group.workspacePath)
                    }
                    onClick={() => toggleWorkspace(group.workspacePath)}
                  >
                    <ChevronDown size={13} />
                  </button>
                  <FolderOpen size={15} />
                  <button
                    className="workspace-name"
                    onClick={() => toggleWorkspace(group.workspacePath)}
                  >
                    {group.name}
                  </button>
                  <small>{group.conversations.length}</small>
                  <button
                    title={`在 ${group.name} 新建对话`}
                    onClick={() => void createConversation(group.workspacePath)}
                  >
                    <Plus size={14} />
                  </button>
                  <button
                    className="workspace-delete"
                    title={`删除 ${group.name} 的全部对话记录`}
                    onClick={() =>
                      setDeleteTarget({
                        kind: "workspace",
                        path: group.workspacePath,
                        name: group.name,
                        count: group.conversations.length,
                      })
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </header>
                {!collapsedWorkspaces.has(group.workspacePath) && (
                  <div className="tasks">
                    {group.conversations.map((task) => (
                      <div
                        key={task.id}
                        draggable
                        className={`task-row ${task.id === activeTask?.id ? "active" : ""} ${draggedTaskId === task.id ? "dragging" : ""} ${taskDropTarget === task.id && draggedTaskId !== task.id ? "drop-target" : ""}`}
                        title={`${task.name}\n${task.workspacePath}`}
                        onDragStart={(event) => {
                          event.stopPropagation();
                          setDraggedTaskId(task.id);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", task.id);
                        }}
                        onDragOver={(event) => {
                          if (!draggedTaskId) return;
                          event.preventDefault();
                          event.stopPropagation();
                          event.dataTransfer.dropEffect = "move";
                          setTaskDropTarget(task.id);
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          reorderTask(task.id);
                          setDraggedTaskId(undefined);
                          setTaskDropTarget(undefined);
                        }}
                        onDragEnd={(event) => {
                          event.stopPropagation();
                          setDraggedTaskId(undefined);
                          setTaskDropTarget(undefined);
                        }}
                      >
                        <span className="task-grip" title="拖动排序">
                          <GripVertical size={13} />
                        </span>
                        <button
                          className="task-main"
                          onClick={() => void switchTask(task)}
                        >
                          <span>{task.name}</span>
                        </button>
                        {task.runningId && (
                          <small className="task-running">运行中</small>
                        )}
                        <button
                          className="task-delete"
                          title={`删除对话 ${task.name}`}
                          onClick={() =>
                            setDeleteTarget({ kind: "task", task })
                          }
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
          <div className="sidebar-footer">
            <button onClick={() => openSettings("general")}>
              <Settings size={17} />
              设置
            </button>
          </div>
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整任务列表宽度"
            onPointerDown={startSidebarResize}
          />
        </aside>
        <main className="main">
          <header className="topbar">
            <div className="topbar-left">
              <button
                className="icon pane-toggle"
                onClick={() => setSidebarOpen((value) => !value)}
                title={sidebarOpen ? "收起导航" : "展开导航"}
              >
                {sidebarOpen ? (
                  <PanelLeftClose size={17} />
                ) : (
                  <PanelLeftOpen size={17} />
                )}
              </button>
              <div>
                <h1>{activeTask?.name || "新任务"}</h1>
                <span>
                  <GitBranch size={13} />{" "}
                  {gitState.available ? gitState.branch : "未初始化 Git"} <i />
                  {gitState.available
                    ? gitState.files
                      ? `${gitState.files} 个文件有变更`
                      : "工作区无未提交变更"
                    : gitState.error || "未初始化 Git"}
                </span>
              </div>
            </div>
            <div className="top-actions">
              <button
                className="icon framed status-toggle"
                onClick={() => updateStatusPanel(!statusOpen)}
                title={statusOpen ? "收起状态栏" : "展开状态栏"}
              >
                {statusOpen ? (
                  <PanelRightClose size={17} />
                ) : (
                  <PanelRightOpen size={17} />
                )}
              </button>
            </div>
          </header>
          <section
            ref={conversationRef}
            className="conversation"
            onScroll={(event) => {
              const target = event.currentTarget;
              autoFollowRef.current =
                target.scrollHeight - target.scrollTop - target.clientHeight <
                100;
              updateActiveTurn(target);
            }}
          >
            {conversationTurns.length > 1 && (
              <nav
                className="turn-rail"
                aria-label="对话记录导航"
                style={
                  {
                    "--turn-count": conversationTurns.length,
                  } as React.CSSProperties
                }
              >
                <div className="turn-rail-line" />
                {conversationTurns.map((turn) => (
                  <button
                    key={turn.id}
                    className={activeTurnId === turn.id ? "active" : ""}
                    onClick={() =>
                      turnRefs.current
                        .get(turn.id)
                        ?.scrollIntoView({ behavior: "smooth", block: "start" })
                    }
                    aria-label={`跳转到：${turn.question.slice(0, 40)}`}
                  >
                    <span className="turn-tick" />
                    <span className="turn-preview">
                      <strong>{turn.question}</strong>
                      <small>{turn.answer}</small>
                    </span>
                  </button>
                ))}
              </nav>
            )}
            {messages.length === 0 ? (
              <div className="welcome">
                <div className="welcome-context">
                  <span className="context-dot" />
                  工作区已连接
                </div>
                <div className="logo-large">
                  <Bot size={25} />
                </div>
                <h2>{models.length ? "今天要构建什么？" : "先连接一个模型"}</h2>
                <p>
                  {models.length
                    ? "描述目标，Agent 会读取项目、制定计划并执行修改。"
                    : "添加模型供应商后，即可在当前工作区启动 Agent 任务。"}
                </p>
                {models.length ? (
                  <div className="prompts">
                    <button
                      onClick={() =>
                        setInput("检查当前项目结构，并给出下一步实现计划")
                      }
                    >
                      <span>01</span>检查项目结构并制定计划
                    </button>
                    <button
                      onClick={() =>
                        setInput("为这个项目补充 README 和开发说明")
                      }
                    >
                      <span>02</span>完善项目文档
                    </button>
                  </div>
                ) : (
                  <button
                    className="connect-model"
                    onClick={() => openSettings("models")}
                  >
                    <Settings size={15} />
                    打开模型设置
                  </button>
                )}
              </div>
            ) : (
              <div className="message-list" aria-live="polite">
                {messages.map((message) => {
                  const requestId = message.id.startsWith("assistant:")
                    ? message.id.slice("assistant:".length)
                    : undefined;
                  const turnActivities = requestId
                    ? activities.filter(
                        (activity) => activity.requestId === requestId,
                      )
                    : [];
                  const turnRunning =
                    Boolean(requestId) && requestId === runningId;
                  return (
                    <div
                      className="conversation-turn-item"
                      key={message.id}
                      ref={
                        message.role === "user"
                          ? (element) => {
                              if (element)
                                turnRefs.current.set(message.id, element);
                              else turnRefs.current.delete(message.id);
                            }
                          : undefined
                      }
                    >
                      <MessageItem
                        message={message}
                        running={turnRunning}
                        attachments={contextByMessageRef.current.get(
                          message.id,
                        )}
                        onRetry={() =>
                          lastUserMessage && void send(lastUserMessage.content)
                        }
                      />
                      {requestId && (
                        <ExecutionSummary
                          activities={turnActivities}
                          running={turnRunning}
                          requestId={turnRunning ? requestId : undefined}
                          workspacePath={activeTask?.workspacePath || ""}
                          onActivityChange={(next) =>
                            setActivities((all) =>
                              all.map((item) =>
                                item.id === next.id ? next : item,
                              ),
                            )
                          }
                        />
                      )}
                      {requestId && !turnRunning && (
                        <FileChangesSummary activities={turnActivities} />
                      )}
                    </div>
                  );
                })}
                <div ref={endRef} />
              </div>
            )}
          </section>
          <div className="composer-wrap">
            <div className="composer">
              {attachedImages.length > 0 && (
                <div className="pasted-images">
                  {attachedImages.map((image) => (
                    <div
                      key={image.id}
                      className="pasted-image"
                      title={`${image.name} · ${formatBytes(image.size)}`}
                    >
                      <img src={image.dataUrl} alt={image.name} />
                      <button
                        title={`移除 ${image.name}`}
                        onClick={() =>
                          setAttachedImages((images) =>
                            images.filter((item) => item.id !== image.id),
                          )
                        }
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {attachedFiles.length > 0 && (
                <div className="context-files">
                  {attachedFiles.map((file) => (
                    <div
                      key={file.id}
                      className="context-file"
                      title={file.path}
                    >
                      <span className="file-icon">
                        <FileCode2 size={14} />
                      </span>
                      <span>
                        <strong>{file.name}</strong>
                        <small>{formatBytes(file.size)}</small>
                      </span>
                      <button
                        title={`移除 ${file.name}`}
                        onClick={() =>
                          setAttachedFiles((files) =>
                            files.filter((item) => item.id !== file.id),
                          )
                        }
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {contextError && (
                <div className="context-error">
                  <CircleAlert size={13} />
                  {contextError}
                  <button title="关闭错误" onClick={() => setContextError("")}>
                    <X size={12} />
                  </button>
                </div>
              )}
              <textarea
                aria-label="任务输入"
                disabled={summaryBusy}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={(event) => void pasteImages(event)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={
                  summaryBusy
                    ? "正在压缩上下文，完成后可继续发送"
                    : models.length
                      ? "描述一个任务，Enter 发送，Shift + Enter 换行"
                      : "请先在设置中连接模型"
                }
              />
              <div className="composer-bar">
                <div className="composer-tools">
                  <button
                    className="context-button"
                    onClick={() => void pickContextFiles()}
                    disabled={Boolean(runningId) || summaryBusy}
                    title="添加文本或代码文件"
                  >
                    <Paperclip size={15} />
                    <span>上下文</span>
                    {attachedFiles.length > 0 && <b>{attachedFiles.length}</b>}
                  </button>
                  <div className="model-picker" ref={modelPickerRef}>
                    <button
                      ref={modelTriggerRef}
                      className="model-trigger"
                      aria-haspopup="listbox"
                      aria-expanded={modelMenuOpen}
                      onClick={() => {
                        setModelMenuProvider(undefined);
                        setModelMenuOpen((open) => !open);
                      }}
                      disabled={
                        !models.length || Boolean(runningId) || summaryBusy
                      }
                      onKeyDown={handleModelMenuKeyDown}
                    >
                      <span
                        className={`model-provider-dot ${selectedConnected ? "online" : ""}`}
                      />
                      <span className="model-trigger-label">
                        {selectedTarget ? (
                          <>
                            <small>{selectedTarget.provider.name}</small>
                            <b>/</b>
                            <strong>{selectedTarget.model.displayName}</strong>
                          </>
                        ) : (
                          "未配置模型"
                        )}
                      </span>
                      <ChevronDown size={13} />
                    </button>
                    {modelMenuOpen && (
                      <div
                        className="model-menu"
                        onKeyDown={handleModelMenuKeyDown}
                      >
                        <div
                          className="provider-menu-level"
                          role="listbox"
                          aria-label="选择供应商"
                        >
                          {providers
                            .filter(
                              (provider) =>
                                provider.enabled && provider.models.length,
                            )
                            .map((provider) => {
                              const chosenId =
                                providerModelChoices[provider.id];
                              const chosen =
                                provider.models.find(
                                  (model) => model.id === chosenId,
                                ) ?? provider.models[0];
                              const currentProvider =
                                selectedTarget?.provider.id === provider.id;
                              return (
                                <button
                                  key={provider.id}
                                  role="option"
                                  aria-selected={currentProvider}
                                  onMouseEnter={() =>
                                    setModelMenuProvider(provider.id)
                                  }
                                  onFocus={() =>
                                    setModelMenuProvider(provider.id)
                                  }
                                  onClick={() => {
                                    selectModel(`${provider.id}|${chosen.id}`);
                                    setProviderModelChoices((current) => ({
                                      ...current,
                                      [provider.id]: chosen.id,
                                    }));
                                    setModelMenuOpen(false);
                                    modelTriggerRef.current?.focus();
                                  }}
                                >
                                  <span
                                    className={`provider-menu-mark ${provider.hasApiKey ? "online" : ""}`}
                                  >
                                    <Cpu size={14} />
                                  </span>
                                  <span>
                                    <strong>{provider.name}</strong>
                                    <small>{chosen.displayName}</small>
                                  </span>
                                  {currentProvider && <Check size={14} />}
                                  <ChevronDown
                                    className="provider-next"
                                    size={14}
                                  />
                                </button>
                              );
                            })}
                        </div>
                        {modelMenuProvider && (
                          <div
                            className="model-submenu"
                            role="listbox"
                            aria-label="选择模型"
                            onMouseLeave={() => undefined}
                          >
                            {providers
                              .filter(
                                (provider) => provider.id === modelMenuProvider,
                              )
                              .map((provider) => (
                                <section key={provider.id}>
                                  <header>
                                    <span>{provider.name}</span>
                                    <small>
                                      {provider.models.length} 个模型
                                    </small>
                                  </header>
                                  {provider.models.map((model) => {
                                    const value = `${provider.id}|${model.id}`;
                                    return (
                                      <button
                                        key={model.id}
                                        role="option"
                                        aria-selected={selected === value}
                                        onClick={() => {
                                          selectModel(value);
                                          setProviderModelChoices(
                                            (current) => ({
                                              ...current,
                                              [provider.id]: model.id,
                                            }),
                                          );
                                          setModelMenuOpen(false);
                                          modelTriggerRef.current?.focus();
                                        }}
                                      >
                                        <span className="model-menu-icon">
                                          <Cpu size={14} />
                                        </span>
                                        <span>
                                          <strong>{model.displayName}</strong>
                                          <small>{model.modelId}</small>
                                        </span>
                                        {selected === value && (
                                          <Check size={14} />
                                        )}
                                      </button>
                                    );
                                  })}
                                </section>
                              ))}
                          </div>
                        )}
                        <button
                          className="manage-models"
                          onClick={() => {
                            setModelMenuOpen(false);
                            openSettings("models");
                          }}
                        >
                          <Settings size={14} />
                          管理模型
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="effort-picker" ref={effortPickerRef}>
                    <button
                      className="effort-trigger"
                      aria-haspopup="menu"
                      aria-expanded={effortMenuOpen}
                      disabled={
                        Boolean(runningId) ||
                        summaryBusy ||
                        efforts.length === 1
                      }
                      title="推理强度"
                      onClick={() => setEffortMenuOpen((open) => !open)}
                    >
                      <BrainCircuit size={14} />
                      <span>{effortLabels[reasoningEffort]}</span>
                      <ChevronDown size={13} />
                    </button>
                    {effortMenuOpen && (
                      <div
                        className="effort-menu"
                        role="menu"
                        aria-label="推理强度"
                      >
                        <header>推理强度</header>
                        {efforts.map((effort) => (
                          <button
                            key={effort}
                            role="menuitemradio"
                            aria-checked={reasoningEffort === effort}
                            className={
                              reasoningEffort === effort ? "active" : ""
                            }
                            onClick={() => {
                              selectReasoningEffort(effort);
                              setEffortMenuOpen(false);
                            }}
                          >
                            <span>
                              <strong>{effortLabels[effort]}</strong>
                              {effort === "max" && (
                                <small>更快消耗使用额度</small>
                              )}
                            </span>
                            {reasoningEffort === effort && <Check size={14} />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="composer-right">
                  {(usage.input > 0 || usage.output > 0) && (
                    <span className="usage">
                      {usage.input + usage.output} tokens
                    </span>
                  )}
                  {runningId ? (
                    <button className="send stop" onClick={cancel} title="停止">
                      <Square size={16} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      className="send"
                      onClick={() => void send()}
                      disabled={!input.trim() || !selected || summaryBusy}
                      title={summaryBusy ? "正在压缩上下文" : "发送"}
                    >
                      <Send size={17} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </main>
        {!browserState.open && (
          <aside className="status-panel">
            <header>
              <span>任务状态</span>
              {taskComplete ? <CheckCircle2 size={17} /> : <Check size={16} />}
            </header>
            <section>
              <span className="eyebrow">当前目标</span>
              <h3>
                {runningId
                  ? "Agent 正在执行"
                  : taskComplete
                    ? "本轮任务已完成"
                    : "准备开发环境"}
              </h3>
              <div className="progress">
                <i
                  style={{
                    width: runningId
                      ? "78%"
                      : taskComplete
                        ? "100%"
                        : connected
                          ? "66%"
                          : "33%",
                  }}
                />
              </div>
              <p>
                {runningId
                  ? "正在生成响应，请保持当前任务打开。"
                  : taskComplete
                    ? "模型已返回结果，可以继续追加修改要求。"
                    : connected
                      ? "模型通道已连接，可以开始执行任务。"
                      : "应用骨架已就绪，下一步配置一个模型通道。"}
              </p>
            </section>
            <section>
              <span className="eyebrow">运行环境</span>
              <dl>
                <div>
                  <dt>供应商</dt>
                  <dd>{providers.filter((p) => p.enabled).length}</dd>
                </div>
                <div>
                  <dt>模型</dt>
                  <dd>{models.length}</dd>
                </div>
                <div>
                  <dt>当前模型</dt>
                  <dd className="truncate">
                    {selectedTarget?.model.displayName ?? "未选择"}
                  </dd>
                </div>
                <div>
                  <dt>推理强度</dt>
                  <dd>{effortLabels[reasoningEffort]}</dd>
                </div>
              </dl>
              {checkpoints
                .filter((checkpoint) => checkpoint.taskId === activeTask?.id)
                .map((checkpoint) => (
                  <button
                    className="resume-checkpoint"
                    key={checkpoint.id}
                    disabled={Boolean(runningId) || summaryBusy}
                    onClick={() => void resumeCheckpoint(checkpoint)}
                  >
                    <RefreshCw size={13} />
                    <span>
                      <strong>继续未完成任务</strong>
                      <small>
                        {new Date(checkpoint.startedAt).toLocaleString()}
                      </small>
                    </span>
                  </button>
                ))}
            </section>
            <section className="git-section">
              <div className="git-section-head">
                <span className="eyebrow">工作区变更</span>
                <button
                  className={gitRefreshing ? "spinning" : ""}
                  onClick={() => void refreshGitState()}
                  title="刷新 Git 状态"
                >
                  <RefreshCw size={13} />
                </button>
              </div>
              {gitState.available ? (
                <>
                  <div className="git-summary">
                    <GitCompareArrows size={15} />
                    <span>
                      <strong>
                        {gitState.files
                          ? `${gitState.files} 个文件`
                          : "没有未提交变更"}
                      </strong>
                      <small>{gitState.branch}</small>
                    </span>
                    {gitState.files > 0 && (
                      <b>
                        <i>+{gitState.additions}</i>
                        <em>-{gitState.deletions}</em>
                      </b>
                    )}
                  </div>
                  {gitState.files > 0 && (
                    <button
                      className="git-diff-toggle"
                      onClick={() => setGitDiffOpen((value) => !value)}
                    >
                      {gitDiffOpen ? "收起差异" : "查看差异"}
                      <ChevronDown size={13} />
                    </button>
                  )}
                  {gitDiffOpen && (
                    <pre className="git-diff-view">
                      {gitState.diff || gitState.summary}
                    </pre>
                  )}
                </>
              ) : (
                <p>{gitState.error || "当前工作区未初始化 Git"}</p>
              )}
            </section>
            {(runningId ||
              taskComplete ||
              durationMs > 0 ||
              messages.length > 0) && (
              <section>
                <span className="eyebrow">本轮用量</span>
                <div className="run-metrics">
                  <div>
                    <Clock3 size={14} />
                    <span>
                      <small>耗时</small>
                      <strong>{formatDuration(durationMs)}</strong>
                    </span>
                  </div>
                  <div>
                    <BrainCircuit size={14} />
                    <span>
                      <small>Token</small>
                      <strong>
                        {usage.input + usage.output
                          ? (usage.input + usage.output).toLocaleString()
                          : usageResolved
                            ? "渠道未返回"
                            : "计算中"}
                      </strong>
                    </span>
                  </div>
                  <div>
                    <Paperclip size={14} />
                    <span>
                      <small>上下文</small>
                      <strong>{usedContextCount} 个文件</strong>
                    </span>
                  </div>
                </div>
                {usage.input + usage.output > 0 && (
                  <div className="token-split">
                    <span>输入 {usage.input}</span>
                    <i />
                    <span>输出 {usage.output}</span>
                    <i />
                    <span>缓存 {usage.cached}</span>
                  </div>
                )}
                <>
                  {selectedContextWindow ? (
                    <div className="context-usage">
                      <div>
                        <span>上下文预算</span>
                        <strong>
                          {Math.min(
                            100,
                            Math.round(
                              (contextTokens / selectedContextWindow) * 100,
                            ),
                          )}
                          %
                        </strong>
                      </div>
                      <div className="context-usage-bar">
                        <i
                          style={{
                            width: `${Math.min(100, (contextTokens / selectedContextWindow) * 100)}%`,
                          }}
                        />
                      </div>
                      <small>
                        {contextTokens.toLocaleString()} /{" "}
                        {selectedContextWindow.toLocaleString()} Token
                      </small>
                    </div>
                  ) : (
                    <div className="context-usage">
                      <div>
                        <span>上下文占用</span>
                        <strong>未配置</strong>
                      </div>
                      <small>请在模型设置中填写上下文窗口</small>
                    </div>
                  )}
                  {Math.abs(calibrationFactor - 1) >= 0.01 && (
                    <small className="calibration-status">
                      估算已按当前渠道校准 ×{calibrationFactor.toFixed(2)}
                    </small>
                  )}
                  <button
                    className="compact-context-button"
                    type="button"
                    disabled={Boolean(runningId)}
                    onClick={compactActiveConversation}
                    title="按 Token 预算压缩较早消息并保留关键状态"
                  >
                    <Minimize2 size={13} />
                    压缩上下文
                  </button>
                  {(activeTask?.compactedMessageCount ?? 0) > 0 && (
                    <small className="compaction-status">
                      已压缩 {activeTask?.compactedMessageCount} 条消息
                    </small>
                  )}
                  {activeTask?.contextSummary && (
                    <button
                      className="view-summary-button"
                      type="button"
                      onClick={() => setSummaryOpen(true)}
                    >
                      查看压缩摘要
                    </button>
                  )}
                </>
              </section>
            )}
            <section className="permission-section">
              <span className="eyebrow">操作权限</span>
              <div className="permission-row">
                {permissionMode === "full-access" ? (
                  <LockOpen size={16} />
                ) : permissionMode === "read-only" ? (
                  <FileCode2 size={16} />
                ) : (
                  <ShieldCheck size={16} />
                )}
                <span>
                  <strong>
                    {permissionMode === "confirm"
                      ? "变更前确认"
                      : permissionMode === "read-only"
                        ? "只读模式"
                        : "完全访问"}
                  </strong>
                  <small>
                    {permissionMode === "confirm"
                      ? "写入文件和运行命令前询问"
                      : permissionMode === "read-only"
                        ? "仅允许读取和分析工作区"
                        : "可直接写入文件和运行命令"}
                  </small>
                </span>
              </div>
            </section>
            {summaryOpen && activeTask?.contextSummary && (
              <div
                className="summary-layer"
                onMouseDown={(event) =>
                  event.target === event.currentTarget && setSummaryOpen(false)
                }
              >
                <div className="summary-dialog">
                  <header>
                    <strong>上下文摘要</strong>
                    <button title="关闭" onClick={() => setSummaryOpen(false)}>
                      <X size={16} />
                    </button>
                  </header>
                  <div className="summary-meta">
                    <span>
                      {activeTask.summaryMeta?.modelGenerated
                        ? "模型摘要"
                        : "本地摘要"}
                    </span>
                    {activeTask.summaryMeta?.durationMs ? (
                      <span>
                        {formatDuration(activeTask.summaryMeta.durationMs)}
                      </span>
                    ) : null}
                    {activeTask.summaryMeta?.usage ? (
                      <span>
                        {activeTask.summaryMeta.usage.input +
                          activeTask.summaryMeta.usage.output}{" "}
                        Token
                      </span>
                    ) : null}
                  </div>
                  <pre>{activeTask.contextSummary}</pre>
                  {Boolean(activeTask.summarySnapshots?.length) && (
                    <div className="summary-versions">
                      <strong>历史版本</strong>
                      {activeTask.summarySnapshots!.map((snapshot) => (
                        <button
                          key={snapshot.id}
                          disabled={summaryBusy || Boolean(runningId)}
                          onClick={() => restoreSummarySnapshot(snapshot)}
                        >
                          <span>
                            {new Date(snapshot.createdAt).toLocaleString()} ·{" "}
                            {snapshot.modelGenerated ? "模型" : "本地"}
                          </span>
                          <RotateCcw size={12} />
                        </button>
                      ))}
                    </div>
                  )}
                  <footer>
                    <button
                      disabled={Boolean(runningId) || summaryBusy}
                      onClick={() => void rebuildActiveSummary()}
                    >
                      <RefreshCw
                        className={summaryBusy ? "spinning" : ""}
                        size={13}
                      />
                      {summaryBusy ? "生成中" : "重新生成"}
                    </button>
                    <button
                      className="restore-context-button"
                      disabled={Boolean(runningId) || summaryBusy}
                      onClick={restoreFullContext}
                    >
                      <RotateCcw size={13} />
                      恢复完整上下文
                    </button>
                  </footer>
                </div>
              </div>
            )}
          </aside>
        )}
        {browserState.open && (
          <aside className="browser-panel" aria-label="浏览器">
            <header>
              <span>
                <strong>{browserState.title || "浏览器"}</strong>
                <small title={browserState.url}>{browserState.url}</small>
              </span>
              {browserState.recording && (
                <b className="browser-recording">
                  <i />
                  录制中
                </b>
              )}
              <button
                className="icon"
                title="关闭网页并停止当前浏览器任务"
                onClick={() =>
                  void window.kcode.browser.close(browserState.sessionId)
                }
              >
                <X size={16} />
              </button>
            </header>
          </aside>
        )}
        {settings && (
          <SettingsPanel
            providers={providers}
            setProviders={setProviders}
            initialSection={settingsSection}
            reasoningEfforts={efforts}
            defaultReasoningEffort={defaultReasoningEffort}
            onDefaultReasoningEffortChange={updateDefaultReasoningEffort}
            autoFollowEnabled={autoFollowEnabled}
            onAutoFollowChange={updateAutoFollow}
            statusPanelEnabled={statusOpen}
            onStatusPanelChange={updateStatusPanel}
            permissionMode={permissionMode}
            onPermissionModeChange={updatePermissionMode}
            permissionPolicy={permissionPolicy}
            onPermissionPolicyChange={updatePermissionPolicy}
            onClose={() => setSettings(false)}
          />
        )}
        {pendingFolder && (
          <div
            className="modal-backdrop"
            onMouseDown={(event) =>
              event.target === event.currentTarget && setPendingFolder(null)
            }
          >
            <section
              className="modal task-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="new-task-title"
            >
              <header>
                <div>
                  <span className="eyebrow">新建任务</span>
                  <h2 id="new-task-title">命名任务</h2>
                </div>
                <button
                  className="icon"
                  onClick={() => setPendingFolder(null)}
                  title="关闭"
                >
                  <X size={18} />
                </button>
              </header>
              <label className="task-name-field">
                任务名称
                <input
                  autoFocus
                  value={newTaskName}
                  onChange={(event) => setNewTaskName(event.target.value)}
                  onKeyDown={(event) =>
                    event.key === "Enter" && void createTask()
                  }
                  placeholder={pendingFolder.name}
                  maxLength={80}
                />
              </label>
              <div className="selected-folder">
                <FolderOpen size={16} />
                <span>
                  <strong>{pendingFolder.name}</strong>
                  <small>{pendingFolder.path}</small>
                </span>
              </div>
              <footer className="task-modal-actions">
                <button onClick={() => setPendingFolder(null)}>取消</button>
                <button className="primary" onClick={() => void createTask()}>
                  创建任务
                </button>
              </footer>
            </section>
          </div>
        )}
        {deleteTarget && (
          <div
            className="modal-backdrop delete-backdrop"
            onMouseDown={(event) =>
              event.target === event.currentTarget && setDeleteTarget(undefined)
            }
          >
            <section
              className="delete-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="delete-dialog-title"
            >
              <header>
                <span className="delete-dialog-icon">
                  <Trash2 size={17} />
                </span>
                <div>
                  <span className="eyebrow">删除记录</span>
                  <h2 id="delete-dialog-title">
                    {deleteTarget.kind === "workspace"
                      ? `删除“${deleteTarget.name}”下的全部对话？`
                      : `删除对话“${deleteTarget.task.name}”？`}
                  </h2>
                </div>
                <button
                  className="icon"
                  title="关闭"
                  onClick={() => setDeleteTarget(undefined)}
                >
                  <X size={17} />
                </button>
              </header>
              <div className="delete-dialog-body">
                <p>
                  {deleteTarget.kind === "workspace"
                    ? `将删除该工作区下的 ${deleteTarget.count} 条对话记录。`
                    : "将删除这条对话的消息、工具活动和上下文记录。"}
                </p>
                <ul>
                  <li>正在执行的相关任务会立即停止</li>
                  <li>磁盘上的对应对话记录会被清理</li>
                  <li>
                    <strong>不会删除工作区或任何项目文件</strong>
                  </li>
                </ul>
              </div>
              <footer>
                <button onClick={() => setDeleteTarget(undefined)}>取消</button>
                <button
                  className="danger"
                  autoFocus
                  onClick={() => {
                    const target = deleteTarget;
                    setDeleteTarget(undefined);
                    if (target.kind === "workspace")
                      void removeWorkspace(target.path);
                    else void removeTask(target.task);
                  }}
                >
                  <Trash2 size={13} />
                  确认删除
                </button>
              </footer>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
