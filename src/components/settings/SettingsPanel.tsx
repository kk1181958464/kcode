import React, { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  Cpu,
  FileCode2,
  FolderOpen,
  LockOpen,
  Plus,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { inferContextWindow, inferReasoningConfig } from "../../types";
import type {
  BrowserRecordingFile,
  PermissionMode,
  PermissionPolicy,
  ProviderConfig,
  ReasoningEffort,
  ReasoningMode,
} from "../../types";
import type { SettingsSection } from "../../models";
import { effortLabels, savedEfforts } from "../../lib/model-utils";
import { ProviderModal } from "./ProviderModal";

export function SettingsPanel({
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
  const [storage, setStorage] = useState<{
    tasks: number;
    bytes: number;
    path: string;
  }>();
  useEffect(() => {
    if (section === "recordings" && window.kcode?.browser)
      void window.kcode.browser.recordings().then(setRecordings);
  }, [section]);
  useEffect(() => {
    if (section === "general")
      void window.kcode?.state.stats().then(setStorage);
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
                      <strong>本地任务数据</strong>
                      <small title={storage?.path}>
                        {storage
                          ? `${storage.tasks} 个任务 · ${(storage.bytes / 1024 / 1024).toFixed(2)} MB`
                          : "正在统计…"}
                      </small>
                    </span>
                    <button
                      className="secondary"
                      disabled={!storage}
                      onClick={() =>
                        void window.kcode.state.compact().then(setStorage)
                      }
                    >
                      <RefreshCw size={14} />
                      压缩数据库
                    </button>
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
