import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Cpu,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  inferReasoningConfig,
  resolveModelContextWindow,
} from "../../types";
import type { ModelConfig, ProviderConfig } from "../../types";
import { uid } from "../../models";
import { errorMessage } from "../../lib/format";

export function ProviderModal({
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
  const [showApiKeys, setShowApiKeys] = useState(false);
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncedModelCount, setSyncedModelCount] = useState<number | null>(null);
  const [protocolSuggestion, setProtocolSuggestion] = useState<string>();
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const enteredKeyCount = apiKey
    .split(/[\n,]+/)
    .map((key) => key.trim())
    .filter(Boolean).length;
  const apiKeyStatus = enteredKeyCount
    ? `已输入 ${enteredKeyCount} 个 Key`
    : provider.hasApiKey
      ? "已安全保存"
      : "尚未配置";
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
    setProtocolSuggestion(undefined);
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
      setError(errorMessage(e));
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
      contextWindow: resolveModelContextWindow(modelId.trim()),
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
      const result = await window.kcode.providers.probe(provider.id);
      const discovered = result.models;
      const models = result.profile.supportsModelListing
        ? discovered.map((model) => {
            const existing = provider.models.find(
              (item) => item.modelId === model.modelId,
            );
            const contextWindow = resolveModelContextWindow(
              model.modelId,
              existing?.contextWindow ?? model.contextWindow,
            );
            return existing
              ? {
                  ...model,
                  contextWindow,
                  reasoningMode: existing.reasoningMode ?? model.reasoningMode,
                  reasoningEfforts:
                    existing.reasoningEfforts ?? model.reasoningEfforts,
                }
              : { ...model, contextWindow };
          })
        : provider.models;
      patch({ models, profile: result.profile });
      setProtocolSuggestion(
        result.suggestedProtocol &&
          result.suggestedProtocol !== provider.protocol
          ? `检测到 ${result.suggestedProtocol}，请确认协议设置`
          : undefined,
      );
      setSyncedModelCount(models.length);
      if (
        result.profile.status === "auth-error" ||
        result.profile.status === "unreachable"
      )
        setError(result.profile.message || "供应商连接检测失败");
    } catch (e) {
      setError(errorMessage(e));
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
      setError(errorMessage(e));
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
        className="modal provider-modal"
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
          <div className="wide provider-key-control">
            <div className="provider-key-heading">
              <label htmlFor="provider-api-keys">API Key</label>
              <span
                className={`provider-key-status ${enteredKeyCount || provider.hasApiKey ? "configured" : ""}`}
              >
                {apiKeyStatus}
              </span>
            </div>
            <div
              className={`provider-key-field ${showApiKeys ? "revealed" : ""}`}
            >
              <KeyRound
                className="provider-key-leading-icon"
                size={16}
                aria-hidden="true"
              />
              <textarea
                id="provider-api-keys"
                className={`provider-api-keys ${showApiKeys ? "" : "masked"}`}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                rows={3}
                wrap="off"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                aria-describedby="provider-api-key-hint"
                placeholder={
                  provider.hasApiKey
                    ? "已安全保存，留空则不修改"
                    : "每行或逗号分隔多个 Key"
                }
              />
              <button
                type="button"
                className="provider-key-visibility"
                onClick={() => setShowApiKeys((value) => !value)}
                title={showApiKeys ? "隐藏 API Key" : "显示 API Key"}
                aria-label={showApiKeys ? "隐藏 API Key" : "显示 API Key"}
              >
                {showApiKeys ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <div className="provider-key-meta" id="provider-api-key-hint">
              <small>每行或逗号分隔多个 Key</small>
              <small>不可用时自动切换</small>
            </div>
          </div>
        </div>
        <div className="model-editor">
          <div className="section-title">
            <div>
              <h3>可用模型</h3>
              <p>检测接口协议并同步模型列表，也可手动添加模型 ID。</p>
              {(provider.profile?.message || protocolSuggestion) && (
                <p
                  className={`provider-probe-status ${provider.profile?.status ?? "degraded"}`}
                >
                  {protocolSuggestion || provider.profile?.message}
                  {provider.profile?.latencyMs !== undefined
                    ? ` · ${provider.profile.latencyMs} ms`
                    : ""}
                </p>
              )}
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
                {syncing ? "检测中" : "检测并同步"}
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
                      min="1"
                      step="1"
                      value={resolveModelContextWindow(
                        model.modelId,
                        model.contextWindow,
                      )}
                      onChange={(event) => {
                        const value = event.target.value;
                        patch({
                          models: provider.models.map((item) =>
                            item.id === model.id
                              ? {
                                  ...item,
                                  contextWindow: resolveModelContextWindow(
                                    item.modelId,
                                    value ? Number(value) : undefined,
                                  ),
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
