import type { RefObject } from "react";
import {
  ArrowDown,
  BrainCircuit,
  Check,
  ChevronDown,
  CircleAlert,
  Cpu,
  FileCode2,
  Paperclip,
  Send,
  Settings,
  Square,
  X,
} from "lucide-react";
import type { ContextFile, ImageAttachment, ReasoningEffort } from "../../types";
import type { ModelEntry } from "../../state/ProvidersContext";
import type { ProviderConfig } from "../../types";
import { formatBytes } from "../../lib/format";

interface UsageInfo {
  input: number;
  output: number;
  cached: number;
}

export interface ComposerProps {
  showScrollToBottom: boolean;
  scrollToLatest(behavior?: ScrollBehavior): void;
  attachedImages: ImageAttachment[];
  setAttachedImages: React.Dispatch<React.SetStateAction<ImageAttachment[]>>;
  attachedFiles: ContextFile[];
  setAttachedFiles: React.Dispatch<React.SetStateAction<ContextFile[]>>;
  contextError: string;
  setContextError(value: string): void;
  contextToast: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  summaryBusy: boolean;
  hasInput: boolean;
  writeInput(value: string): void;
  pasteImages(event: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void>;
  modelPickerRef: RefObject<HTMLDivElement | null>;
  modelTriggerRef: RefObject<HTMLButtonElement | null>;
  effortPickerRef: RefObject<HTMLDivElement | null>;
  modelMenuOpen: boolean;
  setModelMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  modelMenuProvider: string | undefined;
  setModelMenuProvider(value: string | undefined): void;
  effortMenuOpen: boolean;
  setEffortMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  providerModelChoices: Record<string, string>;
  setProviderModelChoices: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  handleModelMenuKeyDown(event: React.KeyboardEvent): void;
  selectModel(value: string): void;
  selectReasoningEffort(value: ReasoningEffort): void;
  selectedTarget: ModelEntry | undefined;
  selectedConnected: boolean;
  selected: string;
  models: ModelEntry[];
  providers: ProviderConfig[];
  effortLabels: Record<ReasoningEffort, string>;
  reasoningEffort: ReasoningEffort;
  efforts: ReasoningEffort[];
  runningId: string | undefined;
  pickContextFiles(): Promise<void>;
  usage: UsageInfo;
  send(): Promise<void>;
  cancel(): void;
  openSettings(section: string): void;
}

export function Composer({
  showScrollToBottom,
  scrollToLatest,
  attachedImages,
  setAttachedImages,
  attachedFiles,
  setAttachedFiles,
  contextError,
  setContextError,
  contextToast,
  inputRef,
  summaryBusy,
  hasInput,
  writeInput,
  pasteImages,
  modelPickerRef,
  modelTriggerRef,
  effortPickerRef,
  modelMenuOpen,
  setModelMenuOpen,
  modelMenuProvider,
  setModelMenuProvider,
  effortMenuOpen,
  setEffortMenuOpen,
  providerModelChoices,
  setProviderModelChoices,
  handleModelMenuKeyDown,
  selectModel,
  selectReasoningEffort,
  selectedTarget,
  selectedConnected,
  selected,
  models,
  providers,
  effortLabels,
  reasoningEffort,
  efforts,
  runningId,
  pickContextFiles,
  usage,
  send,
  cancel,
  openSettings,
}: ComposerProps) {
  return (
    <div className="composer-wrap">
      {showScrollToBottom && (
        <button
          type="button"
          className="scroll-to-bottom"
          title="滚动到最新消息"
          aria-label="滚动到最新消息"
          onClick={() => scrollToLatest()}
        >
          <ArrowDown size={17} />
        </button>
      )}
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
        {contextToast && (
          <div className="context-toast" role="status">
            <CircleAlert size={13} />
            {contextToast}
          </div>
        )}
        <textarea
          aria-label="任务输入"
          ref={inputRef}
          disabled={summaryBusy}
          defaultValue=""
          onChange={(e) => writeInput(e.target.value)}
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
                disabled={!hasInput || !selected || summaryBusy}
                title={summaryBusy ? "正在压缩上下文" : "发送"}
              >
                <Send size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
