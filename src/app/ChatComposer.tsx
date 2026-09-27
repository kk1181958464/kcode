import {
  ArrowUp,
  BrainCircuit,
  Check,
  ChevronDown,
  CircleAlert,
  Crosshair,
  Cpu,
  FileCode2,
  GripHorizontal,
  ListOrdered,
  Paperclip,
  Pencil,
  Send,
  Settings,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  type QueuedChatMessage,
  type SettingsSection,
  type TaskCollaboration,
  type TaskRecord,
} from "../models";
import { effortLabels } from "../lib/model-utils";
import { formatBytes } from "../lib/format";
import {
  ComposerTextarea,
  type ComposerTextareaHandle,
} from "../components/composer/ComposerTextarea";
import { PermissionPicker } from "../components/composer/PermissionPicker";
import { CollaborationPicker } from "../components/composer/CollaborationPicker";
import {
  designElementChipLabel,
  type DesignElementContext,
} from "../design-mode";
import type {
  ContextFile,
  ProviderConfig,
  PermissionMode,
  PermissionPolicy,
  ReasoningEffort,
  ImageAttachment,
} from "../types";

type ChatComposerProps = {
  startComposerResize: (event: React.PointerEvent<HTMLDivElement>) => void;
  handleComposerResizeKeyDown: (
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => void;
  composerDragActive: boolean;
  attachedImages: ImageAttachment[];
  setAttachedImages: React.Dispatch<React.SetStateAction<ImageAttachment[]>>;
  attachedFiles: ContextFile[];
  setAttachedFiles: React.Dispatch<React.SetStateAction<ContextFile[]>>;
  designElements: DesignElementContext[];
  setDesignElements: React.Dispatch<
    React.SetStateAction<DesignElementContext[]>
  >;
  contextError: string;
  setContextError: React.Dispatch<React.SetStateAction<string>>;
  contextToast: string;
  queuedMessages: QueuedChatMessage[];
  modifierKeyLabel: string;
  runningId: string | undefined;
  prioritizeQueuedMessage: (messageId: string) => void;
  beginQueuedMessageEdit: (message: QueuedChatMessage) => void;
  removeQueuedMessage: (messageId: string) => void;
  queuedMessageDraft: string;
  setQueuedMessageDraft: React.Dispatch<React.SetStateAction<string>>;
  cancelQueuedMessageEdit: () => void;
  saveQueuedMessageEdit: (message: QueuedChatMessage) => void;
  input: string;
  editingQueuedMessageId: string | undefined;
  composerRef: React.RefObject<ComposerTextareaHandle | null>;
  summaryBusy: boolean;
  handleComposerInputActivity: () => void;
  persistTaskDrafts: (value?: string) => void;
  handleComposerPaste: (
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ) => void;
  handleComposerSubmit: () => void;
  handleComposerSubmitImmediate: () => void;
  models: {
    provider: ProviderConfig;
    model: import("../types").ModelConfig;
  }[];
  pickContextFiles: () => Promise<void>;
  effectiveContextDirectory: string | undefined;
  selectedConnected: boolean;
  selectedTarget:
    | {
        provider: ProviderConfig;
        model: import("../types").ModelConfig;
      }
    | undefined;
  modelTriggerRef: React.RefObject<HTMLButtonElement | null>;
  modelMenuOpen: boolean;
  setModelMenuProvider: React.Dispatch<
    React.SetStateAction<string | undefined>
  >;
  setModelMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleModelMenuKeyDown: (event: React.KeyboardEvent) => void;
  providerModelChoices: Record<string, string>;
  selectModel: (value: string) => void;
  setProviderModelChoices: React.Dispatch<
    React.SetStateAction<Record<string, string>>
  >;
  providers: ProviderConfig[];
  modelMenuProvider: string | undefined;
  selected: string;
  openSettings: (section: SettingsSection) => void;
  modelPickerRef: React.RefObject<HTMLDivElement | null>;
  activeTask: TaskRecord;
  selectCollaboration: (value?: TaskCollaboration) => void;
  reasoningEffort: ReasoningEffort;
  effortMenuOpen: boolean;
  efforts: ReasoningEffort[];
  setEffortMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectReasoningEffort: (value: ReasoningEffort) => void;
  effortPickerRef: React.RefObject<HTMLDivElement | null>;
  permissionMode: PermissionMode;
  permissionPolicy: PermissionPolicy;
  updatePermissionMode: (value: PermissionMode) => void;
  usage: {
    input: number;
    output: number;
    cached: number;
    promptTokens?: number;
  };
  cancel: () => Promise<void>;
  send: (
    override?: string,
    queuedMessageId?: string,
    queuedTaskId?: string,
  ) => Promise<void>;
  queueMessage: (options?: { silent?: boolean }) => string | undefined;
  composerSurfaceRef: React.RefObject<HTMLDivElement | null>;
  handleComposerDragEnter: (event: React.DragEvent<HTMLDivElement>) => void;
  handleComposerDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  handleComposerDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  handleComposerDrop: (event: React.DragEvent<HTMLDivElement>) => Promise<void>;
};

export function ChatComposer({
  startComposerResize,
  handleComposerResizeKeyDown,
  composerDragActive,
  attachedImages,
  setAttachedImages,
  attachedFiles,
  setAttachedFiles,
  designElements,
  setDesignElements,
  contextError,
  setContextError,
  contextToast,
  queuedMessages,
  modifierKeyLabel,
  runningId,
  prioritizeQueuedMessage,
  beginQueuedMessageEdit,
  removeQueuedMessage,
  queuedMessageDraft,
  setQueuedMessageDraft,
  cancelQueuedMessageEdit,
  saveQueuedMessageEdit,
  input,
  editingQueuedMessageId,
  composerRef,
  summaryBusy,
  handleComposerInputActivity,
  persistTaskDrafts,
  handleComposerPaste,
  handleComposerSubmit,
  handleComposerSubmitImmediate,
  models,
  pickContextFiles,
  effectiveContextDirectory,
  selectedConnected,
  selectedTarget,
  modelTriggerRef,
  modelMenuOpen,
  setModelMenuProvider,
  setModelMenuOpen,
  handleModelMenuKeyDown,
  providerModelChoices,
  selectModel,
  setProviderModelChoices,
  providers,
  modelMenuProvider,
  selected,
  openSettings,
  modelPickerRef,
  activeTask,
  selectCollaboration,
  reasoningEffort,
  effortMenuOpen,
  efforts,
  setEffortMenuOpen,
  selectReasoningEffort,
  effortPickerRef,
  permissionMode,
  permissionPolicy,
  updatePermissionMode,
  usage,
  cancel,
  send,
  queueMessage,
  composerSurfaceRef,
  handleComposerDragEnter,
  handleComposerDragOver,
  handleComposerDragLeave,
  handleComposerDrop,
}: ChatComposerProps) {
  return (
    <div
      ref={composerSurfaceRef}
      className={`composer ${composerDragActive ? "drag-active" : ""}`}
      onDragEnter={handleComposerDragEnter}
      onDragOver={handleComposerDragOver}
      onDragLeave={handleComposerDragLeave}
      onDrop={(event) => void handleComposerDrop(event)}
    >
      <div
        className="composer-resize-handle"
        role="separator"
        aria-label="调整输入框高度"
        aria-orientation="horizontal"
        tabIndex={0}
        title="上下拖动调整输入框高度"
        onPointerDown={startComposerResize}
        onKeyDown={handleComposerResizeKeyDown}
      >
        <GripHorizontal size={16} aria-hidden="true" />
      </div>
      {composerDragActive && (
        <div className="composer-drop-zone" role="status">
          <Upload size={18} />
          <span>
            <strong>添加到当前任务</strong>
            <small>文本、代码或图片</small>
          </span>
        </div>
      )}
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
            <div key={file.id} className="context-file" title={file.path}>
              <span className="file-icon">
                <FileCode2 size={14} />
              </span>
              <span>
                <strong>{file.name}</strong>
                <small>
                  {formatBytes(file.size)}
                  {file.format && file.format !== "text"
                    ? ` · ${file.format.toUpperCase()} 已解析`
                    : ""}
                  {file.truncated ? " · 已截断" : ""}
                </small>
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
      {designElements.length > 0 && (
        <div className="context-files design-element-files">
          {designElements.map((element) => (
            <div
              key={element.id}
              className="context-file design-element-chip"
              title={`${element.cssSelector}\n${element.xpath}`}
            >
              <span className="file-icon">
                <Crosshair size={14} />
              </span>
              <span>
                <strong>{designElementChipLabel(element)}</strong>
                <small>
                  {element.pageTitle || element.pageUrl || "设计元素"}
                  {element.textSnippet
                    ? ` · ${element.textSnippet.slice(0, 24)}`
                    : ""}
                </small>
              </span>
              <button
                title={`移除 ${designElementChipLabel(element)}`}
                onClick={() =>
                  setDesignElements((items) =>
                    items.filter((item) => item.id !== element.id),
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
      {contextToast && (
        <div className="context-toast" role="status">
          <CircleAlert size={13} />
          {contextToast}
        </div>
      )}
      {queuedMessages.length > 0 && (
        <div className="queued-message-panel" aria-label="发送队列">
          <header>
            <span>
              <ListOrdered size={14} /> 发送队列
            </span>
            <small>{queuedMessages.length} 条</small>
          </header>
          <p className="queued-message-hint">
            当前回复结束后按顺序自动发送；可撤回。
            {runningId
              ? ` ${modifierKeyLabel}+Enter 可中断并立即发送输入框内容。`
              : ""}
          </p>
          {queuedMessages.map((message, index) => (
            <div
              className={`queued-message-row${editingQueuedMessageId === message.id ? " editing" : ""}`}
              key={message.id}
            >
              <span className="queued-message-index">{index + 1}</span>
              {editingQueuedMessageId === message.id ? (
                <>
                  <input
                    className="queued-message-edit"
                    value={queuedMessageDraft}
                    autoFocus
                    aria-label="修改补发消息"
                    onChange={(event) =>
                      setQueuedMessageDraft(event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        saveQueuedMessageEdit(message);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        cancelQueuedMessageEdit();
                      }
                    }}
                  />
                  <button
                    type="button"
                    title="保存修改"
                    aria-label="保存修改"
                    onClick={() => saveQueuedMessageEdit(message)}
                  >
                    <Check size={13} />
                  </button>
                  <button
                    type="button"
                    title="取消修改"
                    aria-label="取消修改"
                    onClick={cancelQueuedMessageEdit}
                  >
                    <X size={13} />
                  </button>
                </>
              ) : (
                <>
                  <span
                    className="queued-message-content"
                    title={message.content}
                  >
                    {message.content || "图片附件"}
                  </span>
                  <button
                    type="button"
                    title="移到队首"
                    aria-label="移到队首"
                    onClick={() => prioritizeQueuedMessage(message.id)}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    title="修改补发消息"
                    aria-label="修改补发消息"
                    onClick={() => beginQueuedMessageEdit(message)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    title="撤回补发消息"
                    aria-label="撤回补发消息"
                    onClick={() => removeQueuedMessage(message.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <ComposerTextarea
        ref={composerRef}
        disabled={summaryBusy}
        value={input}
        onInputActivity={handleComposerInputActivity}
        onBlur={persistTaskDrafts}
        onPaste={handleComposerPaste}
        onSubmit={handleComposerSubmit}
        onSubmitImmediate={handleComposerSubmitImmediate}
        placeholder={
          summaryBusy
            ? "正在压缩上下文，完成后可继续发送"
            : !models.length
              ? "请先在设置中连接模型"
              : runningId
                ? `Enter 加入队列 · ${modifierKeyLabel}+Enter 中断并立即发送`
                : "描述一个任务，Enter 发送，Shift + Enter 换行"
        }
      />
      <div className="composer-bar">
        <div className="composer-tools">
          <button
            className="context-button"
            onClick={() => void pickContextFiles()}
            disabled={Boolean(runningId) || summaryBusy}
            aria-label="添加上下文文件"
            title={
              effectiveContextDirectory
                ? `添加文本或代码文件 · ${effectiveContextDirectory}`
                : "添加文本或代码文件"
            }
          >
            <Paperclip size={15} />
            {attachedFiles.length > 0 && <b>{attachedFiles.length}</b>}
          </button>
          <div className="composer-chips">
            <div className="model-picker" ref={modelPickerRef}>
              <button
                ref={modelTriggerRef}
                className="model-trigger composer-chip"
                aria-haspopup="listbox"
                aria-expanded={modelMenuOpen}
                onClick={() => {
                  setModelMenuProvider(undefined);
                  setModelMenuOpen((open) => !open);
                }}
                disabled={!models.length || Boolean(runningId) || summaryBusy}
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
                <div className="model-menu" onKeyDown={handleModelMenuKeyDown}>
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
                        const chosenId = providerModelChoices[provider.id];
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
                            onFocus={() => setModelMenuProvider(provider.id)}
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
                            <ChevronDown className="provider-next" size={14} />
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
                        .filter((provider) => provider.id === modelMenuProvider)
                        .map((provider) => (
                          <section key={provider.id}>
                            <header>
                              <span>{provider.name}</span>
                              <small>{provider.models.length} 个模型</small>
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
                                    setProviderModelChoices((current) => ({
                                      ...current,
                                      [provider.id]: model.id,
                                    }));
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
                                  {selected === value && <Check size={14} />}
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
            <CollaborationPicker
              providers={providers}
              plannerSelection={selected}
              value={activeTask?.collaboration}
              disabled={Boolean(runningId) || summaryBusy}
              onChange={selectCollaboration}
            />
            <div className="effort-picker" ref={effortPickerRef}>
              <button
                className="effort-trigger composer-chip"
                aria-haspopup="menu"
                aria-expanded={effortMenuOpen}
                disabled={
                  Boolean(runningId) || summaryBusy || efforts.length === 1
                }
                title={
                  activeTask?.collaboration?.mode === "planner-executor"
                    ? "规划模型推理强度"
                    : "推理强度"
                }
                onClick={() => setEffortMenuOpen((open) => !open)}
              >
                <BrainCircuit size={14} />
                <span>
                  {activeTask?.collaboration?.mode === "planner-executor"
                    ? `规划 · ${effortLabels[reasoningEffort]}`
                    : effortLabels[reasoningEffort]}
                </span>
                <ChevronDown size={13} />
              </button>
              {effortMenuOpen && (
                <div
                  className="effort-menu"
                  role="menu"
                  aria-label={
                    activeTask?.collaboration?.mode === "planner-executor"
                      ? "规划模型推理强度"
                      : "推理强度"
                  }
                >
                  <header>
                    {activeTask?.collaboration?.mode === "planner-executor"
                      ? "规划模型推理强度"
                      : "推理强度"}
                  </header>
                  {efforts.map((effort) => (
                    <button
                      key={effort}
                      role="menuitemradio"
                      aria-checked={reasoningEffort === effort}
                      className={reasoningEffort === effort ? "active" : ""}
                      onClick={() => {
                        selectReasoningEffort(effort);
                        setEffortMenuOpen(false);
                      }}
                    >
                      <span>
                        <strong>{effortLabels[effort]}</strong>
                        {effort === "max" && <small>更快消耗使用额度</small>}
                      </span>
                      {reasoningEffort === effort && <Check size={14} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <PermissionPicker
              mode={permissionMode}
              policy={permissionPolicy}
              disabled={summaryBusy}
              onChange={updatePermissionMode}
            />
          </div>
        </div>
        <div className="composer-right">
          {(usage.input > 0 || usage.output > 0) && (
            <span className="usage">{usage.input + usage.output} tokens</span>
          )}
          {runningId && (
            <button className="send stop" onClick={cancel} title="停止">
              <Square size={16} fill="currentColor" />
            </button>
          )}
          <button
            className="send"
            onClick={() => (runningId ? queueMessage() : void send())}
            disabled={!selected || summaryBusy}
            title={
              summaryBusy
                ? "正在压缩上下文"
                : runningId
                  ? `加入发送队列（${modifierKeyLabel}+Enter 立即发送）`
                  : "发送"
            }
          >
            <Send size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
