import { useTaskScheduling } from "./app/useTaskScheduling";
import { useRemoteTaskCommands } from "./app/useRemoteTaskCommands";
import { useRemoteControl } from "./app/useRemoteControl";
import { useTaskPersistence } from "./app/useTaskPersistence";
import { useChatSubmission } from "./app/useChatSubmission";
import { useConversationContext } from "./app/useConversationContext";
import { useEditReview } from "./app/useEditReview";
import { useComposerAttachments } from "./app/useComposerAttachments";
import {
  readCollapsedWorkspaces,
  writeCollapsedWorkspaces,
  writeStoredTaskDrafts,
} from "./lib/ui-preferences";
import { useAgentStream } from "./app/useAgentStream";
import { useConversationViewport } from "./app/useConversationViewport";
import { useTaskActions } from "./app/useTaskActions";
import { ChatComposer } from "./app/ChatComposer";

import {
  estimateRequestContextTokens,
  outputTokenReserve,
  resolveWorkspaceView,
  type TaskPagingState,
} from "./app/app-utils";
import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  FolderSearch,
} from "lucide-react";
import { resolveModelContextWindow } from "./types";

import type { SshRemoteState } from "./ssh-remote-types";
import { restoreSshRemoteConnection } from "./ssh-remote-recovery";

import { localWorkspacePath, taskWorkspaceName } from "./task-workspace";

import {
  AGENT_STATIC_TOKENS,
  estimateMessageTokens,
  estimateTextTokens,
  retainedCompactionContext,
} from "./context";
import {
  assistantRequestId,
  recoveryActivitiesFromCheckpoint,
  recoveryCompletionResultFromCheckpoint,
  recoveryEvidenceFromActivities,
  recoveryPlanFromCompletionResult,
  recoveryPlanFromActivities,
} from "./interrupted-run-context";
import { contextUsageTokens } from "./context-window";
import {
  ACCENT_OPTIONS,
  initialTask,
  storedTaskDrafts,
  uid,
  type AccentPreference,
  type ConversationScrollState,
  type QueuedChatMessage,
  type SettingsSection,
  type TaskCollaboration,
  type TaskDrafts,
  type TaskRecord,
  type ThemePreference,
} from "./models";
import { sidebarWorkspaceKey } from "./sidebar-projection";
import {
  conversationTurnPreviews,
  latestConversationWindow,
  scrollContainerToElementTop,
  type ConversationWindow,
} from "./conversation-window";
import { ConversationScrollController } from "./conversation-scroll-controller";
import { taskRuntimeStore } from "./task-runtime-store";
import {
  storedActiveTask,
  storedTasks,
  storedTokenCalibration,
} from "./lib/storage";
import {
  effortLabels,
  normalizeEffort,
  policyForMode,
  previewProviders,
  reasoningEffortsForModel,
  savedEfforts,
} from "./lib/model-utils";
import { errorMessage } from "./lib/format";
import { latestRequestActivities } from "./status-summary";

import { contextDialogDirectory } from "./context-directory";
// Heavy, behind-a-click panels — lazy so they stay off the first-paint bundle.
const SettingsPanel = lazy(() =>
  import("./components/settings/SettingsPanel").then((m) => ({
    default: m.SettingsPanel,
  })),
);
const SshRemoteDialog = lazy(() =>
  import("./components/remote/SshRemoteDialog").then((module) => ({
    default: module.SshRemoteDialog,
  })),
);
const SshRemoteEditor = lazy(
  () => import("./components/remote/SshRemoteEditor"),
);
const LocalWorkspaceEditor = lazy(
  () => import("./components/editor/LocalWorkspaceEditor"),
);
import { ConversationArea } from "./components/conversation/ConversationArea";
import { ConversationSearch } from "./components/conversation/ConversationSearch";
import { type ComposerTextareaHandle } from "./components/composer/ComposerTextarea";

const AppUpdateDialog = lazy(() =>
  import("./components/dialogs/AppUpdateDialog").then((m) => ({
    default: m.AppUpdateDialog,
  })),
);
import {
  AssignFolderDialog,
  DeleteDialog,
  NewTaskDialog,
  RenameDialog,
} from "./components/dialogs/TaskDialogs";
import { BrowserPanel } from "./components/browser/BrowserPanel";
import { TitleBar } from "./components/chrome/TitleBar";
import { TopBar } from "./components/topbar/TopBar";
import type { SidebarLocalWorkspaceTarget } from "./components/sidebar/Sidebar";
import { TaskSidebar } from "./components/sidebar/TaskSidebar";
import { StatusPanel } from "./components/status/StatusPanel";
import { COMPOSER_STREAM_PAUSE_MS, StreamPacingBuffer } from "./stream-pacing";

import { selectActivityGroups, upsertActivity } from "./activity-index";

import { registerAppToastHandler, type AppToast } from "./lib/toast";
import { useEventCallback } from "./lib/use-event-callback";
import {
  composerModifierKeyLabel,
  prioritizeQueuedInMessages,
  resolveComposerSubmitAction,
} from "./composer-queue";
import {
  designElementChipLabel,
  mergeDesignElements,
  type DesignElementContext,
} from "./design-mode";
import { isTaskViewCurrent, type TaskRunStatus } from "./task-status";

import type {
  AgentActivity,
  AgentCheckpoint,
  AppUpdateState,
  ChatMessage,
  ContextFile,
  ProviderConfig,
  PermissionMode,
  PermissionPolicy,
  ReasoningEffort,
  WorkspaceFolder,
  GitWorkspaceState,
  ImageAttachment,
} from "./types";

