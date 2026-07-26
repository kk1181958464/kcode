import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { inferContextWindow } from "./types";
import {
  AGENT_STATIC_TOKENS,
  compactConversation,
  estimateMessageTokens,
} from "./context";
import { isTaskViewCurrent, type TaskRunStatus } from "./task-status";
import type {
  AgentActivity,
  AgentCheckpoint,
  ChatMessage,
  ContextFile,
  ReasoningEffort,
  WorkspaceFolder,
  GitWorkspaceState,
  ImageAttachment,
} from "./types";

import {
  uid,
  initialTask,
  type TaskRecord,
  type ConversationScrollState,
} from "./models";
import {
  normalizeStoredTask,
  storedTasks,
  storedActiveTask,
  storedTokenCalibration,
} from "./lib/storage";
import {
  workingPhase,
} from "./lib/format";
import {
  effortLabels,
  savedEfforts,
  reasoningEffortsForModel,
  normalizeEffort,
} from "./lib/model-utils";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { ConversationArea } from "./components/conversation/ConversationArea";
import { AppUpdateDialog } from "./components/dialogs/AppUpdateDialog";
import { SettingsProvider, useSettings } from "./state/SettingsContext";
import { ProvidersProvider, useProviders } from "./state/ProvidersContext";
import { Sidebar } from "./components/sidebar/Sidebar";
import { TopBar } from "./components/topbar/TopBar";
import { BrowserPanel } from "./components/browser/BrowserPanel";
import { StatusPanel } from "./components/status/StatusPanel";
import { Composer } from "./components/composer/Composer";
import { TitleBar } from "./components/chrome/TitleBar";
import { NewTaskDialog, DeleteDialog } from "./components/dialogs/TaskDialogs";

// Extracted components live in ./components/* (imported above).
// (activity.output && !/[\uFFFD]{1,}|[□�]{1,}/.test(activity.output)

export default function App() {
  return (
    <SettingsProvider>
      <ProvidersProvider>
        <AppInner />
      </ProvidersProvider>
    </SettingsProvider>
  );
}

