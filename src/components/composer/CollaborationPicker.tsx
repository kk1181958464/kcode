import { Check, ChevronDown, Cpu, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
    onChange({ mode: "planner-executor", executorModelSelection });
  }

  return (
    <div className="collaboration-picker" ref={rootRef}>
      <button
        className="collaboration-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={
          enabled && executor
            ? `规划：当前模型 · 执行：${executor.model.displayName}`
            : "多模型协作"
        }
        onClick={() => setOpen((current) => !current)}
      >
        <Workflow size={14} />
        <span>
          {enabled
            ? `执行 · ${executor?.model.displayName || "选择模型"}`
            : "单模型"}
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
              onClick={enableCollaboration}
            >
              规划 → 执行
            </button>
          </div>
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
                            });
                            setOpen(false);
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
        </div>
      )}
    </div>
  );
}