export default function App() {
  const initialDrafts = useRef<TaskDrafts>(storedTaskDrafts());
  const attachmentDraftsRef = useRef(
    new Map<string, { files: ContextFile[]; images: ImageAttachment[] }>(),
  );
  const creatingConversationPathsRef = useRef(new Set<string>());
  const [creatingConversationPaths, setCreatingConversationPaths] = useState(
    () => new Set<string>(),
  );
  const [tasks, setTasks] = useState<TaskRecord[]>(() =>
    localStorage.getItem("kcode.tasks") === null
      ? [initialTask()]
      : storedTasks(),
  );
  const [taskPagingById, setTaskPagingById] = useState<
    Record<string, TaskPagingState>
  >({});
  const [activeTaskId, setActiveTaskId] = useState(
    () => localStorage.getItem("kcode.activeTaskId") || "",
  );
  const [pendingFolder, setPendingFolder] = useState<WorkspaceFolder | null>(
    null,
  );
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [assignFolderForTask, setAssignFolderForTask] =
    useState<TaskRecord | null>(null);
  const [sshRemoteDialogTaskId, setSshRemoteDialogTaskId] = useState<string>();
  const [sshRemoteState, setSshRemoteState] = useState<SshRemoteState>();
  const [workspaceView, setWorkspaceView] = useState<"chat" | "editor">(() =>
    storedActiveTask()?.remoteWorkspace ? "editor" : "chat",
  );
  const [deleteTarget, setDeleteTarget] = useState<
    | { kind: "workspace"; workspaceKey: string; name: string; count: number }
    | { kind: "task"; task: TaskRecord }
  >();
  const [renameTarget, setRenameTarget] = useState<
    | { kind: "task"; id: string; name: string }
    | { kind: "workspace"; workspaceKey: string; name: string }
  >();
  const [newTaskName, setNewTaskName] = useState("");
  const [taskQuery, setTaskQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("kcode.sidebarWidth"));
    return Number.isFinite(saved) && saved >= 210 && saved <= 420 ? saved : 256;
  });
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(
    readCollapsedWorkspaces,
  );
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => storedActiveTask()?.messages ?? [],
  );
  const [activities, setActivities] = useState<AgentActivity[]>(
    () => storedActiveTask()?.activities ?? [],
  );
  const [input, setInputState] = useState(
    () => initialDrafts.current[storedActiveTask()?.id ?? ""] ?? "",
  );
  const [editingQueuedMessageId, setEditingQueuedMessageId] =
    useState<string>();
  const [queuedMessageDraft, setQueuedMessageDraft] = useState("");
  useEffect(() => {
    setEditingQueuedMessageId(undefined);
    setQueuedMessageDraft("");
  }, [activeTaskId]);
  const composerRef = useRef<ComposerTextareaHandle>(null);
  const composerSurfaceRef = useRef<HTMLDivElement>(null);
  const composerValueRef = useRef(input);
  function readComposerValue() {
    const value = composerRef.current?.getValue() ?? composerValueRef.current;
    composerValueRef.current = value;
    return value;
  }
  function setInput(value: string) {
    composerValueRef.current = value;
    composerRef.current?.replaceValue(value);
    setInputState(value);
  }
  function composerHeightBounds(textarea: HTMLTextAreaElement) {
    const styles = getComputedStyle(textarea);
    const parsedMin = Number.parseFloat(styles.minHeight);
    const parsedMax = Number.parseFloat(styles.maxHeight);
    const min = Number.isFinite(parsedMin) ? parsedMin : 54;
    const max = Number.isFinite(parsedMax)
      ? parsedMax
      : Math.min(260, window.innerHeight * 0.36);
    return { min, max: Math.max(min, max) };
  }
  function applyComposerHeight(height: number, persist = false) {
    const textarea = composerSurfaceRef.current?.querySelector("textarea");
    if (!textarea) return;
    const { min, max } = composerHeightBounds(textarea);
    const next = Math.min(max, Math.max(min, height));
    textarea.style.height = `${next}px`;
    if (persist)
      localStorage.setItem("kcode.composerHeight", String(Math.round(next)));
  }
  useLayoutEffect(() => {
    const saved = Number.parseFloat(
      localStorage.getItem("kcode.composerHeight") || "",
    );
    if (Number.isFinite(saved)) applyComposerHeight(saved);
  }, []);
  const [settings, setSettings] = useState(false);
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const searchPreviousTurnWindowRef = useRef<ConversationWindow | undefined>(
    undefined,
  );
  const [theme, setTheme] = useState<ThemePreference>(() => {
    const saved = localStorage.getItem("kcode.theme");
    if (saved === "light" || saved === "dark" || saved === "system")
      return saved;
    return "dark";
  });
  const [accent, setAccent] = useState<AccentPreference>(() => {
    const saved = localStorage.getItem("kcode.accent");
    return ACCENT_OPTIONS.some((o) => o.value === saved)
      ? (saved as AccentPreference)
      : "blue";
  });
  useEffect(() => {
    document.documentElement.dataset.accent = accent;
  }, [accent]);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>({
    status: "idle",
    currentVersion: "",
    portable: false,
  });
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    applyTheme();
    if (theme !== "system") return;
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [theme]);
  useEffect(() => {
    const updater = window.kcode?.updater;
    if (!updater) return;
    let active = true;
    void updater.state().then((state) => {
      if (active) setAppUpdate(state);
    });
    const unsubscribe = updater.onState((state) => {
      if (active) setAppUpdate(state);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (["available", "downloaded"].includes(appUpdate.status))
      setUpdateOpen(true);
  }, [appUpdate.status, appUpdate.version]);
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
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const [statusOpen, setStatusOpen] = useState(
    () => localStorage.getItem("kcode.statusPanel") !== "false",
  );
  useEffect(() => {
    const compact = window.matchMedia("(max-width: 620px)");
    const collapseForCompactLayout = (matches: boolean) => {
      if (matches) setSidebarOpen(false);
    };
    collapseForCompactLayout(compact.matches);
    const onChange = (event: MediaQueryListEvent) =>
      collapseForCompactLayout(event.matches);
    compact.addEventListener("change", onChange);
    return () => compact.removeEventListener("change", onChange);
  }, []);
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
  const [composerDragActive, setComposerDragActive] = useState(false);
  const composerDragDepthRef = useRef(0);
  const [contextDirectory, setContextDirectory] = useState(
    () => localStorage.getItem("kcode.contextDirectory") || "",
  );
  const [contextError, setContextError] = useState("");
  useEffect(() => {
    const resetComposerDrag = () => {
      composerDragDepthRef.current = 0;
      setComposerDragActive(false);
    };
    window.addEventListener("drop", resetComposerDrag);
    window.addEventListener("dragend", resetComposerDrag);
    window.addEventListener("blur", resetComposerDrag);
    return () => {
      window.removeEventListener("drop", resetComposerDrag);
      window.removeEventListener("dragend", resetComposerDrag);
      window.removeEventListener("blur", resetComposerDrag);
    };
  }, []);
  // A transient notice (compaction done, summary restored) that flashes above the
  // composer and auto-dismisses, unlike contextError which stays until closed.
  const [contextToast, setContextToast] = useState("");
  const contextToastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [appToast, setAppToast] = useState<AppToast>();
  const appToastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flashAppToast = useCallback(
    (message: string, tone: "success" | "error" = "success") => {
      setAppToast({ id: Date.now(), message, tone });
      if (appToastTimer.current) clearTimeout(appToastTimer.current);
      appToastTimer.current = setTimeout(() => setAppToast(undefined), 1_800);
    },
    [],
  );
  useEffect(() => {
    const unregister = registerAppToastHandler(flashAppToast);
    return () => {
      unregister();
      if (appToastTimer.current) clearTimeout(appToastTimer.current);
    };
  }, [flashAppToast]);
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
    verificationRequired?: boolean;
    verificationSince?: number;
    verificationMessage?: string;
    designMode?: boolean;
  }>({ open: false });
  const [designElements, setDesignElements] = useState<DesignElementContext[]>(
    [],
  );
  const [browserAddress, setBrowserAddress] = useState("");
  useEffect(() => window.kcode?.browser?.onState(setBrowserState), []);
  useEffect(
    () =>
      window.kcode?.browser?.onDesignElement?.((details) => {
        const { sessionId: _sessionId, ...rest } = details;
        setDesignElements((all) =>
          mergeDesignElements(all, rest as DesignElementContext),
        );
      }),
    [],
  );
  useEffect(
    () => setBrowserAddress(browserState.url || ""),
    [browserState.url],
  );
  useEffect(() => {
    if (!browserState.open) return;
    const compactSplit = window.matchMedia("(max-width: 1100px)");
    const collapseForCompactSplit = (matches: boolean) => {
      if (matches) setSidebarOpen(false);
    };
    collapseForCompactSplit(compactSplit.matches);
    const onChange = (event: MediaQueryListEvent) =>
      collapseForCompactSplit(event.matches);
    compactSplit.addEventListener("change", onChange);
    return () => compactSplit.removeEventListener("change", onChange);
  }, [browserState.open]);
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
  const [gitRefreshing, setGitRefreshing] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [scrollingToBottom, setScrollingToBottom] = useState(false);
  const [historyLoadingTaskId, setHistoryLoadingTaskId] = useState<string>();
  const [checkpoints, setCheckpoints] = useState<AgentCheckpoint[]>([]);
  const [durationMs, setDurationMs] = useState(
    () => storedActiveTask()?.durationMs ?? 0,
  );
  const currentRequest = useRef<string | undefined>(undefined);
  const requestTasksRef = useRef(new Map<string, string>());
  const pendingTextRef = useRef(new Map<string, StreamPacingBuffer>());
  const pendingTextSinceRef = useRef(new Map<string, number>());
  // Keep streaming responsive without asking React and layout to work at 60fps.
  const textFlushTimerRef = useRef<number | undefined>(undefined);
  const pendingReasoningRef = useRef(new Map<string, string>());
  const reasoningFlushTimerRef = useRef<number | undefined>(undefined);
  const activeTaskIdRef = useRef(activeTaskId);
  const displayedTaskIdRef = useRef(activeTaskId);
  const prevActiveTaskIdForAnimRef = useRef(activeTaskId);
  const taskSwitchDirectionRef = useRef<1 | -1>(1);
  const [taskSwitchPending, setTaskSwitchPending] = useState(false);
  const tasksRef = useRef(tasks);
  const remoteStreamTimersRef = useRef(new Map<string, number>());
  const remoteStreamSequencesRef = useRef(new Map<string, number>());
  const remoteRuntimeMetaRef = useRef(
    new Map<
      string,
      {
        eventId?: string;
        eventKind?: string;
        itemStatus?: string;
        sequence?: number;
        protocolVersion?: number;
      }
    >(),
  );
  const agentEventSequencesRef = useRef(new Map<string, number>());
  const taskPagingRef = useRef(new Map<string, TaskPagingState>());
  const fullHistoryLoadsRef = useRef(new Map<string, Promise<TaskRecord>>());
  const taskSwitchSequenceRef = useRef(0);
  const followFrameRef = useRef<number | undefined>(undefined);
  const bottomLayoutFrameRef = useRef<number | undefined>(undefined);
  const bottomSettleTimerRef = useRef<number | undefined>(undefined);
  const bottomSettleDeadlineRef = useRef(0);
  const bottomIndicatorUntilRef = useRef(0);
  const bottomSettlePassesRef = useRef(0);
  const pendingLatestScrollRef = useRef<ScrollBehavior | undefined>(undefined);
  const scrollFrameRef = useRef<number | undefined>(undefined);
  const conversationScrollControllerRef = useRef(
    new ConversationScrollController(),
  );
  const scrollStateByTaskRef = useRef(
    new Map<string, ConversationScrollState>(),
  );
  const conversationWindowByTaskRef = useRef(
    new Map<string, ConversationWindow>(),
  );
  const pendingScrollRestoreRef = useRef<
    { taskId: string; state: ConversationScrollState } | undefined
  >(undefined);
  const scrollAfterSendRef = useRef(false);
  const programmaticScrollRef = useRef(false);
  const turnLayoutFrameRef = useRef<number | undefined>(undefined);
  const scrollTargetRef = useRef<HTMLElement | null>(null);
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const requestStartedRef = useRef<number | undefined>(undefined);
  const composerSubmitRef = useRef<() => void>(() => undefined);
  const composerSubmitImmediateRef = useRef<() => void>(() => undefined);
  const composerPasteRef = useRef<
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => void
  >(() => undefined);
  const composerInputBusyUntilRef = useRef(0);
  const handleComposerSubmit = useCallback(
    () => composerSubmitRef.current(),
    [],
  );
  const handleComposerSubmitImmediate = useCallback(
    () => composerSubmitImmediateRef.current(),
    [],
  );
  const handleComposerPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) =>
      composerPasteRef.current(event),
    [],
  );
  const handleComposerInputActivity = useCallback(() => {
    composerInputBusyUntilRef.current =
      performance.now() + COMPOSER_STREAM_PAUSE_MS;
  }, []);
  const updateTaskDraft = useCallback((value: string) => {
    composerValueRef.current = value;
    const taskId = displayedTaskIdRef.current;
    if (taskId) {
      if (value) initialDrafts.current[taskId] = value;
      else delete initialDrafts.current[taskId];
    }
  }, []);
  const writeTaskDrafts = useCallback(() => {
    writeStoredTaskDrafts(initialDrafts.current);
  }, []);
  const persistTaskDrafts = useCallback(
    (value?: string) => {
      const latestValue =
        typeof value === "string"
          ? value
          : (composerRef.current?.getValue() ?? composerValueRef.current);
      updateTaskDraft(latestValue);
      writeTaskDrafts();
    },
    [updateTaskDraft, writeTaskDrafts],
  );
  const clearTaskDraft = useCallback(
    (taskId: string) => {
      delete initialDrafts.current[taskId];
      writeTaskDrafts();
    },
    [writeTaskDrafts],
  );
  useEffect(() => {
    const persistWhenHidden = () => {
      if (document.visibilityState === "hidden") persistTaskDrafts();
    };
    const persistOnWindowBlur = () => persistTaskDrafts();
    window.addEventListener("blur", persistOnWindowBlur);
    document.addEventListener("visibilitychange", persistWhenHidden);
    return () => {
      window.removeEventListener("blur", persistOnWindowBlur);
      document.removeEventListener("visibilitychange", persistWhenHidden);
    };
  }, [persistTaskDrafts]);
  useEffect(() => {
    composerValueRef.current = input;
    composerRef.current?.replaceValue(input);
  }, [input]);
  const contextByMessageRef = useRef(new Map<string, ContextFile[]>());
  const designByMessageRef = useRef(new Map<string, DesignElementContext[]>());
  const sendRef = useRef<((override?: string) => Promise<void>) | undefined>(
    undefined,
  );
  // Synchronous in-flight lock for manual send(): runningId is only written
  // to state after several awaits (history load, SSH reconnect), so the
  // runningId/runStatus guard cannot catch a second click inside that window.
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const effortPickerRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const conversationRef = useRef<HTMLElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const turnRailRef = useRef<HTMLElement>(null);
  const autoFollowRef = useRef(true);
  const turnRefs = useRef(new Map<string, HTMLDivElement>());
  const turnButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const turnPositionsRef = useRef<{ id: string; top: number }[]>([]);
  const activeConversationTurnRef = useRef<string | undefined>(undefined);
  const pendingTurnTargetRef = useRef<string | undefined>(undefined);
  const windowScrollAnchorRef = useRef<
    { turnId: string; viewportOffset: number } | undefined
  >(undefined);
  const loadingOlderTurnsRef = useRef(false);
  const pagedTaskRef = useRef<string | undefined>(undefined);
  const gitRefreshActivityRef = useRef<string | undefined>(undefined);
  const adoptedSshActivitiesRef = useRef(new Set<string>());
  const [conversationPageSize, setConversationPageSize] = useState(18);
  const [visibleTurnWindow, setVisibleTurnWindow] =
    useState<ConversationWindow>({ start: 0, end: 0 });
  const [turnRailOverflow, setTurnRailOverflow] = useState({
    // Default session opens following the bottom of the thread.
    up: true,
    down: false,
  });
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
  function rememberTaskPaging(taskId: string, paging: TaskPagingState) {
    taskPagingRef.current.set(taskId, paging);
    setTaskPagingById((current) =>
      current[taskId] === paging ? current : { ...current, [taskId]: paging },
    );
  }
  function forgetTaskPaging(taskId: string) {
    taskPagingRef.current.delete(taskId);
    fullHistoryLoadsRef.current.delete(taskId);
    setTaskPagingById((current) => {
      if (!(taskId in current)) return current;
      const next = { ...current };
      delete next[taskId];
      return next;
    });
  }
  const claimTaskView = (taskId: string) => {
    activeTaskIdRef.current = taskId;
    displayedTaskIdRef.current = taskId;
  };

  const activeTask = useMemo(
    () => tasks.find((task) => task.id === activeTaskId) ?? tasks[0],
    [tasks, activeTaskId],
  );
  if (prevActiveTaskIdForAnimRef.current !== activeTaskId) {
    const order = tasks.map((task) => task.id);
    const from = order.indexOf(prevActiveTaskIdForAnimRef.current);
    const to = order.indexOf(activeTaskId);
    if (from >= 0 && to >= 0 && from !== to) {
      taskSwitchDirectionRef.current = to > from ? 1 : -1;
    }
    prevActiveTaskIdForAnimRef.current = activeTaskId;
  }
  useEffect(() => {
    const remote = activeTask?.remoteWorkspace;
    const api = window.kcode?.sshRemote;
    if (!activeTask || !remote || !api) {
      setSshRemoteState(undefined);
      return;
    }
    let active = true;
    setSshRemoteState((current) => ({
      taskId: activeTask.id,
      connected:
        current?.taskId === activeTask.id && Boolean(current.connected),
      connecting: true,
      profile: remote,
      cachePath: activeTask.workspacePath,
    }));
    void restoreSshRemoteConnection(api, activeTask.id, remote)
      .then((state) => {
        if (!active) return;
        attachConnectedSshState(activeTask.id, state);
        setSshRemoteState(state);
      })
      .catch(async (error) => {
        const state = await api
          .state(activeTask.id, remote.id)
          .catch(() => undefined);
        if (active)
          setSshRemoteState({
            taskId: activeTask.id,
            connected: false,
            connecting: false,
            ...state,
            profile: state?.profile ?? remote,
            cachePath: state?.cachePath ?? activeTask.workspacePath,
            error: errorMessage(error),
          });
      });
    return () => {
      active = false;
    };
  }, [
    activeTask?.id,
    activeTask?.remoteWorkspace?.id,
    activeTask?.remoteWorkspace?.rootPath,
  ]);
  const effectiveContextDirectory = contextDialogDirectory(
    activeTask?.contextDirectory,
    contextDirectory,
  );
  const { taskStorageReady, hydratedTaskIdsRef, persistedTaskRefsRef } =
    useTaskPersistence({
      tasks,
      tasksRef,
      setTasks,
      requestTasksRef,
      agentEventSequencesRef,
      rememberTaskPaging,
      taskPagingRef,
      claimTaskView,
      setActiveTaskId,
      setMessages,
      setActivities,
      setInput,
      initialDrafts,
      setRunningId,
      currentRequest,
      requestStartedRef,
      setContextError,
    });
  useEffect(() => {
    if (window.kcode?.browser)
      void window.kcode.browser.activate(activeTask?.id);
  }, [activeTask?.id]);
  const models = useMemo(
    () =>
      providers
        .filter((p) => p.enabled)
        .flatMap((p) => p.models.map((m) => ({ provider: p, model: m }))),
    [providers],
  );
  const selectedTarget = useMemo(
    () =>
      models.find(
        (item) => `${item.provider.id}|${item.model.id}` === selected,
      ),
    [models, selected],
  );
  const selectedContextWindow = resolveModelContextWindow(
    selectedTarget?.model.modelId || "",
    selectedTarget?.model.contextWindow,
  );
  const selectedCalibrationKey = selectedTarget
    ? `${selectedTarget.provider.id}|${selectedTarget.model.modelId}`
    : "";
  const calibrationFactor = tokenCalibration[selectedCalibrationKey] ?? 1;
  const {
    startNewTask,
    pickFolderForNewTask,
    pickFolderAndAssign,
    assignSidebarLocalWorkspace,
    startSshRemote,
    attachConnectedSshState,
    createSshRemoteTask,
    createTask,
    ensureTaskLoaded,
    taskHistoryIsPartial,
    ensureFullTaskHistory,
    switchTask,
    openTaskEditor,
    renameTask,
    renameWorkspace,
    createConversation,
    forkTask,
    exportActiveTask,
    removeTask,
    toggleTaskArchived,
  } = useTaskActions({
    setContextError,
    taskStorageReady,
    setSettings,
    setPendingFolder,
    setNewTaskName,
    setNewTaskOpen,
    setAssignFolderForTask,
    setTasks,
    flashAppToast,
    setSshRemoteDialogTaskId,
    tasksRef,
    setSshRemoteState,
    setWorkspaceView,
    selected,
    activeTask,
    reasoningEffort,
    hydratedTaskIdsRef,
    claimTaskView,
    setActiveTaskId,
    setMessages,
    setActivities,
    setInput,
    setAttachedFiles,
    setAttachedImages,
    setUsage,
    setUsageResolved,
    setDurationMs,
    setUsedContextCount,
    currentRequest,
    setRunningId,
    requestStartedRef,
    contextByMessageRef,
    designByMessageRef,
    autoFollowRef,
    setStatusOpen,
    newTaskName,
    pendingFolder,
    rememberTaskPaging,
    persistedTaskRefsRef,
    taskPagingRef,
    fullHistoryLoadsRef,
    activeTaskIdRef,
    displayedTaskIdRef,
    activeTaskId,
    taskSwitchSequenceRef,
    setTaskSwitchPending,
    readComposerValue,
    persistTaskDrafts,
    attachedFiles,
    attachedImages,
    attachmentDraftsRef,
    visibleTurnWindow,
    conversationWindowByTaskRef,
    conversationRef,
    scrollStateByTaskRef,
    pendingScrollRestoreRef,
    pagedTaskRef,
    conversationPageSize,
    setVisibleTurnWindow,
    setSelected,
    defaultReasoningEffort,
    setReasoningEffort,
    initialDrafts,
    conversationScrollControllerRef,
    setShowScrollToBottom,
    setCollapsedWorkspaces,
    creatingConversationPathsRef,
    setCreatingConversationPaths,
    flashContextToast,
    forgetTaskPaging,
    requestTasksRef,
    tasks,
  });

  const {
    summaryOpen,
    setSummaryOpen,
    summaryBusy,
    summarizingTasks,
    summarizeConversation,
    compactActiveConversation,
    rebuildActiveSummary,
    restoreFullContext,
    restoreSummarySnapshot,
  } = useConversationContext({
    activeTask,
    activeTaskIdRef,
    models,
    selectedContextWindow,
    calibrationFactor,
    ensureFullTaskHistory,
    setTasks,
    setContextError,
    flashContextToast,
  });
  const conversationTurns = useMemo(
    () => conversationTurnPreviews(messages),
    // Depend on the array itself, not its length: reordering queued messages
    // (prioritizeQueuedMessage) keeps the length but changes turn indices.
    [activeTaskId, messages, runningId],
  );
  const visibleMessages = useMemo(() => {
    // Keep the conversation window bounded while tokens are still arriving.
    // A full-history DOM search during streaming can monopolize the renderer.
    if (conversationSearchOpen && !runningId) return messages;
    const firstTurn = conversationTurns[visibleTurnWindow.start];
    if (!firstTurn) return messages;
    const endTurn = conversationTurns[visibleTurnWindow.end];
    return messages.slice(
      firstTurn.messageIndex,
      endTurn?.messageIndex ?? messages.length,
    );
  }, [
    conversationSearchOpen,
    conversationTurns,
    messages,
    runningId,
    visibleTurnWindow,
  ]);
  const hasOlderMessages =
    !conversationSearchOpen &&
    (visibleTurnWindow.start > 0 ||
      Boolean(taskPagingById[activeTaskId]?.messages.hasMoreBefore));
  const hasNewerMessages =
    !conversationSearchOpen && visibleTurnWindow.end < conversationTurns.length;
  const activitiesByRequest = useMemo(() => {
    const visibleRequests = new Set(
      visibleMessages
        .filter((message) => message.id.startsWith("assistant:"))
        .map((message) => message.id.slice("assistant:".length)),
    );
    return selectActivityGroups(activities, visibleRequests);
  }, [activities, visibleMessages]);
  const handleActivityChange = useCallback((next: AgentActivity) => {
    setActivities((all) => upsertActivity(all, next));
  }, []);
  useLayoutEffect(() => {
    if (!activeTaskId || pagedTaskRef.current === activeTaskId) return;
    pagedTaskRef.current = activeTaskId;
    setVisibleTurnWindow(
      latestConversationWindow(conversationTurns.length, conversationPageSize),
    );
    pendingTurnTargetRef.current = undefined;
    windowScrollAnchorRef.current = undefined;
    loadingOlderTurnsRef.current = false;
  }, [activeTaskId, conversationPageSize, conversationTurns.length]);
  useEffect(() => {
    const rail = turnRailRef.current;
    if (!rail || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const nextSize = Math.max(
        4,
        Math.min(12, Math.floor((rail.clientHeight - 24) / 28)),
      );
      setConversationPageSize((current) =>
        current === nextSize ? current : nextSize,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [activeTaskId, conversationTurns.length > 1]);
  useEffect(() => {
    if (autoFollowRef.current)
      setVisibleTurnWindow((current) => {
        const latest = latestConversationWindow(
          conversationTurns.length,
          conversationPageSize,
        );
        return current.start === latest.start && current.end === latest.end
          ? current
          : latest;
      });
  }, [conversationPageSize, conversationTurns.length]);
  useLayoutEffect(() => {
    const conversation = conversationRef.current;
    const anchor = windowScrollAnchorRef.current;
    if (conversation && anchor) {
      const element = turnRefs.current.get(anchor.turnId);
      if (element)
        conversation.scrollTop +=
          element.getBoundingClientRect().top - anchor.viewportOffset;
      windowScrollAnchorRef.current = undefined;
    }
    loadingOlderTurnsRef.current = false;
    const targetId = pendingTurnTargetRef.current;
    const target = targetId ? turnRefs.current.get(targetId) : undefined;
    if (conversation && targetId && target?.isConnected) {
      scrollContainerToElementTop(conversation, target, 28);
      setActiveConversationTurn(targetId);
      pendingTurnTargetRef.current = undefined;
      target.classList.add("turn-scroll-target");
      window.setTimeout(
        () => target.classList.remove("turn-scroll-target"),
        900,
      );
    }
    refreshTurnPositions();
    const pendingLatestScroll = pendingLatestScrollRef.current;
    if (conversation && pendingLatestScroll) {
      const latest = latestConversationWindow(
        conversationTurns.length,
        conversationPageSize,
      );
      if (
        visibleTurnWindow.start === latest.start &&
        visibleTurnWindow.end === latest.end
      ) {
        pendingLatestScrollRef.current = undefined;
        requestAnimationFrame(() => scrollToLatest(pendingLatestScroll));
      }
    }
  }, [conversationPageSize, conversationTurns.length, visibleTurnWindow]);

  const {
    updateTurnRailOverflow,
    setActiveConversationTurn,
    updateActiveTurn,
    refreshTurnPositions,
    handleConversationScroll,
    scrollToLatest,
    interruptBottomSettle,
    handleConversationWheel,
    scrollToTurn,
  } = useConversationViewport({
    conversationRef,
    autoFollowRef,
    setTurnRailOverflow,
    conversationTurns,
    activeConversationTurnRef,
    activeTaskId,
    bottomLayoutFrameRef,
    pendingScrollRestoreRef,
    conversationScrollControllerRef,
    displayedTaskIdRef,
    scrollStateByTaskRef,
    messages,
    scrollFrameRef,
    bottomSettleTimerRef,
    pendingLatestScrollRef,
    turnLayoutFrameRef,
    persistTaskDrafts,
    turnButtonRefs,
    turnRailRef,
    turnPositionsRef,
    turnRefs,
    windowScrollAnchorRef,
    taskPagingRef,
    loadingOlderTurnsRef,
    setHistoryLoadingTaskId,
    tasksRef,
    rememberTaskPaging,
    setTasks,
    setMessages,
    setActivities,
    conversationPageSize,
    setVisibleTurnWindow,
    activeTaskIdRef,
    setContextError,
    scrollTargetRef,
    programmaticScrollRef,
    visibleTurnWindow,
    conversationSearchOpen,
    hasNewerMessages,
    setShowScrollToBottom,
    setScrollingToBottom,
    bottomIndicatorUntilRef,
    bottomSettlePassesRef,
    bottomSettleDeadlineRef,
    endRef,
    pendingTurnTargetRef,
  });
  const activeLocalProjectPath = activeTask
    ? localWorkspacePath(activeTask)
    : undefined;

  async function refreshGitState(includeDiff = false) {
    if (!window.kcode?.workspace.gitState || !activeTask) return;
    if (!activeLocalProjectPath) {
      setGitState({
        available: false,
        files: 0,
        additions: 0,
        deletions: 0,
        summary: "",
        diff: "",
        error: activeTask.remoteWorkspace
          ? "未关联本地项目；SSH 远程 Git 请在执行记录中查看"
          : "未关联本地项目",
      });
      setGitRefreshing(false);
      return;
    }
    setGitRefreshing(true);
    try {
      setGitState(
        await window.kcode.workspace.gitState(
          activeLocalProjectPath,
          includeDiff,
        ),
      );
    } catch (error) {
      setGitState({
        available: false,
        files: 0,
        additions: 0,
        deletions: 0,
        summary: "",
        diff: "",
        error: errorMessage(error),
      });
    } finally {
      setGitRefreshing(false);
    }
  }
  useEffect(() => {
    void refreshGitState(false);
  }, [activeTaskId, activeLocalProjectPath]);
  useEffect(() => {
    window.kcode?.chat
      .checkpoints?.()
      .then((items) =>
        setCheckpoints(items.filter((item) => item.status !== "done")),
      );
  }, []);
  const latestFileChangeActivity = useMemo(() => {
    for (let index = activities.length - 1; index >= 0; index -= 1) {
      const activity = activities[index];
      if (
        activity.status === "success" &&
        [
          "write_file",
          "apply_patch",
          "move_path",
          "delete_path",
          "ssh_write_file",
        ].includes(activity.tool)
      )
        return activity.id;
    }
    return undefined;
  }, [activities]);
  useEffect(() => {
    if (
      !latestFileChangeActivity ||
      gitRefreshActivityRef.current === latestFileChangeActivity
    )
      return;
    gitRefreshActivityRef.current = latestFileChangeActivity;
    const timer = window.setTimeout(() => void refreshGitState(), 300);
    return () => window.clearTimeout(timer);
  }, [latestFileChangeActivity]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  const { remoteControlState, setRemoteControlState, remoteCommandHandlerRef } =
    useRemoteControl({
      tasks,
      taskStorageReady,
    });

  useEffect(() => {
    if (!activeTaskId && tasks[0]) {
      claimTaskView(tasks[0].id);
      setActiveTaskId(tasks[0].id);
    }
  }, [activeTaskId, tasks]);
  useEffect(() => {
    if (activeTaskId) localStorage.setItem("kcode.activeTaskId", activeTaskId);
  }, [activeTaskId]);
  useEffect(() => {
    const ownerTaskId = displayedTaskIdRef.current;
    if (!ownerTaskId || ownerTaskId !== activeTaskId || runningId) return;
    const timer = window.setTimeout(
      () =>
        setTasks((all) =>
          all.map((task) =>
            task.id === ownerTaskId
              ? { ...task, messages, activities, updatedAt: Date.now() }
              : task,
          ),
        ),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [messages, activities, activeTaskId, runningId]);
  function openSettings(section: SettingsSection) {
    setNewTaskOpen(false);
    setPendingFolder(null);
    setNewTaskName("");
    setSettingsSection(section);
    setSettings(true);
  }

  function updateDefaultReasoningEffort(value: ReasoningEffort) {
    setDefaultReasoningEffort(value);
    localStorage.setItem("kcode.defaultReasoningEffort", value);
    setReasoningEffort(normalizeEffort(value, efforts));
  }

  // Patch a single field on the active task (with updatedAt bump). Centralizes
  // the find-active-and-map pattern for the simple single-field updates.
  function patchActiveTask(patch: Partial<TaskRecord>) {
    if (!activeTaskId) return;
    setTasks((all) =>
      all.map((task) =>
        task.id === activeTaskId
          ? { ...task, ...patch, updatedAt: Date.now() }
          : task,
      ),
    );
  }

  function selectModel(value: string) {
    setSelected(value);
    const currentCollaboration = activeTask?.collaboration;
    if (currentCollaboration?.mode === "plan-confirm") {
      patchActiveTask({
        modelSelection: value,
        collaboration: currentCollaboration,
      });
      return;
    }
    const executorSelection = currentCollaboration?.executorModelSelection;
    const fallbackExecutor = models.find(
      ({ provider, model }) =>
        provider.hasApiKey && `${provider.id}|${model.id}` !== value,
    );
    const collaboration =
      currentCollaboration?.mode === "planner-executor" &&
      executorSelection === value
        ? fallbackExecutor
          ? {
              mode: "planner-executor" as const,
              executorModelSelection: `${fallbackExecutor.provider.id}|${fallbackExecutor.model.id}`,
              executorReasoningEffort: normalizeEffort(
                currentCollaboration.executorReasoningEffort ?? "auto",
                reasoningEffortsForModel(fallbackExecutor.model),
              ),
            }
          : undefined
        : currentCollaboration;
    patchActiveTask({ modelSelection: value, collaboration });
  }

  function selectCollaboration(value?: TaskCollaboration) {
    patchActiveTask({ collaboration: value });
  }

  function selectReasoningEffort(value: ReasoningEffort) {
    setReasoningEffort(value);
    patchActiveTask({ reasoningEffort: value });
  }

  function updateAutoFollow(value: boolean) {
    setAutoFollowEnabled(value);
    localStorage.setItem("kcode.autoFollow", String(value));
  }

  function updateStatusPanel(value: boolean) {
    setStatusOpen(value);
    localStorage.setItem("kcode.statusPanel", String(value));
  }

  async function pickContextDirectory() {
    if (!window.kcode?.context.pickDirectory) return null;
    const directory = await window.kcode.context.pickDirectory(
      contextDirectory || undefined,
    );
    if (directory) {
      setContextDirectory(directory);
      localStorage.setItem("kcode.contextDirectory", directory);
    }
    return directory;
  }

  function clearContextDirectory() {
    setContextDirectory("");
    localStorage.removeItem("kcode.contextDirectory");
  }

  function updateTheme(value: ThemePreference) {
    setTheme(value);
    localStorage.setItem("kcode.theme", value);
  }

  function updateAccent(value: AccentPreference) {
    setAccent(value);
    localStorage.setItem("kcode.accent", value);
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
    const widthAt = (clientX: number) =>
      Math.min(420, Math.max(210, startWidth + clientX - startX));
    document.body.classList.add("resizing-sidebar");
    let frame: number | undefined;
    let pendingWidth = startWidth;
    const applyPendingWidth = () => {
      frame = undefined;
      appShellRef.current?.style.setProperty(
        "--sidebar-width",
        `${pendingWidth}px`,
      );
    };
    const move = (moveEvent: PointerEvent) => {
      pendingWidth = widthAt(moveEvent.clientX);
      if (frame === undefined) frame = requestAnimationFrame(applyPendingWidth);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      document.body.classList.remove("resizing-sidebar");
    };
    const finish = (width: number) => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      appShellRef.current?.style.setProperty("--sidebar-width", `${width}px`);
      setSidebarWidth(width);
      localStorage.setItem("kcode.sidebarWidth", String(width));
      cleanup();
    };
    const stop = (upEvent: PointerEvent) => finish(widthAt(upEvent.clientX));
    const cancel = () => finish(pendingWidth);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  }

  function startComposerResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    const textarea = composerSurfaceRef.current?.querySelector("textarea");
    if (!textarea) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = textarea.getBoundingClientRect().height;
    const { min, max } = composerHeightBounds(textarea);
    const heightAt = (clientY: number) =>
      Math.min(max, Math.max(min, startHeight + startY - clientY));
    let frame: number | undefined;
    let pendingHeight = startHeight;
    document.body.classList.add("resizing-composer");
    const applyPendingHeight = () => {
      frame = undefined;
      textarea.style.height = `${pendingHeight}px`;
    };
    const move = (moveEvent: PointerEvent) => {
      pendingHeight = heightAt(moveEvent.clientY);
      if (frame === undefined)
        frame = requestAnimationFrame(applyPendingHeight);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      document.body.classList.remove("resizing-composer");
    };
    const finish = (height: number) => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      applyComposerHeight(height, true);
      cleanup();
    };
    const stop = (upEvent: PointerEvent) => finish(heightAt(upEvent.clientY));
    const cancel = () => finish(pendingHeight);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  }

  function handleComposerResizeKeyDown(
    event: React.KeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const textarea = composerSurfaceRef.current?.querySelector("textarea");
    if (!textarea) return;
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? 1 : -1;
    applyComposerHeight(
      textarea.getBoundingClientRect().height + direction * 16,
      true,
    );
  }

  function startBrowserResize(event: React.PointerEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = browserState.width ?? 520;
    // The panel sits on the right, so dragging its left edge leftward widens it.
    const widthAt = (clientX: number) =>
      Math.min(900, Math.max(360, startWidth + startX - clientX));
    document.body.classList.add("resizing-browser");
    let frame: number | undefined;
    let pendingWidth = startWidth;
    const applyPendingWidth = () => {
      frame = undefined;
      appShellRef.current?.style.setProperty(
        "--browser-width",
        `${pendingWidth}px`,
      );
      void window.kcode?.browser?.setWidth(pendingWidth);
    };
    const move = (moveEvent: PointerEvent) => {
      pendingWidth = widthAt(moveEvent.clientX);
      if (frame !== undefined) return;
      frame = requestAnimationFrame(applyPendingWidth);
    };
    const stop = (upEvent: PointerEvent) => {
      const width = widthAt(upEvent.clientX);
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      appShellRef.current?.style.setProperty("--browser-width", `${width}px`);
      void window.kcode?.browser?.setWidth(width);
      document.body.classList.remove("resizing-browser");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function reorderTask(sourceId: string | undefined, targetId: string) {
    if (!sourceId || sourceId === targetId) return;
    setTasks((current) => {
      const from = current.findIndex((task) => task.id === sourceId);
      const to = current.findIndex((task) => task.id === targetId);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  function reorderWorkspace(sourceKey: string | undefined, targetKey: string) {
    if (!sourceKey || sourceKey === targetKey) return;
    setTasks((current) => {
      const keys = [...new Set(current.map(sidebarWorkspaceKey))];
      const from = keys.indexOf(sourceKey),
        to = keys.indexOf(targetKey);
      if (from < 0 || to < 0) return current;
      keys.splice(to, 0, keys.splice(from, 1)[0]);
      return keys.flatMap((workspaceKey) =>
        current.filter((task) => sidebarWorkspaceKey(task) === workspaceKey),
      );
    });
  }

  function toggleWorkspace(workspaceKey: string) {
    setCollapsedWorkspaces((current) => {
      const next = new Set(current);
      next.has(workspaceKey)
        ? next.delete(workspaceKey)
        : next.add(workspaceKey);
      writeCollapsedWorkspaces(next);
      return next;
    });
  }

  function expandWorkspace(workspaceKey: string) {
    setCollapsedWorkspaces((current) => {
      if (!current.has(workspaceKey)) return current;
      const next = new Set(current);
      next.delete(workspaceKey);
      writeCollapsedWorkspaces(next);
      return next;
    });
  }

  async function removeWorkspace(workspaceKey: string) {
    const removed = tasks.filter(
      (task) => sidebarWorkspaceKey(task) === workspaceKey,
    );
    removed.forEach((task) => {
      taskRuntimeStore.clear(task.id);
      attachmentDraftsRef.current.delete(task.id);
      hydratedTaskIdsRef.current.delete(task.id);
      forgetTaskPaging(task.id);
      persistedTaskRefsRef.current.delete(task.id);
      scrollStateByTaskRef.current.delete(task.id);
      conversationWindowByTaskRef.current.delete(task.id);
    });
    if (window.kcode) {
      await Promise.all(
        removed
          .filter((task) => task.remoteWorkspace)
          .map((task) =>
            window.kcode.sshRemote.disconnect(task.id).catch(() => undefined),
          ),
      );
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
      await Promise.all(
        removed.map((task) => window.kcode.state.deleteTask(task.id)),
      );
    }
    // Live ref instead of the stale `tasks` closure — awaits above let
    // concurrent streaming updates land, and a snapshot would revert them.
    const nextTasks = tasksRef.current.filter(
      (task) => sidebarWorkspaceKey(task) !== workspaceKey,
    );
    setTasks(nextTasks);
    if (activeTask && sidebarWorkspaceKey(activeTask) === workspaceKey) {
      const next = nextTasks[0];
      if (next) {
        const loadedNext = await ensureTaskLoaded(next);
        const attachmentDraft = attachmentDraftsRef.current.get(loadedNext.id);
        claimTaskView(loadedNext.id);
        setActiveTaskId(loadedNext.id);
        setWorkspaceView(resolveWorkspaceView(loadedNext));
        setMessages(loadedNext.messages);
        setActivities(loadedNext.activities);
        setRunningId(loadedNext.runningId);
        currentRequest.current = loadedNext.runningId;
        requestStartedRef.current = loadedNext.startedAt;
        setAttachedFiles(attachmentDraft?.files ?? []);
        setAttachedImages(attachmentDraft?.images ?? []);
        setSelected(loadedNext.modelSelection || selected);
        setReasoningEffort(
          loadedNext.reasoningEffort || defaultReasoningEffort,
        );
      } else {
        claimTaskView("");
        setActiveTaskId("");
        setWorkspaceView("chat");
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
  const modelsRef = useRef(models);
  useEffect(() => {
    modelsRef.current = models;
  }, [models]);
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
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void startNewTask();
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "f" &&
        !settings &&
        !browserState.open
      ) {
        event.preventDefault();
        setConversationSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [settings, browserState.open]);

  useEffect(() => {
    setConversationSearchOpen(false);
    searchPreviousTurnWindowRef.current = undefined;
  }, [activeTaskId]);

  const revealAllConversationMessages = useCallback(() => {
    searchPreviousTurnWindowRef.current = visibleTurnWindow;
    const task = tasksRef.current.find(
      (item) => item.id === displayedTaskIdRef.current,
    );
    if (task && taskHistoryIsPartial(task.id))
      void ensureFullTaskHistory(task).catch((error) =>
        setContextError(`加载完整对话失败：${errorMessage(error)}`),
      );
  }, [visibleTurnWindow]);

  const closeConversationSearch = useCallback(() => {
    setConversationSearchOpen(false);
    const previous = searchPreviousTurnWindowRef.current;
    searchPreviousTurnWindowRef.current = undefined;
    if (previous) setVisibleTurnWindow(previous);
  }, []);

  // Decouple uneven upstream chunks from the visual cadence. Normal output is
  // released in stable slices; a large backlog accelerates gradually.
  const {
    flushRemoteStreamSync,
    flushPendingText,
    clearPendingReasoning,
    clearStreamingProgress,
  } = useAgentStream({
    remoteStreamTimersRef,
    requestTasksRef,
    remoteStreamSequencesRef,
    remoteRuntimeMetaRef,
    remoteControlState,
    tasksRef,
    pendingTextRef,
    composerInputBusyUntilRef,
    pendingTextSinceRef,
    textFlushTimerRef,
    pendingReasoningRef,
    reasoningFlushTimerRef,
    currentRequest,
    adoptedSshActivitiesRef,
    setContextError,
    activeTaskIdRef,
    expandWorkspace,
    setTasks,
    setSshRemoteState,
    displayedTaskIdRef,
    agentEventSequencesRef,
    setMessages,
    setActivities,
    modelsRef,
    setTokenCalibration,
    setUsage,
    setUsageResolved,
    requestStartedRef,
    setDurationMs,
    setRunningId,
  });
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
      conversationScrollControllerRef.current.markProgrammatic();
      conversation.scrollTop = top;
      conversationScrollControllerRef.current.reset({
        scrollTop: top,
        scrollHeight: conversation.scrollHeight,
        clientHeight: conversation.clientHeight,
      });
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
        programmaticScrollRef.current = true;
        conversationScrollControllerRef.current.markProgrammatic();
        conversation.scrollTop = conversation.scrollHeight;
        setShowScrollToBottom(false);
        setActiveConversationTurn(conversationTurns.at(-1)?.id);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            programmaticScrollRef.current = false;
          });
        });
      }
    });
    return () => {
      if (followFrameRef.current) cancelAnimationFrame(followFrameRef.current);
    };
  }, [
    autoFollowEnabled,
    messages.length,
    activities.length,
    conversationTurns.length,
  ]);

  const {
    pickContextFiles,
    pasteImages,
    handleComposerDragEnter,
    handleComposerDragOver,
    handleComposerDragLeave,
    handleComposerDrop,
  } = useComposerAttachments({
    setContextError,
    effectiveContextDirectory,
    attachedFiles,
    setAttachedFiles,
    patchActiveTask,
    activeTask,
    attachedImages,
    setAttachedImages,
    composerDragDepthRef,
    setComposerDragActive,
    runningId,
    summaryBusy,
  });

  function queueMessage(options?: { silent?: boolean }): string | undefined {
    const text = readComposerValue().trim();
    if (
      (!text && !attachedImages.length && !designElements.length) ||
      !activeTask ||
      summaryBusy
    )
      return undefined;
    const user: QueuedChatMessage = {
      id: uid(),
      role: "user",
      content:
        text ||
        (designElements.length
          ? "请根据选中的设计元素修改界面"
          : "请分析这些图片"),
      createdAt: Date.now(),
      images: attachedImages,
      contextAttachments: attachedFiles.length
        ? attachedFiles.map(({ name, size }) => ({ name, size }))
        : undefined,
      designAttachments: designElements.length
        ? designElements.map((item) => ({
            id: item.id,
            label: designElementChipLabel(item),
            tagName: item.tagName,
            cssSelector: item.cssSelector,
          }))
        : undefined,
      queued: true,
    };
    contextByMessageRef.current.set(user.id, attachedFiles);
    designByMessageRef.current.set(user.id, designElements);
    setMessages((all) => [...all, user]);
    setTasks((all) =>
      all.map((task) =>
        task.id === activeTask.id
          ? {
              ...task,
              messages: [...task.messages, user],
              updatedAt: Date.now(),
            }
          : task,
      ),
    );
    clearTaskDraft(activeTask.id);
    setInput("");
    setAttachedFiles([]);
    setAttachedImages([]);
    setDesignElements([]);
    attachmentDraftsRef.current.delete(activeTask.id);
    autoFollowRef.current = true;
    scrollAfterSendRef.current = true;
    setShowScrollToBottom(false);
    if (!options?.silent)
      flashContextToast("消息已排队，将在当前回复完成后发送");
    return user.id;
  }

  async function sendImmediately() {
    if (!activeTask || summaryBusy) return;
    const action = resolveComposerSubmitAction({
      running: Boolean(runningId),
      immediate: true,
    });
    if (action !== "send-immediate") return;
    if (!runningId) {
      void send();
      return;
    }
    // Interrupt path: enqueue as next, stop the live turn, then let the
    // existing auto-dequeue effect send one-at-a-time (avoids racing send()).
    const queuedId = queueMessage({ silent: true });
    if (!queuedId) return;
    prioritizeQueuedMessage(queuedId);
    flashContextToast("已中断当前回复，正在立即发送");
    await cancel();
  }

  function removeQueuedMessage(messageId: string) {
    if (!activeTask) return;
    if (editingQueuedMessageId === messageId) {
      setEditingQueuedMessageId(undefined);
      setQueuedMessageDraft("");
    }
    contextByMessageRef.current.delete(messageId);
    setMessages((all) => all.filter((message) => message.id !== messageId));
    setTasks((all) =>
      all.map((task) =>
        task.id === activeTask.id
          ? {
              ...task,
              messages: task.messages.filter(
                (message) => message.id !== messageId,
              ),
              updatedAt: Date.now(),
            }
          : task,
      ),
    );
    flashContextToast("补发消息已撤回");
  }

  function beginQueuedMessageEdit(message: QueuedChatMessage) {
    setEditingQueuedMessageId(message.id);
    setQueuedMessageDraft(message.content);
  }

  function cancelQueuedMessageEdit() {
    setEditingQueuedMessageId(undefined);
    setQueuedMessageDraft("");
  }

  function saveQueuedMessageEdit(message: QueuedChatMessage) {
    if (!activeTask) return;
    const content = queuedMessageDraft.trim();
    const hasAttachments = Boolean(
      message.images?.length || message.contextAttachments?.length,
    );
    if (!content && !hasAttachments) {
      setContextError("补发消息不能为空");
      return;
    }
    const nextContent = content || "请分析这些附件";
    const updateMessage = (item: ChatMessage) =>
      item.id === message.id ? { ...item, content: nextContent } : item;
    setMessages((all) => all.map(updateMessage));
    setTasks((all) =>
      all.map((task) =>
        task.id === activeTask.id
          ? {
              ...task,
              messages: task.messages.map(updateMessage),
              updatedAt: Date.now(),
            }
          : task,
      ),
    );
    setEditingQueuedMessageId(undefined);
    setQueuedMessageDraft("");
    setContextError("");
    flashContextToast("补发消息已更新");
  }

  function prioritizeQueuedMessage(messageId: string) {
    if (!activeTask) return;
    const moveFirst = (all: ChatMessage[]) =>
      prioritizeQueuedInMessages(all, messageId);
    setMessages(moveFirst);
    setTasks((all) =>
      all.map((task) =>
        task.id === activeTask.id
          ? {
              ...task,
              messages: moveFirst(task.messages),
              updatedAt: Date.now(),
            }
          : task,
      ),
    );
  }

  const { send, cancel } = useChatSubmission({
    session: {
      activeTask,
      activeTaskIdRef,
      displayedTaskIdRef,
      tasksRef,
      messages,
      activities,
      runningId,
      setTasks,
      setMessages,
      setActivities,
      setRunningId,
      currentRequest,
      requestTasksRef,
      requestStartedRef,
      ensureFullTaskHistory,
      taskHistoryIsPartial,
    },
    composer: {
      readComposerValue,
      attachedFiles,
      attachedImages,
      designElements,
      contextByMessageRef,
      designByMessageRef,
      consumeDraft(taskId) {
        clearTaskDraft(taskId);
        setAttachedFiles([]);
        setAttachedImages([]);
        setDesignElements([]);
        attachmentDraftsRef.current.delete(taskId);
      },
      setInput,
    },
    configuration: {
      models,
      selected,
      defaultReasoningEffort,
      permissionMode,
      permissionPolicy,
      tokenCalibration,
    },
    context: {
      summarizingTasks,
      summarizeConversation,
    },
    stream: {
      textFlushTimerRef,
      flushPendingText,
      flushRemoteStreamSync,
      clearPendingReasoning,
      clearStreamingProgress,
    },
    view: {
      setAssignFolderForTask,
      attachConnectedSshState,
      setSshRemoteState,
      setContextError,
      flashContextToast,
      autoFollowRef,
      scrollAfterSendRef,
      setShowScrollToBottom,
      setUsedContextCount,
      setUsage,
      setUsageResolved,
      setDurationMs,
    },
  });

  sendRef.current = send;
  useTaskScheduling({
    taskStorageReady,
    models,
    selected,
    defaultReasoningEffort,
    tasks,
    tasksRef,
    setTasks,
    hydratedTaskIdsRef,
    contextByMessageRef,
    send,
    editingQueuedMessageId,
    summarizingTasks,
  });

  useRemoteTaskCommands({
    remoteCommandHandlerRef,
    tasksRef,
    ensureTaskLoaded,
    flushRemoteStreamSync,
    contextByMessageRef,
    setTasks,
    displayedTaskIdRef,
    setMessages,
    currentRequest,
    cancel,
  });

  async function resumeCheckpoint(checkpoint: AgentCheckpoint) {
    if (!activeTask || runningId || summaryBusy) return;
    let task: TaskRecord;
    try {
      task = await ensureFullTaskHistory(activeTask);
    } catch (error) {
      setContextError(`加载完整对话失败：${errorMessage(error)}`);
      return;
    }
    const taskId = task.id;
    const checkpointRequestId = checkpoint.request.requestId ?? checkpoint.id;
    const checkpointAssistant = [...task.messages]
      .reverse()
      .find((message) => assistantRequestId(message) === checkpointRequestId);
    const checkpointActivities = [
      ...new Map(
        [
          ...task.activities,
          ...recoveryActivitiesFromCheckpoint(
            checkpoint.events,
            checkpointRequestId,
          ),
        ].map((activity) => [activity.id, activity] as const),
      ).values(),
    ];
    const checkpointCompletionResult =
      checkpointAssistant?.completionResult ??
      recoveryCompletionResultFromCheckpoint(
        checkpoint.events,
        checkpointRequestId,
      );
    const checkpointRecoveryPlan =
      checkpoint.request.recoveryPlan ??
      recoveryPlanFromActivities(checkpointActivities, checkpointRequestId) ??
      recoveryPlanFromCompletionResult(checkpointCompletionResult);
    const checkpointRecoveryEvidence =
      checkpoint.request.recoveryEvidence ??
      recoveryEvidenceFromActivities(
        checkpointActivities,
        checkpointRequestId,
        checkpointCompletionResult,
      );
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
      currentMessageId:
        checkpoint.request.currentMessageId ??
        [...task.messages]
          .reverse()
          .find((message) => message.role === "user" && message.images?.length)
          ?.id,
      connectionSessionId: task.remoteWorkspace ? taskId : undefined,
      workspacePath:
        task.workspacePath ||
        localWorkspacePath(task) ||
        checkpoint.request.workspacePath,
      messages: task.messages.map(({ role, content, images }) => ({
        role,
        content,
        images,
      })),
      permissionMode,
      permissionPolicy,
      contextWindow: selectedContextWindow,
      localWorkspacePath: localWorkspacePath(task),
      remoteWorkspace: task.remoteWorkspace,
      recoveryPlan: checkpointRecoveryPlan,
      recoveryEvidence: checkpointRecoveryEvidence,
    });
    requestTasksRef.current.set(id, taskId);
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

  const collaborationExecutorTarget = useMemo(
    () =>
      activeTask?.collaboration?.mode === "planner-executor"
        ? models.find(
            (item) =>
              `${item.provider.id}|${item.model.id}` ===
              activeTask.collaboration?.executorModelSelection,
          )
        : undefined,
    [
      activeTask?.collaboration?.mode,
      activeTask?.collaboration?.executorModelSelection,
      models,
    ],
  );
  const deferredMessages = useDeferredValue(messages);
  const compactedMessageCount = activeTask?.compactedMessageCount ?? 0;
  const retainedContextBoundaryId =
    deferredMessages[Math.max(0, compactedMessageCount - 1)]?.id;
  const retainedCheckpointContext = useMemo(
    () =>
      retainedCompactionContext(
        deferredMessages,
        compactedMessageCount,
        selectedContextWindow,
      ),
    [
      activeTaskId,
      compactedMessageCount,
      retainedContextBoundaryId,
      selectedContextWindow,
    ],
  );
  const localContextTokens = useMemo(
    () =>
      Math.ceil(
        (AGENT_STATIC_TOKENS +
          estimateTextTokens(activeTask?.contextSummary ?? "") +
          estimateTextTokens(retainedCheckpointContext) +
          estimateMessageTokens(
            deferredMessages.slice(compactedMessageCount),
          )) *
          calibrationFactor,
      ),
    [
      activeTask?.contextSummary,
      calibrationFactor,
      compactedMessageCount,
      deferredMessages,
      retainedCheckpointContext,
    ],
  );
  // The context gauge must reflect what the model actually reads each turn (the
  // last prompt token count), not usage.input, which accumulates every turn's
  // prompt and balloons far past the window in a multi-round agentic run.
  const contextTokens = contextUsageTokens(
    activeTask?.contextWindowState,
    usage.promptTokens ?? localContextTokens,
  );
  const contextTokenSource =
    usage.promptTokens !== undefined
      ? "reported"
      : taskPagingById[activeTaskId]?.messages.hasMoreBefore
        ? "partial"
        : "estimated";
  const selectedConnected = Boolean(selectedTarget?.provider.hasApiKey);
  const efforts = reasoningEffortsForModel(selectedTarget?.model);
  const supportsReasoning = efforts.some((effort) => effort !== "auto");
  const draftAttachmentTokens = useMemo(
    () =>
      attachedFiles.reduce(
        (total, file) => total + estimateTextTokens(file.content),
        0,
      ) +
      Math.ceil(
        attachedImages.reduce(
          (total, image) => total + Math.min(image.size, 750_000),
          0,
        ) / 2_250,
      ),
    [attachedFiles, attachedImages],
  );
  const nextRequestTokens = useMemo(() => {
    const estimated = estimateRequestContextTokens({
      messages: deferredMessages,
      compactedMessageCount,
      contextSummary: activeTask?.contextSummary,
      attachmentTokens: draftAttachmentTokens,
      outputReserve: outputTokenReserve(
        selectedContextWindow,
        supportsReasoning,
      ),
      calibrationFactor,
      retainedContext: retainedCheckpointContext,
    });
    return Math.max(estimated, usage.promptTokens ?? 0);
  }, [
    activeTask?.contextSummary,
    calibrationFactor,
    compactedMessageCount,
    deferredMessages,
    draftAttachmentTokens,
    retainedCheckpointContext,
    selectedContextWindow,
    supportsReasoning,
    usage.promptTokens,
  ]);
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
  const lastUserMessage = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1)
      if (messages[index].role === "user") return messages[index];
    return undefined;
  }, [messages]);
  const queuedMessages = useMemo(
    () =>
      messages.filter(
        (message): message is QueuedChatMessage =>
          message.role === "user" &&
          Boolean((message as QueuedChatMessage).queued),
      ),
    [messages],
  );
  const runStatus: TaskRunStatus = runningId
    ? "running"
    : (activeTask?.runStatus ?? "idle");
  const statusActivities = useMemo(
    () =>
      latestRequestActivities(activities, runningId ?? activeTask?.runningId),
    [activeTask?.runningId, activities, runningId],
  );
  const {
    editCheckpoints,
    keepFileChanges,
    undoFileChanges,
    restoreEditCheckpoint,
  } = useEditReview({
    activeTask,
    activeTaskId,
    runningId,
    activities,
    statusActivities,
    setActivities,
    setTasks,
    refreshGitState,
    flashAppToast,
  });

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

  const modifierKeyLabel = composerModifierKeyLabel();
  composerSubmitRef.current = () => {
    const action = resolveComposerSubmitAction({
      running: Boolean(runningId),
      immediate: false,
    });
    if (action === "queue") queueMessage();
    else void send();
  };
  composerSubmitImmediateRef.current = () => {
    void sendImmediately();
  };
  composerPasteRef.current = (event) => {
    void pasteImages(event);
  };

  // Stable-identity wrappers so memoized Sidebar/TopBar skip streaming-tick
  // re-renders. Identity never changes; the latest closure is always invoked.
  const onStartNewTask = useEventCallback(() => void startNewTask());
  const onStartSshRemote = useEventCallback(startSshRemote);
  const onReorderWorkspace = useEventCallback(
    (from: string | undefined, to: string) => reorderWorkspace(from, to),
  );
  const onReorderTask = useEventCallback(
    (from: string | undefined, to: string) => reorderTask(from, to),
  );
  const onToggleWorkspace = useEventCallback(toggleWorkspace);
  const onCreateConversation = useEventCallback(
    (workspacePath: string) => void createConversation(workspacePath),
  );
  const onSwitchTask = useEventCallback((taskId: string) => {
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (task) void switchTask(task);
  });
  const onToggleTaskArchived = useEventCallback((taskId: string) => {
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (task) void toggleTaskArchived(task);
  });
  const onOpenTaskEditor = useEventCallback((taskId: string) => {
    void openTaskEditor(taskId);
  });
  const onRenameSidebarTask = useEventCallback((taskId: string) => {
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (task) setRenameTarget({ kind: "task", id: task.id, name: task.name });
  });
  const onRenameSidebarWorkspace = useEventCallback((workspaceKey: string) => {
    const task = tasksRef.current.find(
      (item) => sidebarWorkspaceKey(item) === workspaceKey,
    );
    if (task)
      setRenameTarget({
        kind: "workspace",
        workspaceKey,
        name: taskWorkspaceName(task),
      });
  });
  const onForkSidebarTask = useEventCallback((taskId: string) => {
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (task) void forkTask(task);
  });
  const onAssignSidebarLocalWorkspace = useEventCallback(
    (target: SidebarLocalWorkspaceTarget) => {
      void assignSidebarLocalWorkspace(target);
    },
  );
  const onOpenSettings = useEventCallback(openSettings);
  const onCloseSettings = useCallback(() => setSettings(false), []);
  const onStartSidebarResize = useEventCallback(startSidebarResize);
  const onWorkspaceViewChange = useEventCallback((view: "chat" | "editor") => {
    setWorkspaceView(view);
    setConversationSearchOpen(false);
    if (view === "editor") setStatusOpen(false);
    // Remember the choice per task so switching back restores this view.
    // No updatedAt bump — a view toggle shouldn't reorder the sidebar.
    const taskId = activeTaskIdRef.current;
    if (taskId)
      setTasks((all) =>
        all.map((task) =>
          task.id === taskId ? { ...task, workspaceView: view } : task,
        ),
      );
  });
  const onUpdateStatusPanel = useEventCallback(updateStatusPanel);
  const onForkTask = useEventCallback(() => void forkTask());
  const onExportTask = useEventCallback(
    (format: "md" | "json") => void exportActiveTask(format),
  );
  // ConversationArea is the most expensive memoized child (it owns the whole
  // message list). These handlers were plain function declarations, so a new
  // identity was created on every App render and memo() never held.
  const onConversationScroll = useEventCallback(handleConversationScroll);
  const onConversationWheel = useEventCallback(handleConversationWheel);
  const onInterruptBottomSettle = useEventCallback(interruptBottomSettle);
  const onScrollToTurn = useEventCallback(scrollToTurn);
  const onWriteInput = useEventCallback(setInput);
  const onSetSidebarDeleteTarget = useEventCallback(
    (
      target:
        | {
            kind: "workspace";
            workspaceKey: string;
            name: string;
            count: number;
          }
        | { kind: "task"; taskId: string },
    ) => {
      if (target.kind === "workspace") return setDeleteTarget(target);
      const task = tasksRef.current.find((item) => item.id === target.taskId);
      if (task) setDeleteTarget({ kind: "task", task });
    },
  );

  return (
    <div className="window-root">
      {appToast && (
        <div
          key={appToast.id}
          className={`app-toast ${appToast.tone || "success"}`}
          role="status"
          aria-live="polite"
        >
          {appToast.tone === "error" ? (
            <CircleAlert size={14} />
          ) : (
            <CheckCircle2 size={14} />
          )}
          <span>{appToast.message}</span>
        </div>
      )}
      <TitleBar appUpdate={appUpdate} setUpdateOpen={setUpdateOpen} />
      <div
        ref={appShellRef}
        className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"} ${statusOpen ? "" : "status-collapsed"} ${browserState.open ? "browser-open" : ""} ${settings ? "settings-open" : ""}`}
        style={
          {
            "--sidebar-width": `${sidebarWidth}px`,
            "--browser-width": `${browserState.width ?? 520}px`,
          } as React.CSSProperties
        }
      >
        <TaskSidebar
          tasks={tasks}
          taskStorageReady={taskStorageReady}
          creatingConversationPaths={creatingConversationPaths}
          activeTaskId={activeTask?.id}
          taskQuery={taskQuery}
          setTaskQuery={setTaskQuery}
          showArchived={showArchived}
          setShowArchived={setShowArchived}
          collapsedWorkspaces={collapsedWorkspaces}
          startNewTask={onStartNewTask}
          startSshRemote={onStartSshRemote}
          reorderWorkspace={onReorderWorkspace}
          reorderTask={onReorderTask}
          toggleWorkspace={onToggleWorkspace}
          createConversation={onCreateConversation}
          switchTask={onSwitchTask}
          toggleTaskArchived={onToggleTaskArchived}
          openTaskEditor={onOpenTaskEditor}
          renameTask={onRenameSidebarTask}
          renameWorkspace={onRenameSidebarWorkspace}
          forkTask={onForkSidebarTask}
          assignLocalWorkspace={onAssignSidebarLocalWorkspace}
          setDeleteTarget={onSetSidebarDeleteTarget}
          openSettings={onOpenSettings}
          closeSidebar={closeSidebar}
          startSidebarResize={onStartSidebarResize}
        />
        <main
          className={`main ${workspaceView === "editor" ? "workspace-editor-mode" : ""} ${workspaceView === "editor" && activeTask?.remoteWorkspace ? "remote-editor-mode" : ""} ${taskSwitchPending ? "is-task-switch-pending" : ""}`}
        >
          <TopBar
            taskName={activeTask?.name || "新任务"}
            sidebarOpen={sidebarOpen}
            setSidebarOpen={setSidebarOpen}
            statusOpen={statusOpen}
            updateStatusPanel={onUpdateStatusPanel}
            gitState={gitState}
            remoteWorkspace={activeTask?.remoteWorkspace}
            remoteState={
              sshRemoteState?.taskId === activeTask?.id
                ? sshRemoteState
                : undefined
            }
            editorAvailable={Boolean(
              activeTask?.workspacePath || activeLocalProjectPath,
            )}
            workspaceView={workspaceView}
            setWorkspaceView={onWorkspaceViewChange}
            forkTask={onForkTask}
            exportTask={onExportTask}
          />
          {workspaceView === "editor" && activeTask?.remoteWorkspace && (
            <Suspense
              fallback={
                <div className="ssh-editor-loading">
                  <LoaderCircle className="spinning" size={18} />
                </div>
              }
            >
              <SshRemoteEditor
                key={`${activeTask.id}:${activeTask.remoteWorkspace.id}:${activeTask.remoteWorkspace.rootPath}`}
                taskId={activeTask.id}
                workspace={activeTask.remoteWorkspace}
                state={
                  sshRemoteState?.taskId === activeTask.id
                    ? sshRemoteState
                    : undefined
                }
                onStateChange={setSshRemoteState}
                onReconnect={() => setSshRemoteDialogTaskId(activeTask.id)}
              />
            </Suspense>
          )}
          {workspaceView === "editor" &&
            activeLocalProjectPath &&
            !activeTask?.remoteWorkspace && (
              <Suspense
                fallback={
                  <div className="ssh-editor-loading">
                    <LoaderCircle className="spinning" size={18} />
                  </div>
                }
              >
                <LocalWorkspaceEditor
                  key={`${activeTask.id}:${activeLocalProjectPath}`}
                  taskId={activeTask.id}
                  root={activeLocalProjectPath}
                />
              </Suspense>
            )}
          <ConversationSearch
            open={conversationSearchOpen}
            live={Boolean(runningId)}
            containerRef={conversationRef}
            onClose={closeConversationSearch}
            onRevealAll={revealAllConversationMessages}
          />
          <ConversationArea
            conversationRef={conversationRef}
            handleConversationScroll={onConversationScroll}
            handleConversationWheel={onConversationWheel}
            interruptBottomSettle={onInterruptBottomSettle}
            conversationTurns={conversationTurns}
            turnRailRef={turnRailRef}
            turnRailOverflow={turnRailOverflow}
            updateTurnRailOverflow={updateTurnRailOverflow}
            turnButtonRefs={turnButtonRefs}
            activeConversationTurnRef={activeConversationTurnRef}
            scrollToTurn={onScrollToTurn}
            messages={visibleMessages}
            hasOlderMessages={hasOlderMessages}
            olderMessagesLoading={historyLoadingTaskId === activeTaskId}
            hasNewerMessages={hasNewerMessages}
            models={models}
            writeInput={onWriteInput}
            openSettings={onOpenSettings}
            activitiesByRequest={activitiesByRequest}
            runningId={runningId}
            activeTaskWorkspacePath={
              activeLocalProjectPath || activeTask?.workspacePath || ""
            }
            contextByMessage={contextByMessageRef.current}
            retryContent={lastUserMessage?.content}
            retryMessage={retryMessage}
            handleActivityChange={handleActivityChange}
            registerTurn={registerTurn}
            endRef={endRef}
            switchKey={activeTaskId}
            switchDirection={taskSwitchDirectionRef.current}
          />
          {activeTask &&
            !activeTask.workspacePath &&
            !activeTask.localWorkspacePath &&
            !activeTask.remoteWorkspace && (
              <div className="no-workspace-banner">
                <FolderSearch size={14} />
                <span>此任务尚未关联工作区，Agent 无法访问本地文件</span>
                <button
                  className="no-workspace-assign"
                  onClick={() => void pickFolderAndAssign(activeTask)}
                >
                  选择文件夹
                </button>
              </div>
            )}
          <div className="composer-wrap">
            {(showScrollToBottom || scrollingToBottom) && (
              <button
                type="button"
                className="scroll-to-bottom"
                title={
                  scrollingToBottom ? "正在滚动到最新消息" : "滚动到最新消息"
                }
                aria-label={
                  scrollingToBottom ? "正在滚动到最新消息" : "滚动到最新消息"
                }
                aria-busy={scrollingToBottom}
                disabled={scrollingToBottom}
                onClick={() => scrollToLatest("auto", true)}
              >
                {scrollingToBottom ? (
                  <LoaderCircle className="spinning" size={17} />
                ) : (
                  <ArrowDown size={17} />
                )}
              </button>
            )}
            <ChatComposer
              {...{
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
              }}
            />
          </div>
        </main>
        {!browserState.open && !settings && workspaceView !== "editor" && (
          <StatusPanel
            runStatus={runStatus}
            activities={statusActivities}
            selectedTarget={selectedTarget}
            executorTarget={collaborationExecutorTarget}
            effortLabels={effortLabels}
            reasoningEffort={reasoningEffort}
            checkpoints={checkpoints}
            activeTask={activeTask}
            runningId={runningId}
            summaryBusy={summaryBusy}
            resumeCheckpoint={resumeCheckpoint}
            editCheckpoints={editCheckpoints}
            keepFileChanges={keepFileChanges}
            undoFileChanges={undoFileChanges}
            restoreEditCheckpoint={restoreEditCheckpoint}
            gitRefreshing={gitRefreshing}
            refreshGitState={refreshGitState}
            gitState={gitState}
            durationMs={durationMs}
            messages={messages}
            usage={usage}
            usageResolved={usageResolved}
            usedContextCount={usedContextCount}
            selectedContextWindow={selectedContextWindow}
            contextTokens={contextTokens}
            contextTokenSource={contextTokenSource}
            nextRequestTokens={nextRequestTokens}
            contextWindowEstimated={!selectedTarget?.model.contextWindow}
            calibrationFactor={calibrationFactor}
            compactActiveConversation={compactActiveConversation}
            summaryOpen={summaryOpen}
            setSummaryOpen={setSummaryOpen}
            restoreSummarySnapshot={restoreSummarySnapshot}
            rebuildActiveSummary={rebuildActiveSummary}
            restoreFullContext={restoreFullContext}
            overviewTasks={tasks}
            onFocusOverviewSession={onSwitchTask}
          />
        )}
        <BrowserPanel
          browserState={browserState}
          browserAddress={browserAddress}
          setBrowserAddress={setBrowserAddress}
          startBrowserResize={startBrowserResize}
        />
        {updateOpen && (
          <Suspense fallback={null}>
            <AppUpdateDialog
              state={appUpdate}
              onClose={() => setUpdateOpen(false)}
            />
          </Suspense>
        )}
        {settings && (
          <Suspense fallback={null}>
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
              contextDirectory={contextDirectory}
              onPickContextDirectory={pickContextDirectory}
              onClearContextDirectory={clearContextDirectory}
              theme={theme}
              onThemeChange={updateTheme}
              accent={accent}
              onAccentChange={updateAccent}
              permissionMode={permissionMode}
              onPermissionModeChange={updatePermissionMode}
              permissionPolicy={permissionPolicy}
              onPermissionPolicyChange={updatePermissionPolicy}
              remoteControlState={remoteControlState}
              onRemoteControlStateChange={setRemoteControlState}
              onClose={onCloseSettings}
            />
          </Suspense>
        )}
        {newTaskOpen && (
          <NewTaskDialog
            pendingFolder={pendingFolder}
            newTaskName={newTaskName}
            setNewTaskName={setNewTaskName}
            createTask={createTask}
            onPickFolder={() => void pickFolderForNewTask()}
            onClose={() => {
              setNewTaskOpen(false);
              setPendingFolder(null);
              setNewTaskName("");
            }}
          />
        )}
        {assignFolderForTask && (
          <AssignFolderDialog
            taskName={assignFolderForTask.name}
            onPickFolder={() => void pickFolderAndAssign(assignFolderForTask)}
            onClose={() => setAssignFolderForTask(null)}
          />
        )}
        {renameTarget && (
          <RenameDialog
            key={
              renameTarget.kind === "task"
                ? `task:${renameTarget.id}`
                : `workspace:${renameTarget.workspaceKey}`
            }
            kind={renameTarget.kind}
            initialName={renameTarget.name}
            rename={(name) =>
              renameTarget.kind === "task"
                ? renameTask(renameTarget.id, name)
                : renameWorkspace(renameTarget.workspaceKey, name)
            }
            onClose={() => setRenameTarget(undefined)}
          />
        )}
        {sshRemoteDialogTaskId && (
          <Suspense fallback={null}>
            <SshRemoteDialog
              key={sshRemoteDialogTaskId}
              taskId={sshRemoteDialogTaskId}
              initialProfile={
                tasks.find((task) => task.id === sshRemoteDialogTaskId)
                  ?.remoteWorkspace
              }
              onConnected={createSshRemoteTask}
              onClose={() => setSshRemoteDialogTaskId(undefined)}
            />
          </Suspense>
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
