import { useEffect, useState } from "react";
import {
  Check,
  Clock3,
  FolderOpen,
  Pause,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { ScheduledTask } from "../../types";
import { uid } from "../../models";
import { errorMessage } from "../../lib/format";

type ModelOption = { value: string; label: string };

function blankSchedule(): ScheduledTask {
  const intervalMinutes = 60;
  return {
    id: uid(),
    name: "新定时任务",
    prompt: "",
    workspacePath: "",
    intervalMinutes,
    enabled: true,
    nextRunAt: Date.now() + intervalMinutes * 60_000,
  };
}

export function AutomationSettings({
  modelOptions,
}: {
  modelOptions: ModelOption[];
}) {
  const api = window.kcode?.state;
  const [items, setItems] = useState<ScheduledTask[]>([]);
  const [draft, setDraft] = useState<ScheduledTask>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!api) return;
    void api
      .load("scheduledTasks")
      .then((value) =>
        setItems(Array.isArray(value) ? (value as ScheduledTask[]) : []),
      )
      .catch((reason) => setError(errorMessage(reason)));
  }, [api]);

  async function persist(next: ScheduledTask[]) {
    if (!api) return;
    setBusy(true);
    try {
      await api.save("scheduledTasks", next);
      setItems(next);
      window.dispatchEvent(new Event("kcode:schedules-updated"));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (!draft) return;
    if (
      !draft.name.trim() ||
      !draft.prompt.trim() ||
      !draft.workspacePath.trim()
    ) {
      setError("请填写名称、提示词和工作区路径");
      return;
    }
    const normalized: ScheduledTask = {
      ...draft,
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      workspacePath: draft.workspacePath.trim(),
      intervalMinutes: Math.max(
        1,
        Math.min(7 * 24 * 60, Math.round(draft.intervalMinutes || 60)),
      ),
      nextRunAt:
        draft.nextRunAt > Date.now()
          ? draft.nextRunAt
          : Date.now() + Math.max(1, draft.intervalMinutes || 60) * 60_000,
      lastError: undefined,
    };
    await persist(
      items.some((item) => item.id === normalized.id)
        ? items.map((item) => (item.id === normalized.id ? normalized : item))
        : [normalized, ...items],
    );
    setDraft(undefined);
  }

  async function toggle(item: ScheduledTask) {
    const next = {
      ...item,
      enabled: !item.enabled,
      nextRunAt: Date.now() + item.intervalMinutes * 60_000,
    };
    await persist(
      items.map((current) => (current.id === item.id ? next : current)),
    );
  }

  async function remove(item: ScheduledTask) {
    await persist(items.filter((current) => current.id !== item.id));
  }

  async function pickWorkspace() {
    if (!draft || !window.kcode?.context.pickDirectory) return;
    const selected = await window.kcode.context.pickDirectory(
      draft.workspacePath || undefined,
    );
    if (selected) setDraft({ ...draft, workspacePath: selected });
  }

  return (
    <section className="settings-section automation-settings-section">
      <div className="settings-section-header with-action">
        <div>
          <h3>定时任务</h3>
          <p>按固定间隔在指定工作区启动一次新的 Agent 运行。</p>
        </div>
        <button
          className="add-provider"
          onClick={() => {
            setError("");
            setDraft(blankSchedule());
          }}
        >
          <Plus size={16} /> 添加任务
        </button>
      </div>
      {error && (
        <div className="settings-inline-error">
          <X size={14} /> {error}
        </div>
      )}
      <div className="scheduled-task-list">
        {items.length ? (
          items.map((item) => (
            <article
              className={`scheduled-task-card ${item.enabled ? "" : "disabled"}`}
              key={item.id}
            >
              <header>
                <span className="scheduled-task-icon">
                  <Clock3 size={16} />
                </span>
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.workspacePath}</small>
                </span>
                <span className="scheduled-task-next">
                  {item.enabled
                    ? `下次 ${new Date(item.nextRunAt).toLocaleString()}`
                    : "已暂停"}
                </span>
              </header>
              <p>{item.prompt}</p>
              {item.lastError && (
                <small className="scheduled-task-error">
                  上次失败：{item.lastError}
                </small>
              )}
              <footer>
                <button
                  className={`setting-switch ${item.enabled ? "on" : ""}`}
                  role="switch"
                  aria-checked={item.enabled}
                  onClick={() => void toggle(item)}
                >
                  {item.enabled ? <Play size={11} /> : <Pause size={11} />}
                  <span />
                </button>
                <small>每 {item.intervalMinutes} 分钟</small>
                <span />
                <button
                  className="secondary"
                  onClick={() => setDraft({ ...item })}
                >
                  编辑
                </button>
                <button
                  className="icon danger"
                  title="删除"
                  onClick={() => void remove(item)}
                >
                  <Trash2 size={13} />
                </button>
              </footer>
            </article>
          ))
        ) : (
          <div className="settings-empty">暂无定时任务</div>
        )}
      </div>
      {draft && (
        <div
          className="mcp-editor-backdrop"
          onMouseDown={(event) =>
            event.target === event.currentTarget && setDraft(undefined)
          }
        >
          <div
            className="mcp-editor scheduled-task-editor"
            role="dialog"
            aria-modal="true"
            aria-label="定时任务设置"
          >
            <header>
              <h4>定时任务设置</h4>
              <button
                className="icon"
                onClick={() => setDraft(undefined)}
                title="关闭"
              >
                <X size={16} />
              </button>
            </header>
            <div className="form-grid">
              <label>
                名称
                <input
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </label>
              <label>
                间隔（分钟）
                <input
                  type="number"
                  min="1"
                  max="10080"
                  value={draft.intervalMinutes}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      intervalMinutes: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label className="wide">
                工作区路径
                <div className="scheduled-workspace-picker">
                  <input
                    value={draft.workspacePath}
                    onChange={(event) =>
                      setDraft({ ...draft, workspacePath: event.target.value })
                    }
                    placeholder="D:\\project\\my-app"
                  />
                  <button
                    type="button"
                    className="icon"
                    title="选择工作区"
                    aria-label="选择工作区"
                    onClick={() => void pickWorkspace()}
                  >
                    <FolderOpen size={14} />
                  </button>
                </div>
              </label>
              <label className="wide">
                提示词
                <textarea
                  value={draft.prompt}
                  onChange={(event) =>
                    setDraft({ ...draft, prompt: event.target.value })
                  }
                  placeholder="检查测试失败并修复"
                />
              </label>
              {modelOptions.length > 0 && (
                <label className="wide">
                  模型
                  <select
                    value={draft.modelSelection ?? ""}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        modelSelection: event.target.value || undefined,
                      })
                    }
                  >
                    <option value="">使用当前模型</option>
                    {modelOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <footer>
              <span />
              <button className="secondary" onClick={() => setDraft(undefined)}>
                取消
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void saveDraft()}
              >
                <Check size={14} /> 保存
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