function AppInner() {
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
  const [taskQuery, setTaskQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
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
  const { providers, setProviders, models } = useProviders();
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => storedActiveTask()?.messages ?? [],
  );
  const [activities, setActivities] = useState<AgentActivity[]>(
    () => storedActiveTask()?.activities ?? [],
  );
  // 输入框热路径优化：真实文本存在 ref 中，避免每次按键触发整个 App 重渲染。
  // hasInput 仅在“空 ↔ 非空”边界变化时更新，用于发送按钮的禁用态。
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const inputValueRef = useRef("");
  const [hasInput, setHasInput] = useState(false);
  const readInput = useCallback(() => inputValueRef.current, []);
  const writeInput = useCallback((value: string) => {
    inputValueRef.current = value;
    if (inputRef.current && inputRef.current.value !== value) {
      inputRef.current.value = value;
    }
    const next = value.trim().length > 0;
    setHasInput((prev) => (prev === next ? prev : next));
  }, []);
  const clearInput = useCallback(() => {
    writeInput("");
  }, [writeInput]);
  const {
    settingsOpen: settings,
    settingsSection,
    openSettings,
    closeSettings,
    autoFollowEnabled,
    updateAutoFollow,
    statusOpen,
    updateStatusPanel,
    permissionMode,
    updatePermissionMode,
    permissionPolicy,
    updatePermissionPolicy,
    appUpdate,
    updateOpen,
    setUpdateOpen,
    defaultReasoningEffort,
    updateDefaultReasoningEffort: updateDefaultReasoningEffortRaw,
  } = useSettings();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selected, setSelected] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuProvider, setModelMenuProvider] = useState<string>();
  const [providerModelChoices, setProviderModelChoices] = useState<
    Record<string, string>
  >({});
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
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
  // A transient notice (compaction done, summary restored) that flashes above the
  // composer and auto-dismisses, unlike contextError which stays until closed.
  const [contextToast, setContextToast] = useState("");
  const contextToastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flashContextToast = useCallback((message: string) => {
    setContextToast(message);
    if (contextToastTimer.current) clearTimeout(contextToastTimer.current);
    contextToastTimer.current = setTimeout(() => setContextToast(""), 5_000);
  }, []);
  useEffect(
    () => () => {
      if (contextToastTimer.current) clearTimeout(contextToastTimer.current);
    },
    [],
  );
  const [usedContextCount, setUsedContextCount] = useState(
    () => storedActiveTask()?.usedContextCount ?? 0,
  );
  const [runningId, setRunningId] = useState<string>();
  const [browserState, setBrowserState] = useState<{
    open: boolean;
    hidden?: boolean;
    sessionId?: string;
    requestId?: string;
    title?: string;
    url?: string;
    width?: number;
    recording?: boolean;
    canGoBack?: boolean;
    canGoForward?: boolean;
  }>({ open: false });
  const [browserAddress, setBrowserAddress] = useState("");
  // Latest reasoning/thinking snippet for the active turn, shown live under the
  // working spinner. Cleared once visible text or a tool activity takes over.
  const [agentReasoning, setAgentReasoning] = useState("");
  const [browserWidthDrag, setBrowserWidthDrag] = useState<number>();
  useEffect(() => window.kcode?.browser?.onState(setBrowserState), []);
  useEffect(
    () => setBrowserAddress(browserState.url || ""),
    [browserState.url],
  );
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
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
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
  const assistantLengthsRef = useRef(new Map<string, number>());
  const activeTaskIdRef = useRef(activeTaskId);
  const displayedTaskIdRef = useRef(activeTaskId);
  const tasksRef = useRef(tasks);
  const previewTimerRef = useRef<number | undefined>(undefined);
  const followFrameRef = useRef<number | undefined>(undefined);
  const scrollFrameRef = useRef<number | undefined>(undefined);
  const scrollStateByTaskRef = useRef(
    new Map<string, ConversationScrollState>(),
  );
  const pendingScrollRestoreRef = useRef<
    { taskId: string; state: ConversationScrollState } | undefined
  >(undefined);
  const scrollAfterSendRef = useRef(false);
  const turnLayoutFrameRef = useRef<number | undefined>(undefined);
  const scrollTargetRef = useRef<HTMLElement | null>(null);
  const requestStartedRef = useRef<number | undefined>(undefined);
  const contextByMessageRef = useRef(new Map<string, ContextFile[]>());
  const sendRef = useRef<((override?: string) => Promise<void>) | undefined>(
    undefined,
  );
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const effortPickerRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const conversationRef = useRef<HTMLElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const autoFollowRef = useRef(true);
  const turnRefs = useRef(new Map<string, HTMLDivElement>());
  const turnButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const turnPositionsRef = useRef<{ id: string; top: number }[]>([]);
  const activeConversationTurnRef = useRef<string | undefined>(undefined);
  const registerTurn = useCallback(
    (id: string, element: HTMLDivElement | null) => {
      if (element) turnRefs.current.set(id, element);
      else turnRefs.current.delete(id);
    },
    [],
  );
  const retryMessage = useCallback((content: string) => {
    void sendRef.current?.(content);
  }, []);
  const claimTaskView = (taskId: string) => {
    activeTaskIdRef.current = taskId;
    displayedTaskIdRef.current = taskId;
  };
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
          const loaded = (stored as TaskRecord[]).map(normalizeStoredTask);
          const selectedTask =
            loaded.find(
              (task) => task.id === localStorage.getItem("kcode.activeTaskId"),
            ) ?? loaded[0];
          claimTaskView(selectedTask?.id ?? "");
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
  const conversationTurns = useMemo(() => {
    const turns: Array<{ id: string; question: string; answer: string }> = [];
    for (const message of messages) {
      if (message.role === "user") {
        turns.push({
          id: message.id,
          question: message.content,
          answer: "正在生成…",
        });
        continue;
      }
      const currentTurn = turns.at(-1);
      if (currentTurn && currentTurn.answer === "正在生成…")
        currentTurn.answer = message.content || "正在生成…";
    }
    return turns;
  }, [messages]);
  const activitiesByRequest = useMemo(() => {
    const grouped = new Map<string, AgentActivity[]>();
    for (const activity of activities)
      grouped.set(activity.requestId, [
        ...(grouped.get(activity.requestId) ?? []),
        activity,
      ]);
    return grouped;
  }, [activities]);
  const handleActivityChange = useCallback((next: AgentActivity) => {
    setActivities((all) =>
      all.map((item) => (item.id === next.id ? next : item)),
    );
  }, []);
  useEffect(() => {
    const ids = new Set(conversationTurns.map((turn) => turn.id));
    if (
      !activeConversationTurnRef.current ||
      !ids.has(activeConversationTurnRef.current)
    )
      setActiveConversationTurn(conversationTurns[0]?.id);
    refreshTurnPositions();
  }, [conversationTurns]);
  useEffect(() => {
    const conversation = conversationRef.current;
    const messageList = conversation?.querySelector(".message-list");
    if (!messageList || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(refreshTurnPositions);
    observer.observe(messageList);
    return () => observer.disconnect();
  }, [activeTaskId, messages.length]);
  useEffect(
    () => () => {
      if (scrollFrameRef.current) cancelAnimationFrame(scrollFrameRef.current);
      if (turnLayoutFrameRef.current)
        cancelAnimationFrame(turnLayoutFrameRef.current);
    },
    [],
  );

  function setActiveConversationTurn(id?: string) {
    if (activeConversationTurnRef.current === id) return;
    if (activeConversationTurnRef.current)
      turnButtonRefs.current
        .get(activeConversationTurnRef.current)
        ?.classList.remove("active");
    activeConversationTurnRef.current = id;
    if (id) turnButtonRefs.current.get(id)?.classList.add("active");
  }

  function updateActiveTurn(container: HTMLElement) {
    const positions = turnPositionsRef.current;
    if (!positions.length) return setActiveConversationTurn(undefined);
    const threshold =
      container.scrollTop + Math.min(180, container.clientHeight * 0.3);
    let low = 0;
    let high = positions.length - 1;
    let match = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (positions[middle].top <= threshold) {
        match = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    setActiveConversationTurn(positions[match].id);
  }

  function refreshTurnPositions() {
    if (turnLayoutFrameRef.current)
      cancelAnimationFrame(turnLayoutFrameRef.current);
    turnLayoutFrameRef.current = requestAnimationFrame(() => {
      turnLayoutFrameRef.current = undefined;
      turnPositionsRef.current = conversationTurns
        .map((turn) => {
          const element = turnRefs.current.get(turn.id);
          return element ? { id: turn.id, top: element.offsetTop } : undefined;
        })
        .filter((item): item is { id: string; top: number } => Boolean(item));
      const conversation = conversationRef.current;
      if (conversation) updateActiveTurn(conversation);
    });
  }

  function handleConversationScroll(container: HTMLElement) {
    scrollTargetRef.current = container;
    if (scrollFrameRef.current) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = undefined;
      const target = scrollTargetRef.current;
      if (!target) return;
      const atBottom =
        target.scrollHeight - target.scrollTop - target.clientHeight < 72;
      const taskId = displayedTaskIdRef.current;
      if (taskId)
        scrollStateByTaskRef.current.set(taskId, {
          top: target.scrollTop,
          atBottom,
        });
      if (autoFollowRef.current !== atBottom) {
        autoFollowRef.current = atBottom;
        setShowScrollToBottom(!atBottom);
      }
      updateActiveTurn(target);
    });
  }

  function scrollToLatest(behavior: ScrollBehavior = "smooth") {
    const conversation = conversationRef.current;
    if (!conversation) return;
    autoFollowRef.current = true;
    setShowScrollToBottom(false);
    conversation.scrollTo({ top: conversation.scrollHeight, behavior });
    const taskId = displayedTaskIdRef.current;
    if (taskId)
      scrollStateByTaskRef.current.set(taskId, {
        top: conversation.scrollHeight,
        atBottom: true,
      });
    setActiveConversationTurn(conversationTurns.at(-1)?.id);
  }

  function scrollToTurn(turnId: string, index: number) {
    if (index === conversationTurns.length - 1) return scrollToLatest("auto");
    const conversation = conversationRef.current;
    const element = turnRefs.current.get(turnId);
    if (!conversation || !element) return;
    autoFollowRef.current = false;
    setShowScrollToBottom(true);
    conversation.scrollTo({
      top: Math.max(0, element.offsetTop - 20),
      behavior: "auto",
    });
    setActiveConversationTurn(turnId);
  }
  const workspaceGroups = useMemo(() => {
    const groups = new Map<string, TaskRecord[]>();
    const query = taskQuery.trim().toLocaleLowerCase();
    for (const task of tasks) {
      if (Boolean(task.archived) !== showArchived) continue;
      if (
        query &&
        !`${task.name} ${task.workspacePath}`
          .toLocaleLowerCase()
          .includes(query)
      )
        continue;
      groups.set(task.workspacePath, [
        ...(groups.get(task.workspacePath) ?? []),
        task,
      ]);
    }
    return [...groups.entries()].map(([workspacePath, conversations]) => ({
      workspacePath,
      name: workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || "工作区",
      conversations,
    }));
  }, [tasks, taskQuery, showArchived]);

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
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    if (!activeTaskId && tasks[0]) {
      claimTaskView(tasks[0].id);
      setActiveTaskId(tasks[0].id);
    }
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
    const ownerTaskId = displayedTaskIdRef.current;
    if (!ownerTaskId || ownerTaskId !== activeTaskId) return;
    setTasks((all) =>
      all.map((task) =>
        task.id === ownerTaskId
          ? { ...task, messages, activities, updatedAt: Date.now() }
          : task,
      ),
    );
  }, [messages, activities, activeTaskId]);

  function updateDefaultReasoningEffort(value: ReasoningEffort) {
    updateDefaultReasoningEffortRaw(value, efforts);
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

  function startBrowserResize(event: React.PointerEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = browserState.width ?? 520;
    // The panel sits on the right, so dragging its left edge leftward widens it.
    const widthAt = (clientX: number) =>
      Math.min(900, Math.max(360, startWidth + startX - clientX));
    document.body.classList.add("resizing-browser");
    const move = (moveEvent: PointerEvent) => {
      const width = widthAt(moveEvent.clientX);
      setBrowserWidthDrag(width);
      // Push to the native view too so the web content tracks the drag live.
      void window.kcode?.browser?.setWidth(width);
    };
    const stop = (upEvent: PointerEvent) => {
      const width = widthAt(upEvent.clientX);
      setBrowserWidthDrag(undefined);
      void window.kcode?.browser?.setWidth(width);
      document.body.classList.remove("resizing-browser");
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
        claimTaskView(next.id);
        setActiveTaskId(next.id);
        setMessages(next.messages);
        setActivities(next.activities);
        setRunningId(next.runningId);
        currentRequest.current = next.runningId;
        requestStartedRef.current = next.startedAt;
        setSelected(next.modelSelection || selected);
        setReasoningEffort(next.reasoningEffort || defaultReasoningEffort);
      } else {
        claimTaskView("");
        setActiveTaskId("");
        setMessages([]);
        setActivities([]);
        setRunningId(undefined);
        currentRequest.current = undefined;
        requestStartedRef.current = undefined;
        clearInput();
        setAttachedFiles([]);
        setAttachedImages([]);
        setUsage({ input: 0, output: 0, cached: 0 });
        setUsageResolved(false);
        setDurationMs(0);
      }
    }
  }

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
        const isActive = isTaskViewCurrent(
          activeTaskIdRef.current,
          displayedTaskIdRef.current,
          taskId,
        );
        if (event.type === "activity") {
          if (isActive) setAgentReasoning("");
          const task = tasksRef.current.find((item) => item.id === taskId);
          const previous = task?.activities.find(
            (item) => item.id === event.activity.id,
          );
          const fallbackLength =
            task?.messages.find((message) => message.id === `assistant:${id}`)
              ?.content.length ?? 0;
          const positionedActivity: AgentActivity = {
            ...event.activity,
            contentOffset:
              previous?.contentOffset ??
              assistantLengthsRef.current.get(id) ??
              fallbackLength,
          };
          const updateActivities = (all: AgentActivity[]) => {
            const exists = all.some(
              (item) => item.id === positionedActivity.id,
            );
            return exists
              ? all.map((item) =>
                  item.id === positionedActivity.id ? positionedActivity : item,
                )
              : [...all, positionedActivity];
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
        if (event.type === "reasoning") {
          if (isActive)
            setAgentReasoning((current) =>
              (current + event.delta).replace(/\s+/g, " ").slice(-200),
            );
          return;
        }
        if (event.type === "text") {
          if (isActive) setAgentReasoning("");
          assistantLengthsRef.current.set(
            id,
            (assistantLengthsRef.current.get(id) ?? 0) + event.delta.length,
          );
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
            promptTokens: event.promptTokens ?? event.input,
          };
          const task = tasksRef.current.find((item) => item.id === taskId);
          // Calibrate against the last round's prompt tokens (the real context
          // occupancy), not the accumulated billing total which grows every round.
          const observedInput = event.promptTokens ?? event.input;
          if (
            observedInput > 0 &&
            task?.pendingTokenEstimate &&
            task.pendingCalibrationKey
          ) {
            const observed = Math.min(
              2.5,
              Math.max(0.5, observedInput / task.pendingTokenEstimate),
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
              m.id === `assistant:${id}` ? { ...m, error: event.message } : m,
            );
          setTasks((all) =>
            all.map((task) =>
              task.id === taskId
                ? {
                    ...task,
                    messages: updateMessages(task.messages),
                    runningId: undefined,
                    runStatus: "failed",
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
          assistantLengthsRef.current.delete(id);
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
                runStatus: "completed",
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
            setAgentReasoning("");
          }
          requestTasksRef.current.delete(id);
          assistantLengthsRef.current.delete(id);
        }
      }) ?? (() => undefined),
    [],
  );
  useEffect(() => {
    const pending = pendingScrollRestoreRef.current;
    if (!pending || pending.taskId !== activeTaskId) return;
    const frame = requestAnimationFrame(() => {
      const conversation = conversationRef.current;
      if (!conversation || displayedTaskIdRef.current !== pending.taskId)
        return;
      const top = pending.state.atBottom
        ? conversation.scrollHeight
        : Math.min(
            pending.state.top,
            Math.max(0, conversation.scrollHeight - conversation.clientHeight),
          );
      conversation.scrollTop = top;
      autoFollowRef.current = pending.state.atBottom;
      setShowScrollToBottom(!pending.state.atBottom);
      pendingScrollRestoreRef.current = undefined;
      updateActiveTurn(conversation);
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTaskId, messages.length, activities.length]);
  useEffect(() => {
    const forceAfterSend = scrollAfterSendRef.current;
    if (pendingScrollRestoreRef.current) return;
    if ((!autoFollowEnabled || !autoFollowRef.current) && !forceAfterSend)
      return;
    if (followFrameRef.current) cancelAnimationFrame(followFrameRef.current);
    followFrameRef.current = requestAnimationFrame(() => {
      scrollAfterSendRef.current = false;
      const conversation = conversationRef.current;
      if (conversation) {
        conversation.scrollTop = conversation.scrollHeight;
        setShowScrollToBottom(false);
        setActiveConversationTurn(conversationTurns.at(-1)?.id);
      }
    });
    return () => {
      if (followFrameRef.current) cancelAnimationFrame(followFrameRef.current);
    };
  }, [autoFollowEnabled, messages, activities, conversationTurns]);

  async function clearCurrentConversation() {
    const requestId = currentRequest.current;
    if (requestId && window.kcode) await window.kcode.chat.cancel(requestId);
    if (previewTimerRef.current) window.clearInterval(previewTimerRef.current);
    currentRequest.current = undefined;
    setRunningId(undefined);
    setMessages([]);
    setActivities([]);
    clearInput();
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
    claimTaskView(task.id);
    setActiveTaskId(task.id);
    setMessages([]);
    setActivities([]);
    clearInput();
    setAttachedFiles([]);
    setAttachedImages([]);
    setUsage({ input: 0, output: 0, cached: 0 });
    setUsageResolved(false);
    setDurationMs(0);
    setUsedContextCount(0);
    currentRequest.current = undefined;
    setRunningId(undefined);
    setAgentReasoning("");
    requestStartedRef.current = undefined;
    contextByMessageRef.current.clear();
    autoFollowRef.current = true;
    setPendingFolder(null);
    setNewTaskName("");
  }

  async function switchTask(task: TaskRecord) {
    if (task.id === activeTaskId) return;
    const conversation = conversationRef.current;
    if (conversation && displayedTaskIdRef.current) {
      const atBottom =
        conversation.scrollHeight -
          conversation.scrollTop -
          conversation.clientHeight <
        72;
      scrollStateByTaskRef.current.set(displayedTaskIdRef.current, {
        top: conversation.scrollTop,
        atBottom,
      });
    }
    const targetScroll = scrollStateByTaskRef.current.get(task.id) ?? {
      top: 0,
      atBottom: true,
    };
    pendingScrollRestoreRef.current = { taskId: task.id, state: targetScroll };
    claimTaskView(task.id);
    currentRequest.current = task.runningId;
    setRunningId(task.runningId);
    requestStartedRef.current = task.startedAt;
    setActiveTaskId(task.id);
    setMessages(task.messages);
    setActivities(task.activities);
    setSelected(task.modelSelection || selected);
    setReasoningEffort(task.reasoningEffort || defaultReasoningEffort);
    clearInput();
    setAttachedFiles([]);
    setUsage(task.usage ?? { input: 0, output: 0, cached: 0 });
    setUsageResolved(Boolean(task.usageResolved));
    setDurationMs(task.durationMs ?? 0);
    setUsedContextCount(task.usedContextCount ?? 0);
    setAttachedImages([]);
    contextByMessageRef.current.clear();
    autoFollowRef.current = targetScroll.atBottom;
    setShowScrollToBottom(!targetScroll.atBottom);
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
    claimTaskView(task.id);
    setActiveTaskId(task.id);
    setMessages([]);
    setActivities([]);
    clearInput();
    setAttachedFiles([]);
    setUsage({ input: 0, output: 0, cached: 0 });
    setUsageResolved(false);
    setDurationMs(0);
    setAttachedImages([]);
    currentRequest.current = undefined;
    setRunningId(undefined);
    contextByMessageRef.current.clear();
    pendingScrollRestoreRef.current = undefined;
    autoFollowRef.current = true;
    setShowScrollToBottom(false);
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
        claimTaskView(next.id);
        setActiveTaskId(next.id);
        setMessages(next.messages);
        setActivities(next.activities);
        setRunningId(next.runningId);
        currentRequest.current = next.runningId;
        requestStartedRef.current = next.startedAt;
        setSelected(next.modelSelection || selected);
        setReasoningEffort(next.reasoningEffort || defaultReasoningEffort);
      } else {
        claimTaskView("");
        setActiveTaskId("");
        setMessages([]);
        setActivities([]);
        setRunningId(undefined);
        currentRequest.current = undefined;
        requestStartedRef.current = undefined;
        clearInput();
        setAttachedFiles([]);
        setAttachedImages([]);
        setUsage({ input: 0, output: 0, cached: 0 });
        setUsageResolved(false);
        setDurationMs(0);
      }
    }
  }

  function toggleTaskArchived(task: TaskRecord) {
    const archived = !task.archived;
    setTasks((current) =>
      current.map((item) =>
        item.id === task.id
          ? { ...item, archived, updatedAt: Date.now() }
          : item,
      ),
    );
    if (archived && task.id === activeTaskId) {
      const next = tasks.find((item) => item.id !== task.id && !item.archived);
      if (next) void switchTask(next);
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
    flashContextToast(
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
          connections: [],
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
    flashContextToast("已恢复完整上下文；聊天记录没有被删除");
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
    flashContextToast("已恢复所选摘要版本");
  }

  async function send(override?: string) {
    let text = (override ?? readInput()).trim();
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
    const taskId = activeTask.id;
    if (
      !isTaskViewCurrent(
        activeTaskIdRef.current,
        displayedTaskIdRef.current,
        taskId,
      )
    ) {
      setContextError("任务切换尚未完成，请重新发送");
      return;
    }
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
          (message.error || message.content.startsWith("请求失败："))
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
    const visibleMessages = retrying ? messages : [...messages, user];
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
    // Use the last round's prompt tokens as the observed floor, not the
    // accumulated billing total (usage.input) which grows every round and would
    // otherwise inflate the estimate and trigger premature compaction.
    const estimatedTokens = Math.max(
      usage.promptTokens ?? 0,
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
    scrollAfterSendRef.current = true;
    setShowScrollToBottom(false);
    const requestStartedAt = Date.now();
    requestStartedRef.current = requestStartedAt;
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
    if (contextNotice) flashContextToast(contextNotice);
    setMessages(visibleMessages);
    clearInput();
    setUsage({ input: 0, output: 0, cached: 0 });
    setUsageResolved(false);
    setDurationMs(0);
    if (!window.kcode) {
      const id = `preview:${uid()}`;
      const response = `我已经检查了当前项目${contextByMessageRef.current.get(user.id)?.length ? `和 **${contextByMessageRef.current.get(user.id)?.length} 个上下文文件**` : ""}。当前使用${effortLabels[reasoningEffort]}推理强度，下一步建议优先完成：\n\n1. 接入工作区文件读取与代码搜索\n2. 建立工具调用的权限确认流程\n3. 在任务右侧展示实时执行进度\n\n\`\`\`ts\nconst result = await agent.run({\n  workspace: \"D:/project/kcode\",\n  model: \"${target.model.modelId}\",\n});\n\`\`\`\n\n> 当前模型通道正常，桌面端可以继续接入 Agent 工具循环。`;
      const chunks = response.match(/[\s\S]{1,12}/g) ?? [response];
      currentRequest.current = id;
      setRunningId(id);
      if (activeTask?.id)
        setTasks((all) =>
          all.map((task) =>
            task.id === activeTask.id
              ? {
                  ...task,
                  runningId: id,
                  runStatus: "running",
                  startedAt: requestStartedRef.current,
                  updatedAt: Date.now(),
                }
              : task,
          ),
        );
      setMessages([
        ...visibleMessages,
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
          if (activeTask?.id)
            setTasks((all) =>
              all.map((task) =>
                task.id === activeTask.id
                  ? {
                      ...task,
                      runningId: undefined,
                      runStatus: "completed",
                      updatedAt: Date.now(),
                    }
                  : task,
              ),
            );
          setUsage({ input: 312, output: 168, cached: 0 });
          setUsageResolved(true);
          if (requestStartedRef.current)
            setDurationMs(Date.now() - requestStartedRef.current);
        }
      }, 45);
      return;
    }
    const id = await window.kcode.chat.start({
      taskId,
      providerId: target.provider.id,
      modelId: target.model.modelId,
      messages: history,
      reasoningEffort,
      permissionMode,
      permissionPolicy,
      workspacePath: activeTask.workspacePath,
      contextWindow: selectedContextWindow,
    });
    requestTasksRef.current.set(id, taskId);
    assistantLengthsRef.current.set(id, 0);
    const assistantMessage: ChatMessage = {
      id: `assistant:${id}`,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      model: target.model.displayName,
    };
    const stillActive = isTaskViewCurrent(
      activeTaskIdRef.current,
      displayedTaskIdRef.current,
      taskId,
    );
    if (stillActive) {
      currentRequest.current = id;
      setRunningId(id);
      setMessages((all) => [...all, assistantMessage]);
    }
    setTasks((all) =>
      all.map((task) =>
        task.id === taskId
          ? {
              ...task,
              messages: [...visibleMessages, assistantMessage],
              runningId: id,
              runStatus: "running",
              startedAt: requestStartedAt,
              pendingTokenEstimate: rawEstimatedTokens,
              pendingCalibrationKey: requestCalibrationKey,
              updatedAt: Date.now(),
            }
          : task,
      ),
    );
  }

  sendRef.current = send;
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
              ? {
                  ...task,
                  runningId: undefined,
                  runStatus: "cancelled",
                  updatedAt: Date.now(),
                }
              : task,
          ),
        );
      requestTasksRef.current.delete(runningId);
      assistantLengthsRef.current.delete(runningId);
    }
  }
  async function resumeCheckpoint(checkpoint: AgentCheckpoint) {
    if (!activeTask || runningId || summaryBusy) return;
    const taskId = activeTask.id;
    await window.kcode.chat.removeCheckpoint(checkpoint.id);
    const id = await window.kcode.chat.start({
      ...checkpoint.request,
      recoveryContext: checkpoint.subagents?.length
        ? `上次运行在中断前创建了以下子 Agent：\n${checkpoint.subagents
            .map(
              (agent) =>
                `- ${agent.name}：${agent.task}（中断前状态：${agent.status}${agent.error ? `，错误：${agent.error}` : ""}）`,
            )
            .join("\n")}`
        : checkpoint.request.recoveryContext,
      taskId,
      messages: activeTask.messages.map(({ role, content, images }) => ({
        role,
        content,
        images,
      })),
      permissionMode,
      permissionPolicy,
      contextWindow: selectedContextWindow,
    });
    requestTasksRef.current.set(id, taskId);
    assistantLengthsRef.current.set(id, 0);
    const startedAt = Date.now();
    const assistant: ChatMessage = {
      id: `assistant:${id}`,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      model: selectedTarget?.model.displayName,
    };
    const stillActive = isTaskViewCurrent(
      activeTaskIdRef.current,
      displayedTaskIdRef.current,
      taskId,
    );
    if (stillActive) {
      currentRequest.current = id;
      setRunningId(id);
      requestStartedRef.current = startedAt;
      setMessages((all) => [...all, assistant]);
    }
    setTasks((all) =>
      all.map((task) =>
        task.id === taskId
          ? {
              ...task,
              messages: [...task.messages, assistant],
              runningId: id,
              runStatus: "running",
              startedAt,
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
  // The context gauge must reflect what the model actually reads each turn (the
  // last prompt token count), not usage.input, which accumulates every turn's
  // prompt and balloons far past the window in a multi-round agentic run.
  const contextTokens = Math.max(usage.promptTokens ?? 0, localContextTokens);
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
  const runStatus: TaskRunStatus = runningId
    ? "running"
    : (activeTask?.runStatus ?? "idle");
  const taskComplete = runStatus === "completed";
  const runStatusTitle: Record<TaskRunStatus, string> = {
    idle: "准备开发环境",
    running: "Agent 正在执行",
    completed: "本轮任务已完成",
    failed: "本轮任务失败",
    cancelled: "本轮任务已停止",
    paused: "上次任务已中断",
  };
  const latestActivities = activeTask
    ? activities.filter(
        (activity) =>
          !activeTask.runningId || activity.requestId === activeTask.runningId,
      )
    : [];
  const livePhase =
    runStatus === "running"
      ? workingPhase(
          latestActivities,
          Date.now() -
            (activeTask?.startedAt ?? requestStartedRef.current ?? Date.now()),
        ).phase
      : "";
  const runStatusDescription: Record<TaskRunStatus, string> = {
    idle: connected
      ? "模型通道已连接，可以开始执行任务。"
      : "应用骨架已就绪，下一步配置一个模型通道。",
    running: livePhase
      ? `${livePhase}。请保持当前任务打开。`
      : "正在生成响应，请保持当前任务打开。",
    completed: "模型已返回结果，可以继续追加修改要求。",
    failed: "本轮执行遇到错误，请查看对话中的失败原因后重试。",
    cancelled: "本轮执行已停止，可以调整要求后重新发送。",
    paused: "应用上次退出时任务仍在运行，可以从检查点恢复。",
  };
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
      <TitleBar appUpdate={appUpdate} setUpdateOpen={setUpdateOpen} />
      <div
        className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"} ${statusOpen ? "" : "status-collapsed"} ${browserState.open ? "browser-open" : ""}`}
        style={
          {
            "--sidebar-width": `${sidebarWidth}px`,
            "--browser-width": `${browserWidthDrag ?? browserState.width ?? 520}px`,
          } as React.CSSProperties
        }
      >
        <Sidebar
          workspaceGroups={workspaceGroups}
          activeTask={activeTask}
          taskQuery={taskQuery}
          setTaskQuery={setTaskQuery}
          showArchived={showArchived}
          setShowArchived={setShowArchived}
          collapsedWorkspaces={collapsedWorkspaces}
          draggedTaskId={draggedTaskId}
          taskDropTarget={taskDropTarget}
          draggedWorkspace={draggedWorkspace}
          workspaceDropTarget={workspaceDropTarget}
          setDraggedTaskId={setDraggedTaskId}
          setTaskDropTarget={setTaskDropTarget}
          setDraggedWorkspace={setDraggedWorkspace}
          setWorkspaceDropTarget={setWorkspaceDropTarget}
          startNewTask={() => void startNewTask()}
          reorderWorkspace={reorderWorkspace}
          reorderTask={reorderTask}
          toggleWorkspace={toggleWorkspace}
          createConversation={(wp) => void createConversation(wp)}
          switchTask={(task) => void switchTask(task)}
          toggleTaskArchived={toggleTaskArchived}
          setDeleteTarget={setDeleteTarget}
          setContextError={setContextError}
          openSettings={openSettings}
          startSidebarResize={startSidebarResize}
        />
        <main className="main">
          <TopBar
            taskName={activeTask?.name || "新任务"}
            sidebarOpen={sidebarOpen}
            setSidebarOpen={setSidebarOpen}
            statusOpen={statusOpen}
            updateStatusPanel={updateStatusPanel}
            gitState={gitState}
          />
          <ConversationArea
            conversationRef={conversationRef}
            handleConversationScroll={handleConversationScroll}
            conversationTurns={conversationTurns}
            turnButtonRefs={turnButtonRefs}
            activeConversationTurnRef={activeConversationTurnRef}
            scrollToTurn={scrollToTurn}
            messages={messages}
            models={models}
            writeInput={writeInput}
            openSettings={openSettings}
            activitiesByRequest={activitiesByRequest}
            runningId={runningId}
            activeTaskWorkspacePath={activeTask?.workspacePath || ""}
            contextByMessage={contextByMessageRef.current}
            retryContent={lastUserMessage?.content}
            retryMessage={retryMessage}
            handleActivityChange={handleActivityChange}
            registerTurn={registerTurn}
            endRef={endRef}
            agentReasoning={agentReasoning}
          />
          <Composer
            showScrollToBottom={showScrollToBottom}
            scrollToLatest={scrollToLatest}
            attachedImages={attachedImages}
            setAttachedImages={setAttachedImages}
            attachedFiles={attachedFiles}
            setAttachedFiles={setAttachedFiles}
            contextError={contextError}
            setContextError={setContextError}
            contextToast={contextToast}
            inputRef={inputRef}
            summaryBusy={summaryBusy}
            hasInput={hasInput}
            writeInput={writeInput}
            pasteImages={pasteImages}
            modelPickerRef={modelPickerRef}
            modelTriggerRef={modelTriggerRef}
            effortPickerRef={effortPickerRef}
            modelMenuOpen={modelMenuOpen}
            setModelMenuOpen={setModelMenuOpen}
            modelMenuProvider={modelMenuProvider}
            setModelMenuProvider={setModelMenuProvider}
            effortMenuOpen={effortMenuOpen}
            setEffortMenuOpen={setEffortMenuOpen}
            providerModelChoices={providerModelChoices}
            setProviderModelChoices={setProviderModelChoices}
            handleModelMenuKeyDown={handleModelMenuKeyDown}
            selectModel={selectModel}
            selectReasoningEffort={selectReasoningEffort}
            selectedTarget={selectedTarget}
            selectedConnected={selectedConnected}
            selected={selected}
            models={models}
            providers={providers}
            effortLabels={effortLabels}
            reasoningEffort={reasoningEffort}
            efforts={efforts}
            runningId={runningId}
            pickContextFiles={pickContextFiles}
            usage={usage}
            send={send}
            cancel={cancel}
            openSettings={openSettings}
          />
        </main>
        {!browserState.open && (
          <StatusPanel
            runStatus={runStatus}
            taskComplete={taskComplete}
            runStatusTitle={runStatusTitle}
            runStatusDescription={runStatusDescription}
            connected={connected}
            providers={providers}
            models={models}
            selectedTarget={selectedTarget}
            effortLabels={effortLabels}
            reasoningEffort={reasoningEffort}
            checkpoints={checkpoints}
            activeTask={activeTask}
            runningId={runningId}
            summaryBusy={summaryBusy}
            resumeCheckpoint={resumeCheckpoint}
            gitRefreshing={gitRefreshing}
            refreshGitState={refreshGitState}
            gitState={gitState}
            gitDiffOpen={gitDiffOpen}
            setGitDiffOpen={setGitDiffOpen}
            durationMs={durationMs}
            messages={messages}
            usage={usage}
            usageResolved={usageResolved}
            usedContextCount={usedContextCount}
            selectedContextWindow={selectedContextWindow}
            contextTokens={contextTokens}
            calibrationFactor={calibrationFactor}
            compactActiveConversation={compactActiveConversation}
            summaryOpen={summaryOpen}
            setSummaryOpen={setSummaryOpen}
            restoreSummarySnapshot={restoreSummarySnapshot}
            rebuildActiveSummary={rebuildActiveSummary}
            restoreFullContext={restoreFullContext}
            permissionMode={permissionMode}
          />
        )}
        <BrowserPanel
          browserState={browserState}
          browserAddress={browserAddress}
          setBrowserAddress={setBrowserAddress}
          startBrowserResize={startBrowserResize}
        />
        {updateOpen && (
          <AppUpdateDialog
            state={appUpdate}
            onClose={() => setUpdateOpen(false)}
          />
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
            onClose={closeSettings}
          />
        )}
        {pendingFolder && (
          <NewTaskDialog
            pendingFolder={pendingFolder}
            newTaskName={newTaskName}
            setNewTaskName={setNewTaskName}
            createTask={createTask}
            onClose={() => setPendingFolder(null)}
          />
        )}
        {deleteTarget && (
          <DeleteDialog
            deleteTarget={deleteTarget}
            onClose={() => setDeleteTarget(undefined)}
            removeWorkspace={removeWorkspace}
            removeTask={removeTask}
          />
        )}
      </div>
    </div>
  );
}
