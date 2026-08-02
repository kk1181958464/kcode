import React, { useEffect, useState } from "react";
import {
  Blocks,
  Check,
  ChevronDown,
  CircleHelp,
  Cloud,
  Cpu,
  Download,
  ExternalLink,
  FileCode2,
  FolderOpen,
  LogIn,
  LogOut,
  LockOpen,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sun,
  Trash2,
  Wifi,
  WifiOff,
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
  SkillStoreItem,
} from "../../types";
import {
  ACCENT_OPTIONS,
  type AccentPreference,
  type SettingsSection,
  type ThemePreference,
} from "../../models";
import { effortLabels, savedEfforts } from "../../lib/model-utils";
import { errorMessage } from "../../lib/format";
import { isPermissionPolicyCustomized } from "../../permissions";
import { ProviderModal } from "./ProviderModal";
import type { RemoteControlState } from "../../remote-types";
import { MAX_REMOTE_DEVICE_NAME_LENGTH } from "../../remote-device";

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
  contextDirectory,
  onPickContextDirectory,
  onClearContextDirectory,
  theme,
  onThemeChange,
  accent,
  onAccentChange,
  permissionMode,
  onPermissionModeChange,
  permissionPolicy,
  onPermissionPolicyChange,
  remoteControlState,
  onRemoteControlStateChange,
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
  contextDirectory: string;
  onPickContextDirectory(): Promise<string | null>;
  onClearContextDirectory(): void;
  theme: ThemePreference;
  onThemeChange(value: ThemePreference): void;
  accent: AccentPreference;
  onAccentChange(value: AccentPreference): void;
  permissionMode: PermissionMode;
  onPermissionModeChange(value: PermissionMode): void;
  permissionPolicy: PermissionPolicy;
  onPermissionPolicyChange(value: PermissionPolicy): void;
  remoteControlState: RemoteControlState;
  onRemoteControlStateChange(value: RemoteControlState): void;
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
  const [skills, setSkills] = useState<SkillStoreItem[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillBusy, setSkillBusy] = useState<string>();
  const [skillError, setSkillError] = useState("");
  const [contextDirectoryBusy, setContextDirectoryBusy] = useState(false);
  const [contextDirectoryError, setContextDirectoryError] = useState("");
  const [remoteUsername, setRemoteUsername] = useState(
    remoteControlState.username ?? "",
  );
  const [remotePassword, setRemotePassword] = useState("");
  const [remoteDeviceName, setRemoteDeviceName] = useState(
    remoteControlState.deviceName,
  );
  const [remoteBusy, setRemoteBusy] = useState<
    "login" | "register" | "logout" | "toggle" | "rename"
  >();
  const [remoteError, setRemoteError] = useState("");
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
    if (section !== "skills" || !window.kcode?.skills) return;
    setSkillError("");
    setSkillsLoaded(false);
    void window.kcode.skills
      .list()
      .then((items) => {
        setSkills(items);
        setSkillsLoaded(true);
        return window.kcode.skills.list(true);
      })
      .then(setSkills)
      .catch((error) => setSkillError(errorMessage(error)))
      .finally(() => setSkillsLoaded(true));
  }, [section]);
  useEffect(() => {
    if (section === "general")
      void window.kcode?.state.stats().then(setStorage);
  }, [section]);
  useEffect(() => {
    if (remoteControlState.username)
      setRemoteUsername(remoteControlState.username);
  }, [remoteControlState.username]);
  useEffect(() => {
    setRemoteDeviceName(remoteControlState.deviceName);
  }, [remoteControlState.deviceName]);
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

  async function chooseContextDirectory() {
    setContextDirectoryError("");
    setContextDirectoryBusy(true);
    try {
      await onPickContextDirectory();
    } catch (error) {
      setContextDirectoryError(errorMessage(error));
    } finally {
      setContextDirectoryBusy(false);
    }
  }
  async function authenticateRemote(register: boolean) {
    const remote = window.kcode?.remote;
    if (!remote) return;
    setRemoteBusy(register ? "register" : "login");
    setRemoteError("");
    try {
      const state = register
        ? await remote.register(remoteUsername, remotePassword)
        : await remote.login(remoteUsername, remotePassword);
      onRemoteControlStateChange(state);
      setProviders(await window.kcode.providers.list());
      setRemotePassword("");
    } catch (error) {
      setRemoteError(errorMessage(error));
    } finally {
      setRemoteBusy(undefined);
    }
  }
  async function renameRemoteDevice() {
    const remote = window.kcode?.remote;
    const name = remoteDeviceName.trim();
    if (!remote || !name || name === remoteControlState.deviceName) return;
    setRemoteBusy("rename");
    setRemoteError("");
    try {
      onRemoteControlStateChange(await remote.setDeviceName(name));
    } catch (error) {
      setRemoteError(errorMessage(error));
    } finally {
      setRemoteBusy(undefined);
    }
  }
  async function toggleRemoteControl() {
    const remote = window.kcode?.remote;
    if (!remote) return;
    setRemoteBusy("toggle");
    setRemoteError("");
    try {
      onRemoteControlStateChange(
        await remote.setEnabled(!remoteControlState.enabled),
      );
    } catch (error) {
      setRemoteError(errorMessage(error));
    } finally {
      setRemoteBusy(undefined);
    }
  }
  async function logoutRemoteControl() {
    const remote = window.kcode?.remote;
    if (!remote) return;
    setRemoteBusy("logout");
    setRemoteError("");
    try {
      await remote.logout();
      onRemoteControlStateChange(await remote.state());
      setRemotePassword("");
    } catch (error) {
      setRemoteError(errorMessage(error));
    } finally {
      setRemoteBusy(undefined);
    }
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
  async function runSkillAction(
    id: string,
    action: () => Promise<SkillStoreItem[]>,
  ) {
    setSkillBusy(id);
    setSkillError("");
    try {
      setSkills(await action());
    } catch (error) {
      setSkillError(errorMessage(error));
    } finally {
      setSkillBusy(undefined);
    }
  }
  const visibleSkills = skills.filter((skill) => {
    const query = skillQuery.trim().toLowerCase();
    return (
      !query ||
      `${skill.name} ${skill.description} ${skill.author} ${skill.categories.join(" ")}`
        .toLowerCase()
        .includes(query)
    );
  });
  const customizedPermissions = isPermissionPolicyCustomized(
    permissionMode,
    permissionPolicy,
  );
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
              className={section === "remote" ? "active" : ""}
              onClick={() => setSection("remote")}
            >
              <Smartphone size={16} />
              <span>远程控制</span>
              <small>
                {remoteControlState.connected
                  ? "在线"
                  : remoteControlState.configured
                    ? "离线"
                    : ""}
              </small>
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
              className={section === "skills" ? "active" : ""}
              onClick={() => setSection("skills")}
            >
              <Blocks size={16} />
              <span>Skills</span>
              <small>
                {skills.filter((skill) => skill.installed).length || ""}
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
            {section === "remote" && (
              <section className="settings-section remote-settings-section">
                <div className="settings-section-header">
                  <h3>远程控制</h3>
                  <p>仅在需要从手机访问这台电脑时登录，本地功能不受影响。</p>
                </div>
                <div className="remote-local-note">
                  <Monitor size={17} />
                  <span>
                    <strong>本地模式始终可用</strong>
                    <small>
                      未登录或关闭远程控制时，任务和模型仍保存在本机。
                    </small>
                  </span>
                </div>
                {!remoteControlState.configured ? (
                  <div className="settings-group remote-auth-settings">
                    <div className="remote-fixed-service">
                      <span>远程服务</span>
                      <strong>{remoteControlState.serverUrl}</strong>
                      <ShieldCheck size={15} />
                    </div>
                    <label className="remote-field">
                      <span>账号</span>
                      <input
                        value={remoteUsername}
                        autoComplete="username"
                        onChange={(event) =>
                          setRemoteUsername(event.target.value)
                        }
                        placeholder="账号或邮箱"
                      />
                    </label>
                    <label className="remote-field">
                      <span>密码</span>
                      <input
                        type="password"
                        value={remotePassword}
                        autoComplete="current-password"
                        onChange={(event) =>
                          setRemotePassword(event.target.value)
                        }
                        placeholder="至少 10 位"
                      />
                    </label>
                    <div className="remote-auth-actions">
                      <button
                        className="primary"
                        disabled={Boolean(remoteBusy)}
                        onClick={() => void authenticateRemote(false)}
                      >
                        {remoteBusy === "login" ? (
                          <RefreshCw className="spin" size={14} />
                        ) : (
                          <LogIn size={14} />
                        )}
                        登录并开启
                      </button>
                      <button
                        disabled={Boolean(remoteBusy)}
                        onClick={() => void authenticateRemote(true)}
                      >
                        <Cloud size={14} />
                        创建账号
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="settings-group remote-connected-settings">
                    <div className="remote-account-head">
                      <span
                        className={`remote-connection-mark ${remoteControlState.connected ? "online" : ""}`}
                      >
                        {remoteControlState.connected ? (
                          <Wifi size={16} />
                        ) : (
                          <WifiOff size={16} />
                        )}
                      </span>
                      <span>
                        <strong>{remoteControlState.username}</strong>
                        <small>
                          {remoteControlState.connected
                            ? "手机可以控制这台电脑"
                            : remoteControlState.enabled
                              ? "正在等待重新连接"
                              : "远程控制已关闭"}
                        </small>
                      </span>
                      <button
                        className={`setting-switch ${remoteControlState.enabled ? "on" : ""}`}
                        role="switch"
                        aria-checked={remoteControlState.enabled}
                        disabled={remoteBusy === "toggle"}
                        title={
                          remoteControlState.enabled
                            ? "关闭远程控制"
                            : "开启远程控制"
                        }
                        onClick={() => void toggleRemoteControl()}
                      >
                        <span />
                      </button>
                    </div>
                    <dl className="remote-account-details">
                      <div>
                        <dt>电脑名称</dt>
                        <dd className="remote-device-name-editor">
                          <input
                            value={remoteDeviceName}
                            maxLength={MAX_REMOTE_DEVICE_NAME_LENGTH}
                            disabled={Boolean(remoteBusy)}
                            aria-label="电脑名称"
                            onChange={(event) =>
                              setRemoteDeviceName(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                event.stopPropagation();
                                void renameRemoteDevice();
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                event.stopPropagation();
                                setRemoteDeviceName(
                                  remoteControlState.deviceName,
                                );
                              }
                            }}
                          />
                          <button
                            type="button"
                            title="保存电脑名称"
                            aria-label="保存电脑名称"
                            disabled={
                              Boolean(remoteBusy) ||
                              !remoteDeviceName.trim() ||
                              remoteDeviceName.trim() ===
                                remoteControlState.deviceName
                            }
                            onClick={() => void renameRemoteDevice()}
                          >
                            {remoteBusy === "rename" ? (
                              <RefreshCw className="spin" size={14} />
                            ) : (
                              <Check size={14} />
                            )}
                          </button>
                        </dd>
                      </div>
                      <div>
                        <dt>服务</dt>
                        <dd title={remoteControlState.serverUrl}>
                          {remoteControlState.serverUrl}
                        </dd>
                      </div>
                      <div>
                        <dt>同步</dt>
                        <dd>
                          {remoteControlState.lastSyncedAt
                            ? new Date(
                                remoteControlState.lastSyncedAt,
                              ).toLocaleTimeString()
                            : "等待任务数据"}
                        </dd>
                      </div>
                    </dl>
                    <div className="remote-auth-actions">
                      <button
                        onClick={() =>
                          void window.kcode.shell.openExternal(
                            remoteControlState.serverUrl,
                          )
                        }
                      >
                        <ExternalLink size={14} />
                        打开手机版
                      </button>
                      <button
                        className="danger-text"
                        disabled={remoteBusy === "logout"}
                        onClick={() => void logoutRemoteControl()}
                      >
                        <LogOut size={14} />
                        退出远程账号
                      </button>
                    </div>
                  </div>
                )}
                {(remoteError || remoteControlState.error) && (
                  <div className="settings-inline-error">
                    <CircleHelp size={14} />
                    {remoteError || remoteControlState.error}
                  </div>
                )}
              </section>
            )}
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
                      <strong>外观主题</strong>
                      <small>选择工作台配色，跟随系统会实时响应系统设置</small>
                    </span>
                    <div
                      className="settings-segmented theme-segmented"
                      aria-label="外观主题"
                    >
                      {(
                        [
                          ["light", "浅色", Sun],
                          ["dark", "深色", Moon],
                          ["system", "跟随系统", Monitor],
                        ] as const
                      ).map(([value, label, Icon]) => (
                        <button
                          key={value}
                          type="button"
                          className={theme === value ? "active" : ""}
                          aria-pressed={theme === value}
                          onClick={() => onThemeChange(value)}
                        >
                          <Icon size={13} />
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-row">
                    <span>
                      <strong>配色方案</strong>
                      <small>选择强调色，适用于按钮、消息气泡与高亮</small>
                    </span>
                    <div
                      className="settings-segmented accent-segmented"
                      aria-label="配色方案"
                    >
                      {ACCENT_OPTIONS.map(({ value, label, swatch }) => (
                        <button
                          key={value}
                          type="button"
                          title={label}
                          aria-label={label}
                          aria-pressed={accent === value}
                          className={`accent-swatch${accent === value ? " active" : ""}`}
                          style={{
                            ["--sw" as string]: swatch,
                            background: swatch,
                          }}
                          onClick={() => onAccentChange(value)}
                        >
                          <Check size={14} strokeWidth={3} />
                        </button>
                      ))}
                    </div>
                  </div>
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
                  <div className="settings-row context-directory-setting">
                    <span>
                      <strong>上下文文件目录</strong>
                      <small title={contextDirectory || undefined}>
                        {contextDirectory || "未设置，使用系统默认目录"}
                      </small>
                      {contextDirectoryError && (
                        <small className="settings-directory-error">
                          {contextDirectoryError}
                        </small>
                      )}
                    </span>
                    <div className="settings-row-actions">
                      <button
                        className="secondary"
                        type="button"
                        disabled={contextDirectoryBusy}
                        onClick={() => void chooseContextDirectory()}
                      >
                        <FolderOpen size={14} />
                        {contextDirectoryBusy ? "选择中" : "选择目录"}
                      </button>
                      {contextDirectory && (
                        <button
                          className="settings-directory-clear"
                          type="button"
                          title="清除上下文文件目录"
                          aria-label="清除上下文文件目录"
                          onClick={() => {
                            setContextDirectoryError("");
                            onClearContextDirectory();
                          }}
                        >
                          <X size={14} />
                        </button>
                      )}
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
                      <small>在工作台右侧显示执行、改动与上下文详情</small>
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
            {section === "skills" && (
              <section className="settings-section skill-store-section">
                <div className="settings-section-header with-action">
                  <div>
                    <div className="skill-store-heading">
                      <h3>Skill 商店</h3>
                      <span className="skill-install-help">
                        <button
                          type="button"
                          className="skill-install-help-trigger"
                          aria-label="查看 Skill 安装说明"
                          aria-describedby="skill-install-help-tooltip"
                        >
                          <CircleHelp size={16} />
                        </button>
                        <span
                          id="skill-install-help-tooltip"
                          className="skill-install-help-tooltip"
                          role="tooltip"
                        >
                          <strong>安装 Skill</strong>
                          <span>1. 商店中的 Skill：点击条目右侧“安装”。</span>
                          <span>
                            2. GitHub 或社区
                            Skill：先下载完整目录，确认目录根部包含
                            <code>SKILL.md</code>。
                          </span>
                          <span>3. 点击“导入本地”，选择该 Skill 目录。</span>
                          <span>
                            也可以点击“打开目录”，手工放入 Skill
                            文件夹后刷新列表。
                          </span>
                        </span>
                      </span>
                    </div>
                    <p>
                      安装可复用的 Agent 工作方法。社区 Skill 在运行前仍受 KCode
                      工具权限约束。
                    </p>
                  </div>
                  <div className="skill-store-header-actions">
                    <button
                      className="secondary"
                      disabled={Boolean(skillBusy)}
                      onClick={() => {
                        setSkillError("");
                        void window.kcode.skills
                          .revealFolder()
                          .catch((error) =>
                            setSkillError(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            ),
                          );
                      }}
                    >
                      <FolderOpen size={14} />
                      打开目录
                    </button>
                    <button
                      className="secondary"
                      disabled={Boolean(skillBusy)}
                      onClick={() =>
                        void runSkillAction("$import", () =>
                          window.kcode.skills.importLocal(),
                        )
                      }
                    >
                      <Download size={14} />
                      {skillBusy === "$import" ? "导入中" : "导入本地"}
                    </button>
                    <button
                      className="secondary"
                      disabled={Boolean(skillBusy)}
                      onClick={() => {
                        setSkillBusy("$refresh");
                        setSkillError("");
                        void window.kcode.skills
                          .list(true)
                          .then(setSkills)
                          .catch((error) =>
                            setSkillError(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            ),
                          )
                          .finally(() => setSkillBusy(undefined));
                      }}
                    >
                      <RefreshCw
                        size={14}
                        className={skillBusy === "$refresh" ? "spinning" : ""}
                      />
                      刷新
                    </button>
                  </div>
                </div>
                <div className="skill-store-toolbar">
                  <Search size={15} />
                  <input
                    value={skillQuery}
                    onChange={(event) => setSkillQuery(event.target.value)}
                    placeholder="搜索 Skill、作者或分类"
                  />
                </div>
                <p className="skill-store-help">
                  商店条目可直接安装；GitHub 或社区 Skill 请先下载包含 SKILL.md
                  的完整目录，再选择“导入本地”。
                </p>
                {skillError && <p className="error">{skillError}</p>}
                <div className="skill-store-list">
                  {!skillsLoaded ? (
                    <div className="settings-empty">正在加载 Skill…</div>
                  ) : visibleSkills.length ? (
                    visibleSkills.map((skill) => (
                      <article className="skill-store-card" key={skill.id}>
                        <div className="skill-store-icon">
                          <Blocks size={18} />
                        </div>
                        <div className="skill-store-copy">
                          <div className="skill-store-title">
                            <strong>{skill.name}</strong>
                            <span>v{skill.version}</span>
                            {skill.verified && (
                              <span className="verified">已验证</span>
                            )}
                            {skill.source === "bundled" && <span>内置</span>}
                          </div>
                          <p>{skill.description}</p>
                          <div className="skill-store-meta">
                            <span>{skill.author}</span>
                            {skill.license && <span>{skill.license}</span>}
                            {skill.hasScripts && (
                              <span className="script-warning">包含脚本</span>
                            )}
                            {skill.categories.map((category) => (
                              <span key={category}>{category}</span>
                            ))}
                          </div>
                        </div>
                        <div className="skill-store-actions">
                          {skill.installed ? (
                            <>
                              <button
                                className={`setting-switch ${skill.enabled ? "on" : ""}`}
                                role="switch"
                                aria-label={`${skill.enabled ? "停用" : "启用"} ${skill.name}`}
                                aria-checked={skill.enabled}
                                disabled={skillBusy === skill.id}
                                onClick={() =>
                                  void runSkillAction(skill.id, () =>
                                    window.kcode.skills.setEnabled(
                                      skill.id,
                                      !skill.enabled,
                                    ),
                                  )
                                }
                              >
                                <span />
                              </button>
                              {skill.source !== "bundled" && (
                                <button
                                  className="secondary text"
                                  disabled={skillBusy === skill.id}
                                  onClick={() =>
                                    void runSkillAction(skill.id, () =>
                                      window.kcode.skills.uninstall(skill.id),
                                    )
                                  }
                                >
                                  卸载
                                </button>
                              )}
                            </>
                          ) : (
                            <button
                              className="primary"
                              disabled={Boolean(skillBusy)}
                              onClick={() =>
                                void runSkillAction(skill.id, () =>
                                  window.kcode.skills.install(skill.id),
                                )
                              }
                            >
                              <Download size={14} />
                              {skillBusy === skill.id ? "安装中" : "安装"}
                            </button>
                          )}
                        </div>
                      </article>
                    ))
                  ) : (
                    <div className="settings-empty">
                      没有匹配的 Skill。可从本地导入包含 SKILL.md
                      的目录，或将目录复制到用户 Skill 目录后刷新。
                    </div>
                  )}
                </div>
              </section>
            )}
            {section === "permissions" && (
              <section className="settings-section">
                <div className="settings-section-header">
                  <h3>权限</h3>
                  <p>
                    {customizedPermissions
                      ? "正在使用下方详细规则。"
                      : "设置 Agent 对当前工作区的默认操作边界。"}
                  </p>
                </div>
                <div
                  className="permission-options"
                  role="radiogroup"
                  aria-label="默认权限策略"
                >
                  <button
                    role="radio"
                    aria-checked={
                      !customizedPermissions && permissionMode === "confirm"
                    }
                    className={
                      !customizedPermissions && permissionMode === "confirm"
                        ? "active"
                        : ""
                    }
                    onClick={() => onPermissionModeChange("confirm")}
                  >
                    <span className="permission-option-icon">
                      <ShieldCheck size={17} />
                    </span>
                    <span>
                      <strong>变更前确认</strong>
                      <small>写入文件或运行命令前请求确认</small>
                    </span>
                    {!customizedPermissions && permissionMode === "confirm" && (
                      <Check size={15} />
                    )}
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
                    aria-checked={
                      !customizedPermissions && permissionMode === "full-access"
                    }
                    className={
                      !customizedPermissions && permissionMode === "full-access"
                        ? "active danger"
                        : ""
                    }
                    onClick={() => onPermissionModeChange("full-access")}
                  >
                    <span className="permission-option-icon">
                      <LockOpen size={17} />
                    </span>
                    <span>
                      <strong>完全访问</strong>
                      <small>默认直接执行，可在详细规则中设置例外</small>
                    </span>
                    {!customizedPermissions &&
                      permissionMode === "full-access" && <Check size={15} />}
                  </button>
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
                        disabled={permissionMode === "read-only"}
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
