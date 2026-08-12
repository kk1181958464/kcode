import { Check, ChevronDown, Cpu, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  effortLabels,
  normalizeEffort,
  reasoningEffortsForModel,
} from "../../lib/model-utils";
import type { TaskCollaboration } from "../../models";
import type { ProviderConfig } from "../../types";

type CollaborationPickerProps = {
  providers: ProviderConfig[];
  plannerSelection: string;
  value?: TaskCollaboration;
  disabled?: boolean;
  onChange: (value?: TaskCollaboration) => void;
};

function selection(providerId: string, modelId: string) {
  return `${providerId}|${modelId}`;
}

export function CollaborationPicker({
  providers,
  plannerSelection,
  value,
  disabled,
  onChange,
}: CollaborationPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const options = useMemo(
    () =>
      providers
        .filter((provider) => provider.enabled)
        .flatMap((provider) =>
          provider.models.map((model) => ({ provider, model })),
        ),
    [providers],
  );
  const availableExecutors = options.filter(
    ({ provider, model }) =>
      provider.hasApiKey &&
      selection(provider.id, model.id) !== plannerSelection,
  );
  const executor = options.find(
    ({ provider, model }) =>
      selection(provider.id, model.id) === value?.executorModelSelection,
  );
  const enabled = value?.mode === "planner-executor";
  const executorEfforts = reasoningEffortsForModel(executor?.model);
  const executorEffort = normalizeEffort(
    value?.executorReasoningEffort ?? "auto",
    executorEfforts,
  );
  const triggerLabel = enabled
    ? `执行 · ${executor?.model.displayName || "选择模型"}${
        executor ? ` · ${effortLabels[executorEffort]}` : ""
      }`
    : "单模型";

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  function enableCollaboration() {
    const currentValid = availableExecutors.some(
      ({ provider, model }) =>
        selection(provider.id, model.id) === value?.executorModelSelection,
    );
    const executorModelSelection = currentValid
      ? value!.executorModelSelection
      : availableExecutors[0]
        ? selection(
            availableExecutors[0].provider.id,
            availableExecutors[0].model.id,
          )
        : "";
    if (!executorModelSelection) return;
    const nextExecutor = availableExecutors.find(
      ({ provider, model }) =>
        selection(provider.id, model.id) === executorModelSelection,
    );
    onChange({
      mode: "planner-executor",
      executorModelSelection,
      executorReasoningEffort: normalizeEffort(
        value?.executorReasoningEffort ?? "auto",
        reasoningEffortsForModel(nextExecutor?.model),
      ),
    });
  }

  return (
    <div className="collaboration-picker" ref={rootRef}>
      <button
        className="collaboration-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        disabled={disabled}
        title={
          enabled && executor
            ? `规划：当前模型 · 执行：${executor.model.displayName}（${effortLabels[executorEffort]}）`
            : "多模型协作"
        }
        onClick={() => setOpen((current) => !current)}
      >
        <Workflow size={14} />
        <span className="collaboration-trigger-label">
          {enabled ? (
            <>
              <span className="collaboration-trigger-role">执行 · </span>
              <span className="collaboration-trigger-model">
                {executor?.model.displayName || "选择模型"}
              </span>
              {executor && (
                <span className="collaboration-trigger-effort">
                  {" · "}
                  {effortLabels[executorEffort]}
                </span>
              )}
            </>
          ) : (
            "单模型"
          )}
        </span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="collaboration-menu" role="menu">
          <div className="collaboration-mode-tabs" aria-label="协作模式">
            <button
              type="button"
              className={!enabled ? "active" : ""}
              onClick={() => onChange(undefined)}
            >
              单模型
            </button>
            <button
              type="button"
              className={enabled ? "active" : ""}
              disabled={!availableExecutors.length}
              title={
                availableExecutors.length
                  ? undefined
                  : "需要至少一个已配置 API Key 且不同于规划模型的模型作为执行模型"
              }
              onClick={enableCollaboration}
            >
              规划 → 执行
            </button>
          </div>
          {!availableExecutors.length && (
            <p className="collaboration-empty-hint">
              暂无可用的执行模型：请在「管理模型」中启用另一个已配置 API Key
              的模型（需与规划模型不同）。
            </p>
          )}
          {enabled && (
            <div className="collaboration-model-list" role="listbox">
              <header>执行模型</header>
              {providers
                .filter(
                  (provider) => provider.enabled && provider.models.length,
                )
                .map((provider) => (
                  <section key={provider.id}>
                    <small>{provider.name}</small>
                    {provider.models.map((model) => {
                      const modelSelection = selection(provider.id, model.id);
                      const selected =
                        value.executorModelSelection === modelSelection;
                      const unavailable =
                        !provider.hasApiKey ||
                        modelSelection === plannerSelection;
                      return (
                        <button
                          key={model.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          disabled={unavailable}
                          title={
                            modelSelection === plannerSelection
                              ? "执行模型需要与规划模型不同"
                              : undefined
                          }
                          onClick={() => {
                            onChange({
                              mode: "planner-executor",
                              executorModelSelection: modelSelection,
                              executorReasoningEffort: normalizeEffort(
                                value.executorReasoningEffort ?? "auto",
                                reasoningEffortsForModel(model),
                              ),
                            });
                          }}
                        >
                          <Cpu size={14} />
                          <span>
                            <strong>{model.displayName}</strong>
                            <small>{model.modelId}</small>
                          </span>
                          {selected && <Check size={14} />}
                        </button>
                      );
                    })}
                  </section>
                ))}
            </div>
          )}
          {enabled && executor && (
            <div className="collaboration-effort">
              <header>
                <span>执行推理等级</span>
                <small>{executor.model.displayName}</small>
              </header>
              <div role="group" aria-label="执行模型推理等级">
                {executorEfforts.map((effort) => (
                  <button
                    key={effort}
                    type="button"
                    className={executorEffort === effort ? "active" : ""}
                    aria-pressed={executorEffort === effort}
                    onClick={() =>
                      onChange({
                        mode: "planner-executor",
                        executorModelSelection: value.executorModelSelection,
                        executorReasoningEffort: effort,
                      })
                    }
                  >
                    {effortLabels[effort]}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
