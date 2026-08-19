import {
  forwardRef,
  lazy,
  memo,
  startTransition,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type WheelEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Blocks,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  CloudDownload,
  Clock3,
  Code2,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileCode2,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  GripHorizontal,
  GripVertical,
  LockOpen,
  ListOrdered,
  LoaderCircle,
  Monitor,
  Minus,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Sun,
  Terminal,
  Trash2,
  Upload,
  UserRound,
  Moon,
  FolderSearch,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import appLogo from "../build/icon.png";
import { inferReasoningConfig, resolveModelContextWindow } from "./types";
import type {
  RemoteCommandEnvelope,
  RemoteControlState,
  RemoteTaskStreamEvent,
} from "./remote-types";
import type { SshRemoteState } from "./ssh-remote-types";
import {
  isSshRemoteCredentialsRequired,
  restoreSshRemoteConnection,
} from "./ssh-remote-recovery";
import { sshWorkspaceRootFromActivity } from "./ssh-workspace-activity";
import {
  attachSshWorkspace,
  defaultRemoteWorkspaceName,
  taskWorkspaceName,
  workspaceNameFromPath,
} from "./task-workspace";
import {
  materializeRemoteAttachments,
  remoteAttachmentPrompt,
} from "./remote-attachments";
import { remoteTaskSnapshot } from "./remote-snapshot";
import {
  AGENT_STATIC_TOKENS,
  CONTEXT_AUTO_COMPACT_RATIO,
  CONTEXT_COMPACT_WARNING_RATIO,
  CONTEXT_FORCE_COMPACT_RATIO,
  acceptModelContextSummary,
  compactConversation,
  contextSummarySource,
  estimateMessageTokens,
  estimateTextTokens,
  retainedCompactionContext,
} from "./context";
import type { ContextLedger } from "./context";
import {
  assistantRequestId,
  buildInterruptedRunRecoveryContext,
} from "./interrupted-run-context";
import {
  markContextCompacted,
  contextUsageTokens,
  observeContextWindow,
} from "./context-window";
import {
  ACCENT_OPTIONS,
  EMPTY_ACTIVITIES,
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
import {
  projectSidebarWorkspaceGroups,
  sidebarWorkspaceKey,
  type SidebarProjection,
} from "./sidebar-projection";
import {
  appendConversationWindow,
  conversationTurnPreviews,
  isConversationAtBottom,
  latestConversationWindow,
  prependConversationWindow,
  windowContainingTurn,
  type ConversationWindow,
} from "./conversation-window";
import {
  ConversationScrollController,
  nestedWheelScroller,
} from "./conversation-scroll-controller";
import { taskRuntimeStore } from "./task-runtime-store";
import {
  normalizeStoredTask,
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
import {
  clipWorkingText,
  errorMessage,
  formatBytes,
  formatDuration,
} from "./lib/format";
import { latestRequestActivities } from "./status-summary";
import {
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_SOURCE_BYTES,
  MAX_IMAGE_FILES,
  MAX_IMAGE_FILE_BYTES,
  imageMediaType,
  isBinaryContextFile,
  isSupportedContextFile,
  mergeContextFiles,
} from "./attachments";
import {
  contextDialogDirectory,
  directoryFromFilePath,
} from "./context-directory";
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
import {
  ComposerTextarea,
  type ComposerTextareaHandle,
} from "./components/composer/ComposerTextarea";
import { PermissionPicker } from "./components/composer/PermissionPicker";
import { CollaborationPicker } from "./components/composer/CollaborationPicker";
const AppUpdateDialog = lazy(() =>
  import("./components/dialogs/AppUpdateDialog").then((m) => ({
    default: m.AppUpdateDialog,
  })),
);
import {
  AssignFolderDialog,
  DeleteDialog,
  NewTaskDialog,
} from "./components/dialogs/TaskDialogs";
import { BrowserPanel } from "./components/browser/BrowserPanel";
import { TitleBar } from "./components/chrome/TitleBar";
import { TopBar } from "./components/topbar/TopBar";
import {
  Sidebar,
  type SidebarLocalWorkspaceTarget,
} from "./components/sidebar/Sidebar";
import { StatusPanel } from "./components/status/StatusPanel";
import {
  COMPOSER_STREAM_PAUSE_MS,
  STREAM_PACING_INTERVAL_MS,
  STREAM_SINGLETON_MAX_HOLD_MS,
  StreamPacingBuffer,
} from "./stream-pacing";
import {
  appendStreamingText,
  consumeStreamingText,
  getStreamingText,
  replaceStreamingText,
  resetStreamingText,
  streamingProgressKey,
  streamingReasoningKey,
} from "./streaming-text-store";
import { acceptStreamSequence } from "./stream-sequence";
import {
  appendActivityOutput,
  replaceActivityOutput,
  resetActivityOutput,
} from "./activity-output-store";
import { selectActivityGroups, upsertActivity } from "./activity-index";
import {
  completePageMetadata,
  prependPageMetadata,
  prependUniqueItems,
  TASK_MESSAGE_PAGE_SIZE,
  windowAfterPrepend,
} from "./task-history-paging";
import { registerAppToastHandler, type AppToast } from "./lib/toast";
import { useEventCallback } from "./lib/use-event-callback";
import {
  finishTaskRequest,
  isTaskViewCurrent,
  nextQueuedMessageId,
  recoverOrphanedFailure,
  recoverInterruptedActivities,
  recoverTaskRunStatus,
  type TaskRunStatus,
} from "./task-status";
import { truncateAssistantMessageForTextReset } from "./conversation-rendering";
import { completionResultFromActivities } from "./completion-summary";
import type {
  AgentActivity,
  AgentCheckpoint,
  AgentToolName,
  AppUpdateState,
  BrowserRecordingFile,
  ChatMessage,
  ContextFile,
  ModelConfig,
  ProviderConfig,
  PermissionMode,
  PermissionPolicy,
  ReasoningEffort,
  WorkspaceFolder,
  GitWorkspaceState,
  ImageAttachment,
  ReasoningMode,
  SkillStoreItem,
  ScheduledTask,
  TaskWindow,
} from "./types";

type TaskPagingState = TaskWindow["paging"];

function estimateRequestContextTokens({
  messages,
  compactedMessageCount,
  contextSummary,
  attachmentTokens,
  outputReserve,
  calibrationFactor,
  retainedContext,
}: {
  messages: ChatMessage[];
  compactedMessageCount: number;
  contextSummary?: string;
  attachmentTokens: number;
  outputReserve: number;
  calibrationFactor: number;
  retainedContext?: string;
}) {
  return Math.ceil(
    (AGENT_STATIC_TOKENS +
      attachmentTokens +
      outputReserve +
      estimateMessageTokens(messages.slice(compactedMessageCount)) +
      estimateTextTokens(contextSummary ?? "") +
      estimateTextTokens(retainedContext ?? "")) *
      calibrationFactor,
  );
}

function outputTokenReserve(
  contextWindow: number | undefined,
  reasoning: boolean,
) {
  if (!contextWindow) return 8_000;
  return Math.max(8_000, Math.floor(contextWindow * (reasoning ? 0.18 : 0.12)));
}

function clearPromptTokenSnapshot(usage: TaskRecord["usage"]) {
  if (!usage) return usage;
  const { promptTokens: _promptTokens, ...rest } = usage;
  return rest;
}

// Restore the per-task chat/editor preference. Falls back to the old default
// (editor for remote workspaces, else chat) when nothing was saved, and never
// restores "editor" when the task has no workspace to show.
function resolveWorkspaceView(task: TaskRecord): "chat" | "editor" {
  const saved = task.workspaceView;
  const fallback = task.remoteWorkspace ? "editor" : "chat";
  const desired = saved ?? fallback;
  if (desired === "editor" && !task.workspacePath) return "chat";
  return desired;
}

function formatContextPercent(tokens: number, contextWindow?: number) {
  if (!contextWindow) return "未配置";
  return `${Math.min(100, Math.round((tokens / contextWindow) * 100))}%`;
}

function fileDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

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
  const taskRuntimeRevision = useSyncExternalStore(
    taskRuntimeStore.subscribe,
    taskRuntimeStore.getSnapshot,
    taskRuntimeStore.getSnapshot,
  );
  const [taskStorageReady, setTaskStorageReady] = useState(false);
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
  const [newTaskName, setNewTaskName] = useState("");
  const [taskQuery, setTaskQuery] = useState("");
  const deferredTaskQuery = useDeferredValue(taskQuery);
  const [showArchived, setShowArchived] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("kcode.sidebarWidth"));
    return Number.isFinite(saved) && saved >= 210 && saved <= 420 ? saved : 256;
  });
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
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [accent, setAccent] = useState<AccentPreference>(() => {
    const saved = localStorage.getItem("kcode.accent");
    return ACCENT_OPTIONS.some((o) => o.value === saved)
      ? (saved as AccentPreference)
      : "indigo";
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
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const scheduledTasksRef = useRef<ScheduledTask[]>([]);
  const scheduledRunsRef = useRef(new Set<string>());
  const [contextError, setContextError] = useState("");
  const [remoteControlState, setRemoteControlState] =
    useState<RemoteControlState>(() => ({
      configured: false,
      enabled: false,
      connected: false,
      connectionPhase: "disabled",
      serverUrl: "",
      deviceId: "",
      deviceName: "",
    }));
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
  }>({ open: false });
  const [browserAddress, setBrowserAddress] = useState("");
  // Latest reasoning/thinking snippet for the active turn. The renderer keeps
  // it beside the current activity until the next planning phase replaces it.
  useEffect(() => window.kcode?.browser?.onState(setBrowserState), []);
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
  const [gitDiffOpen, setGitDiffOpen] = useState(false);
  const [gitRefreshing, setGitRefreshing] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [scrollingToBottom, setScrollingToBottom] = useState(false);
  const [historyLoadingTaskId, setHistoryLoadingTaskId] = useState<string>();
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
  const pendingTextRef = useRef(new Map<string, StreamPacingBuffer>());
  const pendingTextSinceRef = useRef(new Map<string, number>());
  // Keep streaming responsive without asking React and layout to work at 60fps.
  const textFlushTimerRef = useRef<number | undefined>(undefined);
  const pendingReasoningRef = useRef(new Map<string, string>());
  const reasoningFlushTimerRef = useRef<number | undefined>(undefined);
  const activeTaskIdRef = useRef(activeTaskId);
  const displayedTaskIdRef = useRef(activeTaskId);
  const tasksRef = useRef(tasks);
  const remoteCommandHandlerRef = useRef<
    (envelope: RemoteCommandEnvelope) => void
  >(() => undefined);
  const remoteSyncTimerRef = useRef<number | undefined>(undefined);
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
  const hydratedTaskIdsRef = useRef(new Set(tasks.map((task) => task.id)));
  const taskPagingRef = useRef(new Map<string, TaskPagingState>());
  const fullHistoryLoadsRef = useRef(new Map<string, Promise<TaskRecord>>());
  const persistedTaskRefsRef = useRef(new Map<string, TaskRecord>());
  const persistedTaskOrderRef = useRef("");
  const taskSwitchSequenceRef = useRef(0);
  const sidebarProjectionRef = useRef<SidebarProjection | undefined>(undefined);
  const previewTimerRef = useRef<number | undefined>(undefined);
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
  const composerPasteRef = useRef<
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => void
  >(() => undefined);
  const composerInputBusyUntilRef = useRef(0);
  const handleComposerSubmit = useCallback(
    () => composerSubmitRef.current(),
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
    localStorage.setItem(
      "kcode.taskDrafts",
      JSON.stringify(initialDrafts.current),
    );
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
  const sendRef = useRef<((override?: string) => Promise<void>) | undefined>(
    undefined,
  );
  const queuedSendRef = useRef<
    ((taskId: string, messageId: string) => Promise<void>) | undefined
  >(undefined);
  const startingQueuedRef = useRef(new Set<string>());
  // Synchronous in-flight lock for manual send(): runningId is only written
  // to state after several awaits (history load, SSH reconnect), so the
  // runningId/runStatus guard cannot catch a second click inside that window.
  const sendingTasksRef = useRef(new Set<string>());
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
    up: false,
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
  useEffect(() => {
    if (!window.kcode?.state) {
      setTaskStorageReady(true);
      return;
    }
    let cancelled = false;
    void window.kcode.state
      .taskHeaders()
      .then(async (storedHeaders) => {
        if (cancelled) return;
        const runtimeStatuses = window.kcode.state.runtimeStatuses
          ? await window.kcode.state.runtimeStatuses().catch(() => [])
          : [];
        const runtimeByTask = new Map(
          runtimeStatuses.map((status) => [status.taskId, status] as const),
        );
        for (const runtime of runtimeStatuses) {
          if (runtime.turnStatus !== "in_progress") continue;
          requestTasksRef.current.set(runtime.requestId, runtime.taskId);
          agentEventSequencesRef.current.set(
            runtime.requestId,
            Math.max(
              agentEventSequencesRef.current.get(runtime.requestId) ?? 0,
              runtime.lastSequence,
            ),
          );
        }
        const restoreRuntimeStatus = (task: TaskRecord): TaskRecord => {
          const runtime = runtimeByTask.get(task.id);
          if (!runtime) return task;
          if (
            runtime.turnStatus === "in_progress" &&
            (runtime.status === "running" || runtime.status === "waiting")
          ) {
            taskRuntimeStore.ensureRunning(task.id, runtime.requestId, runtime.updatedAt);
            return {
              ...task,
              runningId: runtime.requestId,
              runStatus: "running",
              runtimeStatus: runtime.status,
              startedAt: task.startedAt ?? runtime.updatedAt,
            };
          }
          if (
            (task.runningId && task.runningId !== runtime.requestId) ||
            (!task.runningId && task.updatedAt > runtime.updatedAt)
          )
            return task;
          return {
            ...task,
            runningId: undefined,
            runtimeStatus: runtime.status,
            runStatus:
              runtime.status === "waiting"
                ? "blocked"
                : runtime.status === "failed"
                  ? "failed"
                  : runtime.status === "interrupted"
                    ? "cancelled"
                    : "completed",
          };
        };
        if (Array.isArray(storedHeaders) && storedHeaders.length) {
          const headers = (storedHeaders as TaskRecord[]).map((task) =>
            restoreRuntimeStatus(
              normalizeStoredTask({ ...task, messages: [], activities: [] }),
            ),
          );
          const selectedHeader =
            headers.find(
              (task) => task.id === localStorage.getItem("kcode.activeTaskId"),
            ) ?? headers[0];
          const hydrateTaskIds = new Set(
            runtimeStatuses
              .filter((status) => status.turnStatus === "in_progress")
              .map((status) => status.taskId),
          );
          if (selectedHeader) hydrateTaskIds.add(selectedHeader.id);
          const storedWindows = await Promise.all(
            [...hydrateTaskIds].map(async (taskId) => ({
              taskId,
              window: await window.kcode.state.loadTaskWindow(taskId),
            })),
          );
          if (cancelled) return;
          const hydratedTasks = new Map<string, TaskRecord>();
          for (const stored of storedWindows) {
            if (!stored.window) continue;
            rememberTaskPaging(stored.taskId, stored.window.paging);
            hydratedTasks.set(
              stored.taskId,
              restoreRuntimeStatus(
                normalizeStoredTask(stored.window.task as TaskRecord),
              ),
            );
          }
          const selectedTask = selectedHeader
            ? (hydratedTasks.get(selectedHeader.id) ?? selectedHeader)
            : undefined;
          const loaded = headers.map(
            (task) => hydratedTasks.get(task.id) ?? task,
          );
          hydratedTaskIdsRef.current = new Set(hydratedTasks.keys());
          persistedTaskRefsRef.current = new Map(hydratedTasks);
          persistedTaskOrderRef.current = JSON.stringify(
            loaded.map((task) => task.id),
          );
          claimTaskView(selectedTask?.id ?? "");
          setTasks(loaded);
          setActiveTaskId(selectedTask?.id ?? "");
          setMessages(selectedTask?.messages ?? []);
          setActivities(selectedTask?.activities ?? []);
          setInput(initialDrafts.current[selectedTask?.id ?? ""] ?? "");
          setRunningId(selectedTask?.runningId);
          currentRequest.current = selectedTask?.runningId;
          requestStartedRef.current = selectedTask?.startedAt;
        } else {
          const initial = tasksRef.current;
          hydratedTaskIdsRef.current = new Set(initial.map((task) => task.id));
          await Promise.all(
            initial.map((task) => window.kcode.state.saveTask(task.id, task)),
          );
          await window.kcode.state.saveTaskOrder(
            initial.map((task) => task.id),
          );
          persistedTaskRefsRef.current = new Map(
            initial.map((task) => [task.id, task]),
          );
          persistedTaskOrderRef.current = JSON.stringify(
            initial.map((task) => task.id),
          );
        }
        localStorage.removeItem("kcode.tasks");
        setTaskStorageReady(true);
      })
      .catch((error) => {
        if (!cancelled) {
          setContextError(`数据库加载失败：${errorMessage(error)}`);
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
    if (conversation && targetId && target) {
      conversation.scrollTop = Math.max(0, target.offsetTop - 20);
      setActiveConversationTurn(targetId);
      pendingTurnTargetRef.current = undefined;
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

  const updateTurnRailOverflow = useCallback(() => {
    const rail = turnRailRef.current;
    if (!rail) return;
    const next = {
      up: rail.scrollTop > 4,
      down: rail.scrollTop + rail.clientHeight < rail.scrollHeight - 4,
    };
    setTurnRailOverflow((current) =>
      current.up === next.up && current.down === next.down ? current : next,
    );
  }, []);
  useEffect(() => {
    requestAnimationFrame(updateTurnRailOverflow);
  }, [conversationTurns.length, updateTurnRailOverflow]);
  useEffect(() => {
    const ids = new Set(conversationTurns.map((turn) => turn.id));
    if (
      !activeConversationTurnRef.current ||
      !ids.has(activeConversationTurnRef.current)
    )
      setActiveConversationTurn(conversationTurns[0]?.id);
    refreshTurnPositions();
  }, [activeTaskId, conversationTurns.length]);
  useEffect(() => {
    const conversation = conversationRef.current;
    const messageList = conversation?.querySelector(".message-list");
    if (!messageList || typeof ResizeObserver === "undefined") return;
    const queueBottomFollow = () => {
      if (bottomLayoutFrameRef.current) return;
      bottomLayoutFrameRef.current = requestAnimationFrame(() => {
        bottomLayoutFrameRef.current = undefined;
        if (
          !autoFollowRef.current &&
          !pendingScrollRestoreRef.current?.state.atBottom
        )
          return;
        const current = conversationRef.current;
        if (
          !current ||
          current !== conversation ||
          (!autoFollowRef.current &&
            !pendingScrollRestoreRef.current?.state.atBottom)
        )
          return;
        // Align in the same paint cycle as the content resize. Delaying this
        // independently made the viewport catch up in visible 50 ms jumps.
        conversationScrollControllerRef.current.markProgrammatic();
        current.scrollTop = current.scrollHeight;
        const taskId = displayedTaskIdRef.current;
        if (taskId)
          scrollStateByTaskRef.current.set(taskId, {
            top: current.scrollHeight,
            atBottom: true,
          });
      });
    };
    const observer = new ResizeObserver(() => {
      const pending = pendingScrollRestoreRef.current;
      if (!autoFollowRef.current && !pending?.state.atBottom) return;
      queueBottomFollow();
    });
    observer.observe(messageList);
    return () => {
      observer.disconnect();
      if (bottomLayoutFrameRef.current) {
        cancelAnimationFrame(bottomLayoutFrameRef.current);
        bottomLayoutFrameRef.current = undefined;
      }
    };
  }, [activeTaskId, messages.length, conversationTurns.length]);
  useEffect(
    () => () => {
      if (scrollFrameRef.current) cancelAnimationFrame(scrollFrameRef.current);
      if (bottomLayoutFrameRef.current)
        cancelAnimationFrame(bottomLayoutFrameRef.current);
      if (bottomSettleTimerRef.current)
        window.clearTimeout(bottomSettleTimerRef.current);
      pendingLatestScrollRef.current = undefined;
      if (turnLayoutFrameRef.current)
        cancelAnimationFrame(turnLayoutFrameRef.current);
      if (textFlushTimerRef.current)
        window.clearTimeout(textFlushTimerRef.current);
      if (reasoningFlushTimerRef.current)
        window.clearTimeout(reasoningFlushTimerRef.current);
      persistTaskDrafts();
    },
    [persistTaskDrafts],
  );

  function setActiveConversationTurn(id?: string) {
    if (activeConversationTurnRef.current === id) return;
    if (activeConversationTurnRef.current)
      turnButtonRefs.current
        .get(activeConversationTurnRef.current)
        ?.classList.remove("active");
    activeConversationTurnRef.current = id;
    if (id) {
      const button = turnButtonRefs.current.get(id);
      button?.classList.add("active");
      if (!button) {
        const index = conversationTurns.findIndex((turn) => turn.id === id);
        const rail = turnRailRef.current;
        if (index >= 0 && rail)
          rail.scrollTop = Math.max(0, index * 28 - rail.clientHeight / 2);
      }
      const rail = button?.parentElement;
      if (button && rail) {
        const top = button.offsetTop;
        const bottom = top + button.offsetHeight;
        if (top < rail.scrollTop + 12) rail.scrollTop = Math.max(0, top - 12);
        else if (bottom > rail.scrollTop + rail.clientHeight - 12)
          rail.scrollTop = bottom - rail.clientHeight + 12;
      }
    }
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
      turnPositionsRef.current = [...turnRefs.current.entries()]
        .map(([id, element]) => ({ id, top: element.offsetTop }))
        .sort((a, b) => a.top - b.top);
      const conversation = conversationRef.current;
      if (conversation) updateActiveTurn(conversation);
    });
  }

  function preserveWindowAnchor(turnIndex: number) {
    const turn = conversationTurns[turnIndex];
    const element = turn ? turnRefs.current.get(turn.id) : undefined;
    if (!turn || !element) return;
    windowScrollAnchorRef.current = {
      turnId: turn.id,
      viewportOffset: element.getBoundingClientRect().top,
    };
  }

  async function loadOlderTaskHistory(
    taskId: string,
    currentWindow: ConversationWindow,
  ) {
    const state = window.kcode?.state;
    const initialPaging = taskPagingRef.current.get(taskId);
    const messageCursor = initialPaging?.messages.oldestCursor;
    if (!state || !initialPaging?.messages.hasMoreBefore || !messageCursor) {
      loadingOlderTurnsRef.current = false;
      windowScrollAnchorRef.current = undefined;
      setHistoryLoadingTaskId((current) =>
        current === taskId ? undefined : current,
      );
      return;
    }

    try {
      const messagePage = await state.taskMessagePage(taskId, {
        before: messageCursor,
        limit: TASK_MESSAGE_PAGE_SIZE,
      });
      const requestIds = messagePage.items
        .map((message) => message.id)
        .filter((messageId) => messageId.startsWith("assistant:"))
        .map((messageId) => messageId.slice("assistant:".length));
      const olderActivities = await state.taskActivitiesForRequests(
        taskId,
        requestIds,
      );

      const latestTask = tasksRef.current.find((task) => task.id === taskId);
      if (!latestTask) {
        loadingOlderTurnsRef.current = false;
        windowScrollAnchorRef.current = undefined;
        return;
      }
      const nextMessages = prependUniqueItems(
        messagePage.items,
        latestTask.messages,
      );
      const nextActivities = prependUniqueItems(
        olderActivities,
        latestTask.activities,
      );
      const latestPaging = taskPagingRef.current.get(taskId) ?? initialPaging;
      rememberTaskPaging(taskId, {
        messages: prependPageMetadata(latestPaging.messages, messagePage),
        activities: {
          oldestCursor: nextActivities[0]?.id,
          newestCursor: nextActivities.at(-1)?.id,
          hasMoreBefore: messagePage.hasMoreBefore,
          hasMoreAfter: false,
        },
      });
      const nextTask = {
        ...latestTask,
        messages: nextMessages,
        activities: nextActivities,
      };
      const nextTasks = tasksRef.current.map((task) =>
        task.id === taskId ? nextTask : task,
      );
      tasksRef.current = nextTasks;
      setTasks(nextTasks);

      const addedTurns = messagePage.items.filter(
        (message) =>
          message.role === "user" &&
          !latestTask.messages.some((current) => current.id === message.id),
      ).length;
      if (
        isTaskViewCurrent(
          activeTaskIdRef.current,
          displayedTaskIdRef.current,
          taskId,
        )
      ) {
        setMessages(nextMessages);
        setActivities(nextActivities);
        if (addedTurns > 0) {
          const totalTurns = nextMessages.reduce(
            (count, message) => count + (message.role === "user" ? 1 : 0),
            0,
          );
          setVisibleTurnWindow(
            windowAfterPrepend(
              currentWindow,
              addedTurns,
              totalTurns,
              conversationPageSize,
            ),
          );
          return;
        }
      }
      loadingOlderTurnsRef.current = false;
      windowScrollAnchorRef.current = undefined;
    } catch (error) {
      loadingOlderTurnsRef.current = false;
      windowScrollAnchorRef.current = undefined;
      setContextError(`加载历史记录失败：${errorMessage(error)}`);
    } finally {
      setHistoryLoadingTaskId((current) =>
        current === taskId ? undefined : current,
      );
    }
  }

  function handleConversationScroll(container: HTMLElement) {
    scrollTargetRef.current = container;
    // Programmatic bottom alignment also emits scroll events. Do not treat the
    // transient intermediate position as the user scrolling away from bottom.
    if (programmaticScrollRef.current) return;
    if (scrollFrameRef.current) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = undefined;
      const target = scrollTargetRef.current;
      if (!target) return;
      // Read scroll geometry once per animation frame. Reading it in every
      // native scroll event forces repeated synchronous layout on long output.
      const scrollTop = target.scrollTop;
      const clientHeight = target.clientHeight;
      const scrollHeight = target.scrollHeight;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      if (
        !conversationSearchOpen &&
        scrollTop <= 48 &&
        !loadingOlderTurnsRef.current
      ) {
        if (visibleTurnWindow.start > 0) {
          loadingOlderTurnsRef.current = true;
          preserveWindowAnchor(visibleTurnWindow.start);
          setVisibleTurnWindow((current) =>
            prependConversationWindow(current, conversationPageSize),
          );
          return;
        }
        if (taskPagingRef.current.get(activeTaskId)?.messages.hasMoreBefore) {
          loadingOlderTurnsRef.current = true;
          setHistoryLoadingTaskId(activeTaskId);
          preserveWindowAnchor(0);
          void loadOlderTaskHistory(activeTaskId, visibleTurnWindow);
          return;
        }
      }
      if (
        !conversationSearchOpen &&
        distanceFromBottom <= 48 &&
        hasNewerMessages &&
        !loadingOlderTurnsRef.current
      ) {
        loadingOlderTurnsRef.current = true;
        preserveWindowAnchor(
          Math.max(visibleTurnWindow.start, visibleTurnWindow.end - 1),
        );
        setVisibleTurnWindow((current) =>
          appendConversationWindow(
            current,
            conversationTurns.length,
            conversationPageSize,
          ),
        );
        return;
      }
      const atBottom = isConversationAtBottom(
        { scrollTop, clientHeight, scrollHeight },
        hasNewerMessages,
      );
      const scrollObservation = conversationScrollControllerRef.current.observe(
        { scrollTop, clientHeight, scrollHeight },
        hasNewerMessages,
      );
      const shouldFollow = atBottom && !scrollObservation.userScrolledAway;
      const taskId = displayedTaskIdRef.current;
      if (taskId)
        scrollStateByTaskRef.current.set(taskId, {
          top: scrollTop,
          atBottom: shouldFollow,
        });
      if (autoFollowRef.current !== shouldFollow) {
        autoFollowRef.current = shouldFollow;
        if (!shouldFollow) refreshTurnPositions();
      }
      setShowScrollToBottom(
        !shouldFollow || scrollObservation.showScrollButton,
      );
      updateActiveTurn(target);
    });
  }

  function scrollToLatest(
    behavior: ScrollBehavior = "auto",
    showProgress = false,
  ) {
    const conversation = conversationRef.current;
    if (!conversation) {
      setScrollingToBottom(false);
      return;
    }
    if (scrollFrameRef.current) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = undefined;
    }
    scrollTargetRef.current = null;
    if (showProgress) {
      bottomIndicatorUntilRef.current = performance.now() + 450;
      setScrollingToBottom(true);
    }
    conversationScrollControllerRef.current.markProgrammatic();
    const latest = latestConversationWindow(
      conversationTurns.length,
      conversationPageSize,
    );
    const alreadyShowingLatest =
      visibleTurnWindow.start === latest.start &&
      visibleTurnWindow.end === latest.end;
    if (!alreadyShowingLatest) {
      pendingLatestScrollRef.current = behavior;
      setVisibleTurnWindow(latest);
    }
    autoFollowRef.current = true;
    programmaticScrollRef.current = true;
    setShowScrollToBottom(false);
    if (bottomSettleTimerRef.current)
      window.clearTimeout(bottomSettleTimerRef.current);
    bottomSettlePassesRef.current = 0;
    bottomSettleDeadlineRef.current = performance.now() + 3_000;

    const finishBottomScroll = () => {
      bottomSettleTimerRef.current = undefined;
      bottomIndicatorUntilRef.current = 0;
      bottomSettlePassesRef.current = 0;
      programmaticScrollRef.current = false;
      setScrollingToBottom(false);
      setShowScrollToBottom(false);
    };

    const alignToLatest = () => {
      const current = conversationRef.current;
      if (!current || !autoFollowRef.current) {
        programmaticScrollRef.current = false;
        bottomSettleTimerRef.current = undefined;
        bottomIndicatorUntilRef.current = 0;
        bottomSettlePassesRef.current = 0;
        setScrollingToBottom(false);
        return;
      }
      current.scrollTop = current.scrollHeight;
      conversationScrollControllerRef.current.markProgrammatic();
      const taskId = displayedTaskIdRef.current;
      if (taskId)
        scrollStateByTaskRef.current.set(taskId, {
          top: current.scrollHeight,
          atBottom: true,
        });
      const latestTurnId = conversationTurns.at(-1)?.id;
      const latestTurn = latestTurnId
        ? turnRefs.current.get(latestTurnId)
        : undefined;
      const latestMounted = !latestTurnId || Boolean(latestTurn?.isConnected);
      const distanceFromBottom =
        current.scrollHeight - current.scrollTop - current.clientHeight;
      bottomSettlePassesRef.current =
        latestMounted && distanceFromBottom <= 1
          ? bottomSettlePassesRef.current + 1
          : 0;
      if (
        bottomSettlePassesRef.current >= 4 &&
        performance.now() >= bottomIndicatorUntilRef.current
      ) {
        finishBottomScroll();
      } else if (performance.now() < bottomSettleDeadlineRef.current) {
        bottomSettleTimerRef.current = window.setTimeout(alignToLatest, 50);
      } else {
        current.scrollTop = current.scrollHeight;
        finishBottomScroll();
      }
    };

    if (behavior === "smooth")
      endRef.current?.scrollIntoView({ block: "end", behavior });
    alignToLatest();
    if (bottomLayoutFrameRef.current)
      cancelAnimationFrame(bottomLayoutFrameRef.current);
    bottomLayoutFrameRef.current = requestAnimationFrame(() => {
      bottomLayoutFrameRef.current = undefined;
      const current = conversationRef.current;
      if (!current || !autoFollowRef.current) return;
      conversationScrollControllerRef.current.markProgrammatic();
      current.scrollTop = current.scrollHeight;
    });
    setActiveConversationTurn(conversationTurns.at(-1)?.id);
  }

  function interruptBottomSettle(userInitiated = false) {
    if (bottomSettleTimerRef.current) {
      window.clearTimeout(bottomSettleTimerRef.current);
      bottomSettleTimerRef.current = undefined;
    }
    bottomSettleDeadlineRef.current = 0;
    bottomIndicatorUntilRef.current = 0;
    bottomSettlePassesRef.current = 0;
    pendingLatestScrollRef.current = undefined;
    programmaticScrollRef.current = false;
    setScrollingToBottom(false);
    const conversation = conversationRef.current;
    if (conversation) {
      const atBottom =
        !userInitiated &&
        isConversationAtBottom(conversation, hasNewerMessages);
      autoFollowRef.current = atBottom;
      setShowScrollToBottom(!atBottom);
    }
    if (bottomLayoutFrameRef.current) {
      cancelAnimationFrame(bottomLayoutFrameRef.current);
      bottomLayoutFrameRef.current = undefined;
    }
  }

  function handleConversationWheel(event: WheelEvent<HTMLElement>) {
    const container = event.currentTarget;
    const nested = nestedWheelScroller(event.target, container, event.deltaY);
    const bottomGap =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (!nested && event.deltaY > 0 && bottomGap <= 1) return;
    conversationScrollControllerRef.current.markUserIntent();
    interruptBottomSettle(true);
  }

  function scrollToTurn(turnId: string, index: number) {
    if (index === conversationTurns.length - 1) return scrollToLatest("auto");
    const conversation = conversationRef.current;
    const element = turnRefs.current.get(turnId);
    if (!conversation) return;
    interruptBottomSettle();
    conversationScrollControllerRef.current.markUserIntent();
    autoFollowRef.current = false;
    setShowScrollToBottom(true);
    if (!element) {
      pendingTurnTargetRef.current = turnId;
      setVisibleTurnWindow(
        windowContainingTurn(
          index,
          conversationTurns.length,
          conversationPageSize,
        ),
      );
      return;
    }
    conversation.scrollTo({
      top: Math.max(0, element.offsetTop - 20),
      behavior: "auto",
    });
    setActiveConversationTurn(turnId);
  }
  const workspaceGroups = useMemo(() => {
    const sidebarTasks = taskRuntimeStore.overlayTasks(tasks);
    const projection = projectSidebarWorkspaceGroups(
      sidebarTasks,
      deferredTaskQuery,
      showArchived,
      sidebarProjectionRef.current,
    );
    sidebarProjectionRef.current = projection;
    return projection.workspaceGroups;
  }, [tasks, deferredTaskQuery, showArchived, taskRuntimeRevision]);

  async function refreshGitState(includeDiff = gitDiffOpen) {
    if (!window.kcode?.workspace.gitState || !activeTask?.workspacePath) return;
    if (activeTask.remoteWorkspace) {
      setGitState({
        available: false,
        files: 0,
        additions: 0,
        deletions: 0,
        summary: "",
        diff: "",
        error: "SSH Remote 工作区",
      });
      setGitRefreshing(false);
      return;
    }
    setGitRefreshing(true);
    try {
      setGitState(
        await window.kcode.workspace.gitState(
          activeTask.workspacePath,
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
    setGitDiffOpen(false);
  }, [activeTaskId]);
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

  useEffect(() => {
    const remote = window.kcode?.remote;
    if (!remote) return;
    let active = true;
    void remote.state().then((state) => {
      if (active) setRemoteControlState(state);
    });
    const unsubscribeState = remote.onState((state) => {
      if (active) setRemoteControlState(state);
    });
    const unsubscribeCommand = remote.onCommand((envelope) =>
      remoteCommandHandlerRef.current(envelope),
    );
    void remote.ready();
    return () => {
      active = false;
      unsubscribeState();
      unsubscribeCommand();
    };
  }, []);

  useEffect(
    () => () => {
      for (const timer of remoteStreamTimersRef.current.values())
        window.clearTimeout(timer);
      remoteStreamTimersRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const remote = window.kcode?.remote;
    if (
      !remote ||
      !taskStorageReady ||
      !remoteControlState.configured ||
      !remoteControlState.enabled
    )
      return;
    if (remoteSyncTimerRef.current)
      window.clearTimeout(remoteSyncTimerRef.current);
    remoteSyncTimerRef.current = window.setTimeout(() => {
      remoteSyncTimerRef.current = undefined;
      void remote.syncTasks(tasks.map(remoteTaskSnapshot)).catch((error) =>
        setRemoteControlState((state) => ({
          ...state,
          error: errorMessage(error),
        })),
      );
    }, 450);
    return () => {
      if (remoteSyncTimerRef.current)
        window.clearTimeout(remoteSyncTimerRef.current);
      remoteSyncTimerRef.current = undefined;
    };
  }, [
    tasks,
    taskStorageReady,
    remoteControlState.configured,
    remoteControlState.enabled,
  ]);

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
    if (!taskStorageReady) return;
    if (!window.kcode?.state) {
      localStorage.setItem("kcode.tasks", JSON.stringify(tasks));
      return;
    }
    const order = JSON.stringify(tasks.map((task) => task.id));
    const dirty = tasks.filter(
      (task) =>
        hydratedTaskIdsRef.current.has(task.id) &&
        persistedTaskRefsRef.current.get(task.id) !== task,
    );
    const orderChanged = persistedTaskOrderRef.current !== order;
    if (!dirty.length && !orderChanged) return;
    const timer = window.setTimeout(() => {
      void Promise.all([
        ...dirty.map((task) =>
          window.kcode.state.saveTask(
            task.id,
            task,
            taskPagingRef.current.has(task.id)
              ? { preserveUnloadedItems: true }
              : undefined,
          ),
        ),
        ...(orderChanged
          ? [window.kcode.state.saveTaskOrder(tasks.map((task) => task.id))]
          : []),
      ])
        .then(() => {
          dirty.forEach((task) =>
            persistedTaskRefsRef.current.set(task.id, task),
          );
          if (orderChanged) persistedTaskOrderRef.current = order;
        })
        .catch((error) =>
          setContextError(`数据库保存失败：${errorMessage(error)}`),
        );
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [tasks, taskStorageReady]);
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
    const executorSelection = currentCollaboration?.executorModelSelection;
    const fallbackExecutor = models.find(
      ({ provider, model }) =>
        provider.hasApiKey && `${provider.id}|${model.id}` !== value,
    );
    const collaboration =
      currentCollaboration && executorSelection === value
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
    const stop = (upEvent: PointerEvent) =>
      finish(heightAt(upEvent.clientY));
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
      localStorage.setItem(
        "kcode.collapsedWorkspaces",
        JSON.stringify([...next]),
      );
      return next;
    });
  }

  function expandWorkspace(workspaceKey: string) {
    setCollapsedWorkspaces((current) => {
      if (!current.has(workspaceKey)) return current;
      const next = new Set(current);
      next.delete(workspaceKey);
      localStorage.setItem(
        "kcode.collapsedWorkspaces",
        JSON.stringify([...next]),
      );
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
  const reloadScheduledTasks = useCallback(() => {
    if (!window.kcode?.state) return;
    void window.kcode.state
      .load("scheduledTasks")
      .then((value) => {
        const next = Array.isArray(value) ? (value as ScheduledTask[]) : [];
        scheduledTasksRef.current = next;
        setScheduledTasks(next);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    reloadScheduledTasks();
    window.addEventListener("kcode:schedules-updated", reloadScheduledTasks);
    return () =>
      window.removeEventListener(
        "kcode:schedules-updated",
        reloadScheduledTasks,
      );
  }, [reloadScheduledTasks]);
  const models = useMemo(
    () =>
      providers
        .filter((p) => p.enabled)
        .flatMap((p) => p.models.map((m) => ({ provider: p, model: m }))),
    [providers],
  );
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
  function flushRemoteStreamSync(requestId: string) {
    const scheduled = remoteStreamTimersRef.current.get(requestId);
    if (scheduled) window.clearTimeout(scheduled);
    remoteStreamTimersRef.current.delete(requestId);
    const taskId = requestTasksRef.current.get(requestId);
    const remote = window.kcode?.remote;
    if (!taskId || !remote) return;
    const sequence = (remoteStreamSequencesRef.current.get(requestId) ?? 0) + 1;
    remoteStreamSequencesRef.current.set(requestId, sequence);
    const event: RemoteTaskStreamEvent = {
      type: "task.event",
      event: "stream",
      taskId,
      requestId,
      sequence,
      content: getStreamingText(requestId).slice(-96_000),
      reasoning: getStreamingText(streamingReasoningKey(requestId)).slice(
        -8_000,
      ),
      progress: getStreamingText(streamingProgressKey(requestId)).slice(-1_000),
      runtimeEventId: remoteRuntimeMetaRef.current.get(requestId)?.eventId,
      runtimeEventKind: remoteRuntimeMetaRef.current.get(requestId)?.eventKind,
      runtimeItemStatus:
        remoteRuntimeMetaRef.current.get(requestId)?.itemStatus,
      runtimeSequence: remoteRuntimeMetaRef.current.get(requestId)?.sequence,
      runtimeProtocolVersion:
        remoteRuntimeMetaRef.current.get(requestId)?.protocolVersion,
      updatedAt: Date.now(),
    };
    void remote.syncTaskEvent(event).catch(() => undefined);
  }

  function scheduleRemoteStreamSync(requestId: string) {
    if (remoteStreamTimersRef.current.has(requestId)) return;
    remoteStreamTimersRef.current.set(
      requestId,
      window.setTimeout(() => flushRemoteStreamSync(requestId), 180),
    );
  }

  useEffect(() => {
    if (!remoteControlState.connected) return;
    const timer = window.setTimeout(() => {
      for (const [requestId, taskId] of requestTasksRef.current) {
        const task = tasksRef.current.find((item) => item.id === taskId);
        if (task?.runningId === requestId) flushRemoteStreamSync(requestId);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [remoteControlState.connected]);

  function flushPendingText(drainAll = false) {
    if (!pendingTextRef.current.size) return;
    if (!drainAll && performance.now() < composerInputBusyUntilRef.current) {
      scheduleTextFlush(
        Math.max(16, composerInputBusyUntilRef.current - performance.now()),
      );
      return;
    }
    const slices: [string, string][] = [];
    const now = Date.now();
    for (const [requestId, buffered] of pendingTextRef.current) {
      if (!buffered.length) continue;
      const bufferedSince = pendingTextSinceRef.current.get(requestId) ?? now;
      const slice = buffered.take(
        drainAll,
        now - bufferedSince >= STREAM_SINGLETON_MAX_HOLD_MS,
      );
      if (slice) slices.push([requestId, slice]);
      if (!buffered.length) {
        pendingTextRef.current.delete(requestId);
        pendingTextSinceRef.current.delete(requestId);
      }
    }
    if (!slices.length) {
      if (!drainAll && pendingTextRef.current.size) scheduleTextFlush();
      return;
    }
    for (const [requestId, delta] of slices) {
      appendStreamingText(requestId, delta);
      scheduleRemoteStreamSync(requestId);
    }
    if (!drainAll && pendingTextRef.current.size) scheduleTextFlush();
  }

  function scheduleTextFlush(delay = STREAM_PACING_INTERVAL_MS) {
    if (textFlushTimerRef.current) return;
    textFlushTimerRef.current = window.setTimeout(() => {
      textFlushTimerRef.current = undefined;
      flushPendingText();
    }, delay);
  }

  function clearPendingReasoning(requestId = currentRequest.current) {
    if (requestId) {
      pendingReasoningRef.current.delete(requestId);
      resetStreamingText(streamingReasoningKey(requestId));
      scheduleRemoteStreamSync(requestId);
    } else {
      for (const id of pendingReasoningRef.current.keys())
        resetStreamingText(streamingReasoningKey(id));
      pendingReasoningRef.current.clear();
    }
    if (reasoningFlushTimerRef.current) {
      window.clearTimeout(reasoningFlushTimerRef.current);
      reasoningFlushTimerRef.current = undefined;
    }
    if (pendingReasoningRef.current.size) scheduleReasoningFlush();
  }

  function clearStreamingProgress(requestId: string) {
    resetStreamingText(streamingProgressKey(requestId));
    scheduleRemoteStreamSync(requestId);
  }

  function adoptActivitySshWorkspace(taskId: string, activity: AgentActivity) {
    const rootPath = sshWorkspaceRootFromActivity(activity);
    if (!window.kcode?.sshRemote || !rootPath) return;
    const adoptionKey = `${taskId}:${activity.id}:${rootPath}`;
    if (adoptedSshActivitiesRef.current.has(adoptionKey)) return;
    adoptedSshActivitiesRef.current.add(adoptionKey);
    void window.kcode.sshRemote
      .adopt(taskId, rootPath)
      .then((state) => {
        if (!state.profile || !state.cachePath)
          throw new Error("SSH 连接未返回可编辑的远程工作区。");
        const currentTask = tasksRef.current.find((task) => task.id === taskId);
        if (currentTask)
          expandWorkspace(
            sidebarWorkspaceKey({
              ...currentTask,
              workspacePath: state.cachePath,
              remoteWorkspace: state.profile,
            }),
          );
        setTasks((all) =>
          all.map((task) =>
            task.id === taskId
              ? attachSshWorkspace(task, {
                  profile: state.profile!,
                  cachePath: state.cachePath!,
                })
              : task,
          ),
        );
        if (
          isTaskViewCurrent(
            activeTaskIdRef.current,
            displayedTaskIdRef.current,
            taskId,
          )
        ) {
          setSshRemoteState(state);
        }
      })
      .catch((error) => {
        adoptedSshActivitiesRef.current.delete(adoptionKey);
        if (activeTaskIdRef.current === taskId)
          setContextError(
            `SSH 已连接，但打开远程编辑器失败：${errorMessage(error)}`,
          );
      });
  }

  function scheduleReasoningFlush() {
    if (reasoningFlushTimerRef.current) return;
    reasoningFlushTimerRef.current = window.setTimeout(() => {
      reasoningFlushTimerRef.current = undefined;
      const pending = [...pendingReasoningRef.current.entries()];
      pendingReasoningRef.current.clear();
      for (const [requestId, delta] of pending) {
        appendStreamingText(streamingReasoningKey(requestId), delta);
        scheduleRemoteStreamSync(requestId);
      }
    }, 100);
  }

  useEffect(
    () =>
      window.kcode?.chat.onEvent((id, event) => {
        if (
          !acceptStreamSequence(
            agentEventSequencesRef.current,
            id,
            event.sequence,
          )
        )
          return;
        const taskId = requestTasksRef.current.get(id) ?? event.taskId;
        if (!taskId) return;
        if (!requestTasksRef.current.has(id))
          requestTasksRef.current.set(id, taskId);
        if (event.eventId)
          remoteRuntimeMetaRef.current.set(id, {
            eventId: event.eventId,
            eventKind: event.eventKind,
            itemStatus: event.itemStatus,
            sequence: event.sequence,
            protocolVersion: event.protocolVersion,
          });
        const isActive = isTaskViewCurrent(
          activeTaskIdRef.current,
          displayedTaskIdRef.current,
          taskId,
        );
        if (
          event.type !== "done" &&
          event.type !== "error" &&
          event.type !== "activity_output"
        ) {
          const startedAt =
            tasksRef.current.find((task) => task.id === taskId)?.startedAt ??
            Date.now();
          taskRuntimeStore.applyEvent(taskId, id, event);
        }
        if (event.type === "activity_output") {
          if (event.mode === "append")
            appendActivityOutput(event.activityId, event.value);
          else replaceActivityOutput(event.activityId, event.value);
          return;
        }
        if (
          event.type !== "done" &&
          event.type !== "error" &&
          event.type !== "text" &&
          event.type !== "final_response" &&
          event.type !== "reasoning" &&
          event.type !== "reasoning_reset" &&
          event.type !== "progress"
        )
          setTasks((all) => {
            const index = all.findIndex((task) => task.id === taskId);
            const task = all[index];
            if (
              !task ||
              (task.runningId === id && task.runStatus === "running")
            )
              return all;
            const next = [...all];
            next[index] = {
              ...task,
              runningId: id,
              runStatus: "running",
              runtimeStatus: taskRuntimeStore.get(taskId)?.state.threadStatus,
            };
            return next;
          });
        if (event.type === "final_response") {
          clearStreamingProgress(id);
          clearPendingReasoning(id);
          if (textFlushTimerRef.current) {
            window.clearTimeout(textFlushTimerRef.current);
            textFlushTimerRef.current = undefined;
          }
          flushPendingText(true);
          const settledText = consumeStreamingText(id, { emitReset: false });
          const markFinalResponse = (all: ChatMessage[]) =>
            all.map((message) => {
              if (message.id !== `assistant:${id}`) return message;
              const content = message.content + settledText;
              return {
                ...message,
                content,
                finalResponseOffset: Math.min(
                  content.length,
                  Math.max(0, Math.floor(event.textOffset)),
                ),
                finalResponseStartedAt: event.startedAt,
                finalResponseProcess: event.processKind,
              };
            });
          setTasks((all) =>
            all.map((task) =>
              task.id === taskId
                ? {
                    ...task,
                    messages: markFinalResponse(task.messages),
                    updatedAt: Math.max(task.updatedAt, event.startedAt),
                  }
                : task,
            ),
          );
          if (isActive) setMessages(markFinalResponse);
          flushRemoteStreamSync(id);
          return;
        }
        if (event.type === "activity") {
          flushPendingText(true);
          const settledText = consumeStreamingText(id, { emitReset: false });
          const settleMessages = (all: ChatMessage[]) =>
            settledText
              ? all.map((message) =>
                  message.id === `assistant:${id}`
                    ? { ...message, content: message.content + settledText }
                    : message,
                )
              : all;
          resetActivityOutput(event.activity.id);
          const updateActivities = (all: AgentActivity[]) =>
            upsertActivity(all, event.activity);
          adoptActivitySshWorkspace(taskId, event.activity);
          // Commit the narration on the urgent lane before the activity card.
          // Keeping both updates in the transition can defer the text until a
          // fast sequence of tool lifecycle events has finished.
          if (settledText) {
            setTasks((all) =>
              all.map((task) =>
                task.id === taskId
                  ? { ...task, messages: settleMessages(task.messages) }
                  : task,
              ),
            );
            if (isActive) setMessages(settleMessages);
          }
          startTransition(() => {
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
            if (isActive) {
              setActivities(updateActivities);
            }
          });
          return;
        }
        if (event.type === "reasoning_reset") {
          clearPendingReasoning(id);
          scheduleRemoteStreamSync(id);
          return;
        }
        if (event.type === "reasoning") {
          clearStreamingProgress(id);
          pendingReasoningRef.current.set(
            id,
            (pendingReasoningRef.current.get(id) ?? "") + event.delta,
          );
          scheduleReasoningFlush();
          return;
        }
        if (event.type === "progress") {
          // A new planning/recovery phase replaces the previous round's live
          // reasoning. It remains visible while the selected tool is running.
          clearPendingReasoning(id);
          replaceStreamingText(streamingProgressKey(id), event.message);
          scheduleRemoteStreamSync(id);
          return;
        }
        if (event.type === "context_compaction") {
          replaceStreamingText(
            streamingProgressKey(id),
            event.phase === "started"
              ? "上下文接近预算，正在压缩较早运行记录…"
              : event.changed
                ? `上下文已压缩：${event.beforeItems} → ${event.afterItems ?? event.beforeItems} 条，继续执行…`
                : "上下文仍在预算内，继续执行…",
          );
          scheduleRemoteStreamSync(id);
          return;
        }
        if (event.type === "text_reset") {
          // Upstream broke mid-answer and the agent is retrying: discard the
          // current turn while retaining text from earlier timeline rounds.
          // Drain first because an auto-continued prefix may still be paced in
          // memory rather than committed to message.content.
          flushPendingText(true);
          pendingTextRef.current.delete(id);
          pendingTextSinceRef.current.delete(id);
          const streamedText = consumeStreamingText(id, { emitReset: false });
          const clearCommitted = (all: ChatMessage[]) =>
            all.map((message) =>
              message.id === `assistant:${id}`
                ? truncateAssistantMessageForTextReset(
                    message,
                    event.textOffset,
                    streamedText,
                    event.replacement,
                  )
                : message,
            );
          setTasks((all) =>
            all.map((task) =>
              task.id === taskId
                ? { ...task, messages: clearCommitted(task.messages) }
                : task,
            ),
          );
          if (isActive) setMessages(clearCommitted);
          scheduleRemoteStreamSync(id);
          return;
        }
        if (event.type === "text") {
          clearStreamingProgress(id);
          clearPendingReasoning(id);
          if (!isActive) {
            // A task switched away mid-stream may still have paced text sitting
            // in its buffer waiting on the flush timer. Writing this delta
            // straight to the store would land ahead of that buffered text and
            // reorder the answer. Drain the buffer in order first.
            const buffered = pendingTextRef.current.get(id);
            if (buffered) {
              buffered.append(event.delta);
              appendStreamingText(id, buffered.take(true));
              pendingTextRef.current.delete(id);
              pendingTextSinceRef.current.delete(id);
            } else {
              appendStreamingText(id, event.delta);
            }
            scheduleRemoteStreamSync(id);
            return;
          }
          let pending = pendingTextRef.current.get(id);
          if (!pending) {
            pending = new StreamPacingBuffer();
            pendingTextRef.current.set(id, pending);
            pendingTextSinceRef.current.set(id, Date.now());
          }
          pending.append(event.delta);
          scheduleTextFlush();
        }
        if (event.type === "usage") {
          const nextUsage = {
            input: event.input,
            output: event.output,
            cached: event.cached ?? 0,
            promptTokens: event.promptTokens ?? event.input,
          };
          const task = tasksRef.current.find((item) => item.id === taskId);
          const taskModel = modelsRef.current.find(
            (item) =>
              `${item.provider.id}|${item.model.id}` === task?.modelSelection,
          )?.model;
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
                    contextWindowState: observeContextWindow(
                      item.contextWindowState,
                      {
                        taskId,
                        limit: resolveModelContextWindow(
                          taskModel?.modelId ?? "",
                          taskModel?.contextWindow,
                        ),
                        observedTokens: observedInput,
                        estimatedTokens: observedInput,
                        source: "reported",
                      },
                    ),
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
          const interrupted =
            event.code === "cancelled" ||
            event.eventKind === "turn_interrupted";
          taskRuntimeStore.finish(taskId, id);
          clearStreamingProgress(id);
          clearPendingReasoning(id);
          if (textFlushTimerRef.current) {
            window.clearTimeout(textFlushTimerRef.current);
            textFlushTimerRef.current = undefined;
          }
          flushPendingText(true);
          flushRemoteStreamSync(id);
          const finalText = consumeStreamingText(id, { emitReset: false });
          const completedAt = Date.now();
          const commitFinalText = (all: ChatMessage[]) =>
            all.map((message) =>
              message.id === `assistant:${id}`
                ? {
                    ...message,
                    content: message.content + finalText,
                    error: interrupted ? undefined : event.message,
                    completedAt,
                  }
                : message,
            );
          const updateMessages = (all: ChatMessage[]) => commitFinalText(all);
          setTasks((all) =>
            all.map((task) =>
              task.id === taskId
                ? {
                    ...task,
                    messages: updateMessages(task.messages),
                    ...finishTaskRequest(
                      task.runningId,
                      id,
                      task.runStatus === "cancelled" || interrupted
                        ? "cancelled"
                        : "failed",
                    ),
                    runtimeStatus:
                      task.runningId && task.runningId !== id
                        ? "running"
                        : task.runStatus === "cancelled" || interrupted
                          ? "interrupted"
                          : "failed",
                    updatedAt: completedAt,
                  }
                : task,
            ),
          );
          if (isActive) setMessages(updateMessages);
          if (isActive && requestStartedRef.current) {
            const value = completedAt - requestStartedRef.current;
            setDurationMs(value);
            setTasks((all) =>
              all.map((task) =>
                task.id === taskId ? { ...task, durationMs: value } : task,
              ),
            );
          }
          if (isActive && currentRequest.current === id) {
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
          remoteRuntimeMetaRef.current.delete(id);
        }
        if (event.type === "done") {
          taskRuntimeStore.finish(taskId, id);
          const finishedStatus =
            event.outcome === "blocked"
              ? "blocked"
              : event.outcome === "paused"
                ? "paused"
                : "completed";
          clearStreamingProgress(id);
          clearPendingReasoning(id);
          if (textFlushTimerRef.current) {
            window.clearTimeout(textFlushTimerRef.current);
            textFlushTimerRef.current = undefined;
          }
          flushPendingText(true);
          flushRemoteStreamSync(id);
          const finalText = consumeStreamingText(id, { emitReset: false });
          const completedAt = Date.now();
          const commitFinalText = (all: ChatMessage[]) =>
            all.map((message) =>
              message.id === `assistant:${id}`
                ? {
                    ...message,
                    content: message.content + finalText,
                    completionResult: event.result,
                    completedAt,
                  }
                : message,
            );
          if (isActive) setMessages(commitFinalText);
          setTasks((all) =>
            all.map((task) => {
              if (task.id !== taskId) return task;
              const committedMessages = commitFinalText(task.messages);
              const assistantIndex = committedMessages.findIndex(
                (message) => message.id === `assistant:${id}`,
              );
              const assistant = committedMessages[assistantIndex];
              const user = [...committedMessages.slice(0, assistantIndex)]
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
                messages: committedMessages,
                ...finishTaskRequest(task.runningId, id, finishedStatus),
                runtimeStatus:
                  task.runningId && task.runningId !== id
                    ? "running"
                    : event.outcome === "blocked"
                      ? "waiting"
                      : "completed",
                usageResolved: true,
                imageSemantics,
                updatedAt: completedAt,
              };
            }),
          );
          if (isActive && requestStartedRef.current) {
            const value = completedAt - requestStartedRef.current;
            setDurationMs(value);
            setTasks((all) =>
              all.map((task) =>
                task.id === taskId ? { ...task, durationMs: value } : task,
              ),
            );
          }
          if (isActive && currentRequest.current === id) {
            currentRequest.current = undefined;
            setRunningId(undefined);
            setUsageResolved(true);
          }
          requestTasksRef.current.delete(id);
          remoteRuntimeMetaRef.current.delete(id);
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

  async function clearCurrentConversation() {
    const requestId = currentRequest.current;
    if (requestId && window.kcode) await window.kcode.chat.cancel(requestId);
    if (requestId && activeTask?.id)
      taskRuntimeStore.finish(activeTask.id, requestId);
    if (previewTimerRef.current) window.clearInterval(previewTimerRef.current);
    currentRequest.current = undefined;
    setRunningId(undefined);
    setMessages([]);
    setActivities([]);
    setInput("");
    setAttachedFiles([]);
    setAttachedImages([]);
    if (activeTask?.id) attachmentDraftsRef.current.delete(activeTask.id);
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

  function startNewTask() {
    setContextError("");
    if (!taskStorageReady) return;
    if (window.kcode && !window.kcode.workspace) {
      setContextError("桌面主进程版本较旧，请重启应用后再试");
      return;
    }
    setPendingFolder(null);
    setNewTaskName("");
    setNewTaskOpen(true);
  }

  async function pickFolderForNewTask() {
    try {
      const folder = window.kcode
        ? await window.kcode.workspace.pickFolder()
        : { name: "kcode", path: "D:\\project\\kcode" };
      if (folder) setPendingFolder(folder);
    } catch (error) {
      setContextError(errorMessage(error));
    }
  }

  async function pickFolderAndAssign(task: TaskRecord) {
    setAssignFolderForTask(null);
    try {
      const folder = window.kcode
        ? await window.kcode.workspace.pickFolder()
        : { name: "kcode", path: "D:\\project\\kcode" };
      if (!folder) return;
      setTasks((all) =>
        all.map((t) =>
          t.id === task.id
            ? {
                ...t,
                workspaceName: folder.name,
                localWorkspacePath: folder.path,
                workspacePath: t.remoteWorkspace
                  ? t.workspacePath
                  : folder.path,
                updatedAt: Date.now(),
              }
            : t,
        ),
      );
    } catch (error) {
      setContextError(errorMessage(error));
    }
  }

  async function assignSidebarLocalWorkspace(
    target: SidebarLocalWorkspaceTarget,
  ) {
    try {
      const folder = await window.kcode?.workspace.pickFolder();
      if (!folder) return;
      const matches = (task: TaskRecord) =>
        target.kind === "workspace"
          ? sidebarWorkspaceKey(task) === target.workspaceKey
          : task.id === target.taskId;
      setTasks((all) =>
        all.map((task) =>
          matches(task)
            ? {
                ...task,
                workspaceName: task.workspaceName || folder.name,
                localWorkspacePath: folder.path,
                workspacePath: task.remoteWorkspace
                  ? task.workspacePath
                  : folder.path,
                updatedAt: Date.now(),
              }
            : task,
        ),
      );
      flashAppToast(`已关联本地项目：${folder.path}`);
    } catch (error) {
      setContextError(`关联本地项目失败：${errorMessage(error)}`);
    }
  }

  function startSshRemote() {
    setContextError("");
    if (!taskStorageReady) return;
    if (!window.kcode?.sshRemote) {
      setContextError("桌面主进程版本较旧，请重启应用后再试");
      return;
    }
    setSshRemoteDialogTaskId(uid());
  }

  function attachConnectedSshState(taskId: string, state: SshRemoteState) {
    if (!state.profile || !state.cachePath) return;
    setTasks((all) =>
      all.map((task) => {
        if (task.id !== taskId) return task;
        const current = task.remoteWorkspace;
        if (
          task.workspacePath === state.cachePath &&
          current?.id === state.profile!.id &&
          current.rootPath === state.profile!.rootPath &&
          current.hostFingerprint === state.profile!.hostFingerprint &&
          current.remembered === state.profile!.remembered
        )
          return task;
        return attachSshWorkspace(task, {
          profile: state.profile!,
          cachePath: state.cachePath!,
        });
      }),
    );
  }

  function createSshRemoteTask(state: SshRemoteState) {
    if (!state.profile || !state.cachePath) {
      setContextError("SSH Remote 连接未返回有效工作区信息。");
      return;
    }
    const existing = tasksRef.current.find((task) => task.id === state.taskId);
    if (existing) {
      attachConnectedSshState(state.taskId, state);
      setSshRemoteState(state);
      setWorkspaceView("editor");
      setContextError("");
      setSshRemoteDialogTaskId(undefined);
      return;
    }
    const now = Date.now();
    const task: TaskRecord = {
      id: state.taskId,
      name: state.profile.name,
      workspaceName: defaultRemoteWorkspaceName(state.profile),
      workspacePath: state.cachePath,
      remoteWorkspace: state.profile,
      createdAt: now,
      updatedAt: now,
      messages: [],
      activities: [],
      modelSelection: selected,
      collaboration: activeTask?.collaboration,
      reasoningEffort,
    };
    hydratedTaskIdsRef.current.add(task.id);
    setTasks((all) => [task, ...all]);
    claimTaskView(task.id);
    setActiveTaskId(task.id);
    setMessages([]);
    setActivities([]);
    setInput("");
    setAttachedFiles([]);
    setAttachedImages([]);
    setUsage({ input: 0, output: 0, cached: 0 });
    setUsageResolved(false);
    setDurationMs(0);
    setUsedContextCount(0);
    currentRequest.current = undefined;
    setRunningId(undefined);
    requestStartedRef.current = undefined;
    contextByMessageRef.current.clear();
    autoFollowRef.current = true;
    setWorkspaceView("editor");
    setStatusOpen(false);
    setSshRemoteState(state);
    setSshRemoteDialogTaskId(undefined);
  }

  async function createTask() {
    const now = Date.now();
    const task: TaskRecord = {
      id: uid(),
      name: newTaskName.trim() || pendingFolder?.name || "新任务",
      workspaceName: pendingFolder?.name,
      localWorkspacePath: pendingFolder?.path,
      workspacePath: pendingFolder?.path ?? "",
      createdAt: now,
      updatedAt: now,
      messages: [],
      activities: [],
      modelSelection: selected,
      collaboration: activeTask?.collaboration,
      reasoningEffort,
    };
    hydratedTaskIdsRef.current.add(task.id);
    setTasks((all) => [task, ...all]);
    claimTaskView(task.id);
    setActiveTaskId(task.id);
    setWorkspaceView("chat");
    setMessages([]);
    setActivities([]);
    setInput("");
    setAttachedFiles([]);
    setAttachedImages([]);
    setUsage({ input: 0, output: 0, cached: 0 });
    setUsageResolved(false);
    setDurationMs(0);
    setUsedContextCount(0);
    currentRequest.current = undefined;
    setRunningId(undefined);
    requestStartedRef.current = undefined;
    contextByMessageRef.current.clear();
    autoFollowRef.current = true;
    setPendingFolder(null);
    setNewTaskName("");
    setNewTaskOpen(false);
  }

  async function ensureTaskLoaded(task: TaskRecord) {
    if (hydratedTaskIdsRef.current.has(task.id) || !window.kcode?.state)
      return task;
    const stored = await window.kcode.state.loadTaskWindow(task.id);
    if (!stored) throw new Error(`找不到任务记录：${task.name}`);
    const loaded = normalizeStoredTask(stored.task as TaskRecord);
    rememberTaskPaging(task.id, stored.paging);
    hydratedTaskIdsRef.current.add(task.id);
    persistedTaskRefsRef.current.set(task.id, loaded);
    setTasks((current) =>
      current.map((item) => (item.id === loaded.id ? loaded : item)),
    );
    return loaded;
  }

  function taskHistoryIsPartial(taskId: string) {
    const paging = taskPagingRef.current.get(taskId);
    return Boolean(
      paging &&
      (paging.messages.hasMoreBefore ||
        paging.messages.hasMoreAfter ||
        paging.activities.hasMoreBefore ||
        paging.activities.hasMoreAfter),
    );
  }

  async function ensureFullTaskHistory(task: TaskRecord) {
    if (!window.kcode?.state || !taskHistoryIsPartial(task.id)) return task;
    const pending = fullHistoryLoadsRef.current.get(task.id);
    if (pending) return pending;
    const load = (async () => {
      const snapshot =
        tasksRef.current.find((item) => item.id === task.id) ?? task;
      await window.kcode.state.saveTask(snapshot.id, snapshot, {
        preserveUnloadedItems: true,
      });
      const stored = await window.kcode.state.loadTask(snapshot.id);
      if (!stored) throw new Error(`找不到任务记录：${snapshot.name}`);
      const persisted = normalizeStoredTask(stored as TaskRecord);
      const latest =
        tasksRef.current.find((item) => item.id === snapshot.id) ?? snapshot;
      const loaded: TaskRecord = {
        ...persisted,
        ...latest,
        messages: prependUniqueItems(persisted.messages, latest.messages),
        activities: prependUniqueItems(persisted.activities, latest.activities),
      };
      rememberTaskPaging(snapshot.id, {
        messages: completePageMetadata(loaded.messages),
        activities: completePageMetadata(loaded.activities),
      });
      const nextTasks = tasksRef.current.map((item) =>
        item.id === loaded.id ? loaded : item,
      );
      tasksRef.current = nextTasks;
      setTasks(nextTasks);
      if (latest === snapshot)
        persistedTaskRefsRef.current.set(loaded.id, loaded);
      if (
        isTaskViewCurrent(
          activeTaskIdRef.current,
          displayedTaskIdRef.current,
          loaded.id,
        )
      ) {
        setMessages(loaded.messages);
        setActivities(loaded.activities);
      }
      return loaded;
    })();
    fullHistoryLoadsRef.current.set(task.id, load);
    try {
      return await load;
    } finally {
      fullHistoryLoadsRef.current.delete(task.id);
    }
  }

  async function switchTask(task: TaskRecord) {
    if (task.id === activeTaskId) return;
    const switchSequence = ++taskSwitchSequenceRef.current;
    try {
      task = await ensureTaskLoaded(task);
    } catch (error) {
      setContextError(`任务加载失败：${errorMessage(error)}`);
      return;
    }
    if (switchSequence !== taskSwitchSequenceRef.current) return;
    persistTaskDrafts(readComposerValue());
    if (activeTaskId)
      attachmentDraftsRef.current.set(activeTaskId, {
        files: attachedFiles,
        images: attachedImages,
      });
    if (displayedTaskIdRef.current)
      conversationWindowByTaskRef.current.set(
        displayedTaskIdRef.current,
        visibleTurnWindow,
      );
    const conversation = conversationRef.current;
    if (conversation && displayedTaskIdRef.current) {
      // When follow mode is active, the container may be between layout
      // passes while switching tasks. Treat it as bottom even if the
      // instantaneous geometry has not caught up yet.
      const atBottom =
        autoFollowRef.current ||
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
    const targetTurnCount = task.messages.reduce(
      (count, message) => count + (message.role === "user" ? 1 : 0),
      0,
    );
    pagedTaskRef.current = task.id;
    const targetWindow = targetScroll.atBottom
      ? latestConversationWindow(targetTurnCount, conversationPageSize)
      : (conversationWindowByTaskRef.current.get(task.id) ??
        latestConversationWindow(targetTurnCount, conversationPageSize));
    setVisibleTurnWindow(targetWindow);
    claimTaskView(task.id);
    currentRequest.current = task.runningId;
    setRunningId(task.runningId);
    requestStartedRef.current = task.startedAt;
    setActiveTaskId(task.id);
    setWorkspaceView(resolveWorkspaceView(task));
    setSshRemoteState(undefined);
    setMessages(task.messages);
    setActivities(task.activities);
    setSelected(task.modelSelection || selected);
    setReasoningEffort(task.reasoningEffort || defaultReasoningEffort);
    setInput(initialDrafts.current[task.id] ?? "");
    const attachmentDraft = attachmentDraftsRef.current.get(task.id);
    setAttachedFiles(attachmentDraft?.files ?? []);
    setUsage(task.usage ?? { input: 0, output: 0, cached: 0 });
    setUsageResolved(Boolean(task.usageResolved));
    setDurationMs(task.durationMs ?? 0);
    setUsedContextCount(task.usedContextCount ?? 0);
    setAttachedImages(attachmentDraft?.images ?? []);
    contextByMessageRef.current.clear();
    autoFollowRef.current = targetScroll.atBottom;
    conversationScrollControllerRef.current.reset();
    setShowScrollToBottom(!targetScroll.atBottom);
  }

  async function openTaskEditor(taskId: string) {
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (
      !task ||
      (!task.workspacePath && !task.localWorkspacePath && !task.remoteWorkspace)
    )
      return;
    await switchTask(task);
    setWorkspaceView("editor");
    setStatusOpen(false);
  }

  async function createConversation(workspaceKey: string) {
    if (creatingConversationPathsRef.current.has(workspaceKey)) return;
    const feedbackStartedAt = performance.now();
    creatingConversationPathsRef.current.add(workspaceKey);
    setCreatingConversationPaths(
      new Set(creatingConversationPathsRef.current),
    );
    try {
      const sourceTask = tasksRef.current.find(
        (task) => sidebarWorkspaceKey(task) === workspaceKey,
      );
      if (!sourceTask) return;
      const now = Date.now();
      const taskId = uid();
      let targetWorkspacePath = sourceTask.workspacePath;
      let remoteWorkspace = sourceTask.remoteWorkspace;
      if (remoteWorkspace && window.kcode?.sshRemote) {
        try {
          const state = await restoreSshRemoteConnection(
            window.kcode.sshRemote,
            taskId,
            remoteWorkspace,
          );
          remoteWorkspace = state.profile ?? remoteWorkspace;
          targetWorkspacePath = state.cachePath ?? targetWorkspacePath;
        } catch (error) {
          if (isSshRemoteCredentialsRequired(error) && sourceTask)
            setSshRemoteDialogTaskId(sourceTask.id);
          setContextError(
            isSshRemoteCredentialsRequired(error)
              ? "SSH Remote 凭据需要重新确认；连接信息已填入，重新连接后再创建会话。"
              : `SSH Remote 连接失败：${errorMessage(error)}`,
          );
          return;
        }
      }
      const task: TaskRecord = {
        id: taskId,
        name: "新对话",
        workspaceName: sourceTask ? taskWorkspaceName(sourceTask) : undefined,
        localWorkspacePath: sourceTask?.localWorkspacePath,
        workspacePath: targetWorkspacePath,
        remoteWorkspace,
        createdAt: now,
        updatedAt: now,
        messages: [],
        activities: [],
        modelSelection: selected,
        collaboration: activeTask?.collaboration,
        reasoningEffort,
      };
      hydratedTaskIdsRef.current.add(task.id);
      setTasks((all) => {
        const workspaceIndex = all.findIndex(
          (item) => sidebarWorkspaceKey(item) === workspaceKey,
        );
        if (workspaceIndex < 0) return [task, ...all];
        const next = [...all];
        next.splice(workspaceIndex, 0, task);
        return next;
      });
      claimTaskView(task.id);
      setActiveTaskId(task.id);
      setWorkspaceView(remoteWorkspace ? "editor" : "chat");
      setMessages([]);
      setActivities([]);
      setInput("");
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
      flashAppToast("已新建对话");
    } catch (error) {
      setContextError(`新建对话失败：${errorMessage(error)}`);
      flashAppToast("新建对话失败", "error");
    } finally {
      const feedbackDelay = Math.max(
        0,
        450 - (performance.now() - feedbackStartedAt),
      );
      if (feedbackDelay)
        await new Promise<void>((resolve) =>
          window.setTimeout(resolve, feedbackDelay),
        );
      creatingConversationPathsRef.current.delete(workspaceKey);
      setCreatingConversationPaths(
        new Set(creatingConversationPathsRef.current),
      );
    }
  }

  async function forkTask(sourceTask?: TaskRecord) {
    const selectedTask = sourceTask ?? activeTask;
    if (!selectedTask) return;
    try {
      const source = await ensureTaskLoaded(selectedTask);
      const full = await ensureFullTaskHistory(source);
      const now = Date.now();
      const fork: TaskRecord = {
        ...full,
        id: uid(),
        name: `${full.name} · 分支`,
        createdAt: now,
        updatedAt: now,
        messages: full.messages.map((message) => ({
          ...message,
          images: message.images?.map((image) => ({ ...image })),
        })),
        // Execution activities belong to the source run. A branch keeps the
        // conversation context but starts with a clean execution ledger.
        activities: [],
        runningId: undefined,
        runStatus: "idle",
        startedAt: undefined,
        durationMs: 0,
        usage: { input: 0, output: 0, cached: 0 },
        usageResolved: false,
        parentTaskId: full.id,
        forkedFromMessageId: full.messages.at(-1)?.id,
      };
      hydratedTaskIdsRef.current.add(fork.id);
      setTasks((all) => [fork, ...all]);
      claimTaskView(fork.id);
      setActiveTaskId(fork.id);
      setWorkspaceView(fork.remoteWorkspace ? "editor" : "chat");
      setMessages(fork.messages);
      setActivities([]);
      setInput(initialDrafts.current[fork.id] ?? "");
      setAttachedFiles([]);
      setAttachedImages([]);
      setUsage(fork.usage ?? { input: 0, output: 0, cached: 0 });
      setUsageResolved(false);
      setDurationMs(0);
      setUsedContextCount(fork.usedContextCount ?? 0);
      currentRequest.current = undefined;
      setRunningId(undefined);
      requestStartedRef.current = undefined;
      contextByMessageRef.current.clear();
      autoFollowRef.current = true;
      setShowScrollToBottom(false);
      flashContextToast("已从当前会话创建分支");
    } catch (error) {
      setContextError(`创建会话分支失败：${errorMessage(error)}`);
    }
  }

  async function exportActiveTask(format: "md" | "json") {
    if (!activeTask) return;
    try {
      const source = await ensureFullTaskHistory(await ensureTaskLoaded(activeTask));
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const baseName = `${source.name || "kcode-session"}-${stamp}`;
      const content =
        format === "json"
          ? JSON.stringify(source, null, 2)
          : [
              `# ${source.name}`,
              "",
              `- 工作区：${source.workspacePath || "未设置"}`,
              `- 创建时间：${new Date(source.createdAt).toLocaleString()}`,
              `- 导出时间：${new Date().toLocaleString()}`,
              "",
              ...source.messages.flatMap((message) => [
                `## ${message.role === "user" ? "用户" : `助手 · ${message.model || "Agent"}`}`,
                "",
                message.content || "（空消息）",
                "",
              ]),
              "## 执行记录",
              "",
              ...source.activities.map(
                (activity) =>
                  `- ${activity.status === "success" ? "完成" : activity.status === "failed" ? "失败" : activity.status}：${activity.title}${activity.path ? ` · ${activity.path}` : ""}${activity.output ? `\n\n  ${activity.output.slice(-2_000).replace(/\n/g, "\n  ")}` : ""}`,
              ),
              "",
            ].join("\n");
      if (window.kcode?.files?.saveText) {
        const saved = await window.kcode.files.saveText(baseName, content, format);
        if (saved) flashAppToast(`已导出到 ${saved}`);
        return;
      }
      const blob = new Blob([content], {
        type: format === "json" ? "application/json" : "text/markdown",
      });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${baseName}.${format}`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (error) {
      setContextError(`导出会话失败：${errorMessage(error)}`);
    }
  }

  async function removeTask(task: TaskRecord) {
    taskRuntimeStore.clear(task.id);
    delete initialDrafts.current[task.id];
    attachmentDraftsRef.current.delete(task.id);
    hydratedTaskIdsRef.current.delete(task.id);
    forgetTaskPaging(task.id);
    persistedTaskRefsRef.current.delete(task.id);
    scrollStateByTaskRef.current.delete(task.id);
    conversationWindowByTaskRef.current.delete(task.id);
    localStorage.setItem(
      "kcode.taskDrafts",
      JSON.stringify(initialDrafts.current),
    );
    if (window.kcode) {
      if (task.remoteWorkspace)
        await window.kcode.sshRemote.disconnect(task.id).catch(() => undefined);
      await window.kcode.chat.cancelSummary(task.id);
      const requestIds = task.messages
        .filter((message) => message.id.startsWith("assistant:"))
        .map((message) => message.id.slice("assistant:".length));
      await window.kcode.chat.cleanup(
        requestIds,
        task.activities.map((activity) => activity.id),
      );
      requestIds.forEach((id) => requestTasksRef.current.delete(id));
      await window.kcode.state.deleteTask(task.id);
    }
    // Use the live ref, not the render-time `tasks` closure: awaits above
    // yield to streaming `onEvent` updates, so a stale snapshot here would
    // roll back concurrent tasks' progress. Filter off the latest state.
    const nextTasks = tasksRef.current.filter((item) => item.id !== task.id);
    setTasks(nextTasks);
    if (task.id === activeTaskId) {
      const next = nextTasks[0];
      if (next) {
        const loadedNext = await ensureTaskLoaded(next);
        const attachmentDraft = attachmentDraftsRef.current.get(loadedNext.id);
        claimTaskView(loadedNext.id);
        setActiveTaskId(loadedNext.id);
        setWorkspaceView(resolveWorkspaceView(loadedNext));
        setMessages(loadedNext.messages);
        setActivities(loadedNext.activities);
        setInput(initialDrafts.current[loadedNext.id] ?? "");
        setRunningId(loadedNext.runningId);
        currentRequest.current = loadedNext.runningId;
        requestStartedRef.current = loadedNext.startedAt;
        setSelected(loadedNext.modelSelection || selected);
        setReasoningEffort(
          loadedNext.reasoningEffort || defaultReasoningEffort,
        );
        setAttachedFiles(attachmentDraft?.files ?? []);
        setAttachedImages(attachmentDraft?.images ?? []);
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

  async function toggleTaskArchived(task: TaskRecord) {
    try {
      task = await ensureTaskLoaded(task);
    } catch (error) {
      setContextError(`任务加载失败：${errorMessage(error)}`);
      return;
    }
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
        ? await window.kcode.context.pickFiles(effectiveContextDirectory)
        : [
            {
              id: uid(),
              name: "README.md",
              path: "D:/project/kcode/README.md",
              content: "# KCode\n\nMulti-provider desktop coding agent.",
              size: 55,
            },
          ];
      if (files[0]) rememberTaskContextDirectory(files[0].path);
      const merged = mergeContextFiles(attachedFiles, files);
      setAttachedFiles(merged.files);
      const warnings = merged.totalOverflow.map(
        (file) => `${file.name} 超出 2 MB 上下文文件总量限制`,
      );
      if (merged.countOverflow)
        warnings.push(
          `最多添加 ${MAX_CONTEXT_FILES} 个上下文文件，已忽略 ${merged.countOverflow} 个`,
        );
      setContextError(warnings.join("；"));
    } catch (error) {
      setContextError(errorMessage(error));
    }
  }

  function attachmentPath(file: File) {
    try {
      return window.kcode?.context.filePath?.(file) || file.name;
    } catch {
      return file.name;
    }
  }

  function rememberTaskContextDirectory(filePath: string) {
    const directory = directoryFromFilePath(filePath);
    if (directory && directory !== activeTask?.contextDirectory)
      patchActiveTask({ contextDirectory: directory });
  }

  async function addImageFiles(files: File[]) {
    const errors: string[] = [];
    if (!files.length) return errors;
    const remaining = Math.max(0, MAX_IMAGE_FILES - attachedImages.length);
    if (!remaining) return [`每次最多添加 ${MAX_IMAGE_FILES} 张图片`];
    const selectedFiles = files.slice(0, remaining);
    const settled = await Promise.allSettled(
      selectedFiles.map(async (file, index): Promise<ImageAttachment> => {
        const mediaType = imageMediaType(file.type, file.name);
        if (!mediaType)
          throw new Error(`${file.name || "图片"} 不是支持的图片格式`);
        if (file.size > MAX_IMAGE_FILE_BYTES)
          throw new Error(`${file.name || `图片 ${index + 1}`} 超过 5 MB`);
        return {
          id: uid(),
          name: file.name || `图片 ${Date.now()}-${index + 1}.png`,
          mediaType,
          dataUrl: await fileDataUrl(file),
          size: file.size,
        };
      }),
    );
    const images: ImageAttachment[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") images.push(result.value);
      else errors.push(errorMessage(result.reason));
    }
    if (images.length)
      setAttachedImages((current) =>
        [...current, ...images].slice(0, MAX_IMAGE_FILES),
      );
    if (files.length > remaining)
      errors.push(
        `最多添加 ${MAX_IMAGE_FILES} 张图片，已忽略 ${files.length - remaining} 张`,
      );
    return errors;
  }

  async function addDroppedContextFiles(files: File[]) {
    const errors: string[] = [];
    if (!files.length) return errors;
    const seenPaths = new Set(attachedFiles.map((file) => file.path));
    const eligible: { file: File; path: string }[] = [];
    for (const file of files) {
      const path = attachmentPath(file);
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      if (!isSupportedContextFile(file.name)) {
        errors.push(`${file.name} 不是支持的文本或代码文件`);
        continue;
      }
      const binaryDocument = isBinaryContextFile(file.name);
      if (file.size > (binaryDocument ? MAX_CONTEXT_SOURCE_BYTES : MAX_CONTEXT_FILE_BYTES)) {
        errors.push(
          binaryDocument
            ? `${file.name} 超过 ${Math.round(MAX_CONTEXT_SOURCE_BYTES / 1024 / 1024)} MB，无法解析`
            : `${file.name} 超过 512 KB，无法作为上下文添加`,
        );
        continue;
      }
      eligible.push({ file, path });
    }
    const selectedFiles = eligible.slice(0, MAX_CONTEXT_FILES);
    const settled = await Promise.allSettled(
      selectedFiles.map(async ({ file, path }): Promise<ContextFile> => {
        if (isBinaryContextFile(file.name)) {
          if (!window.kcode?.files?.parse)
            throw new Error(`${file.name} 需要桌面版文档解析支持`);
          return window.kcode.files.parse(path);
        }
        const content = await file.text();
        if (content.includes("\0"))
          throw new Error(`${file.name} 不是有效的文本文件`);
        return {
          id: uid(),
          name: file.name,
          path,
          content,
          size: file.size,
        };
      }),
    );
    const accepted: ContextFile[] = [];
    for (const result of settled) {
      if (result.status === "rejected") {
        errors.push(errorMessage(result.reason));
        continue;
      }
      accepted.push(result.value);
    }
    const merged = mergeContextFiles(attachedFiles, accepted);
    if (merged.files.length !== attachedFiles.length)
      setAttachedFiles(merged.files);
    errors.push(
      ...merged.totalOverflow.map(
        (file) => `${file.name} 超出 2 MB 上下文文件总量限制`,
      ),
    );
    const countOverflow =
      eligible.length - selectedFiles.length + merged.countOverflow;
    if (countOverflow)
      errors.push(
        `最多添加 ${MAX_CONTEXT_FILES} 个上下文文件，已忽略 ${countOverflow} 个`,
      );
    return errors;
  }

  async function pasteImages(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    setContextError((await addImageFiles(files)).join("；"));
  }

  function composerDragHasFiles(event: React.DragEvent<HTMLDivElement>) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleComposerDragEnter(event: React.DragEvent<HTMLDivElement>) {
    if (!composerDragHasFiles(event)) return;
    event.preventDefault();
    composerDragDepthRef.current += 1;
    if (!runningId && !summaryBusy) setComposerDragActive(true);
  }

  function handleComposerDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!composerDragHasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = runningId || summaryBusy ? "none" : "copy";
  }

  function handleComposerDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (!composerDragHasFiles(event)) return;
    composerDragDepthRef.current = Math.max(
      0,
      composerDragDepthRef.current - 1,
    );
    if (!composerDragDepthRef.current) setComposerDragActive(false);
  }

  async function handleComposerDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!composerDragHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = 0;
    setComposerDragActive(false);
    if (runningId || summaryBusy) {
      setContextError("当前任务运行时不能添加附件");
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    const imageFiles: File[] = [];
    const contextFiles: File[] = [];
    for (const file of files) {
      if (imageMediaType(file.type, file.name)) imageFiles.push(file);
      else contextFiles.push(file);
    }
    const validSource = files.find(
      (file) =>
        Boolean(imageMediaType(file.type, file.name)) ||
        isSupportedContextFile(file.name),
    );
    if (validSource) rememberTaskContextDirectory(attachmentPath(validSource));
    const [imageErrors, fileErrors] = await Promise.all([
      addImageFiles(imageFiles),
      addDroppedContextFiles(contextFiles),
    ]);
    setContextError([...imageErrors, ...fileErrors].join("；"));
  }

  async function compactActiveConversation() {
    if (!activeTask) return;
    if (!selectedContextWindow) {
      setContextError("请先为当前模型配置上下文窗口");
      return;
    }
    let task: TaskRecord;
    try {
      task = await ensureFullTaskHistory(activeTask);
    } catch (error) {
      setContextError(`加载完整对话失败：${errorMessage(error)}`);
      return;
    }
    const compacted = compactConversation(task, selectedContextWindow, true);
    if (!compacted) {
      setContextError("当前对话较短，保留最近一轮后暂无可压缩内容");
      return;
    }
    const beforeTokens = estimateRequestContextTokens({
      messages: task.messages,
      compactedMessageCount: task.compactedMessageCount ?? 0,
      contextSummary: task.contextSummary,
      attachmentTokens: 0,
      outputReserve: 0,
      calibrationFactor,
      retainedContext: retainedCompactionContext(
        task.messages,
        task.compactedMessageCount ?? 0,
        selectedContextWindow,
      ),
    });
    setSummarizingTasks((current) => new Set(current).add(task.id));
    let finalCompacted = compacted;
    try {
      finalCompacted = await improveSummaryWithModel(task, compacted);
    } finally {
      setSummarizingTasks((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
    setTasks((all) =>
      all.map((item) =>
        item.id === task.id
          ? {
              ...item,
              ...finalCompacted,
              usage: clearPromptTokenSnapshot(item.usage),
              summarySnapshots: summarySnapshot(task),
              summaryMeta:
                "summaryMeta" in finalCompacted
                  ? (finalCompacted.summaryMeta as TaskRecord["summaryMeta"])
                  : { modelGenerated: false, durationMs: 0 },
              updatedAt: Date.now(),
            }
          : item,
      ),
    );
    const afterTokens = estimateRequestContextTokens({
      messages: task.messages,
      compactedMessageCount:
        finalCompacted.compactedMessageCount ?? compacted.compactedMessageCount,
      contextSummary: finalCompacted.contextSummary,
      attachmentTokens: 0,
      outputReserve: 0,
      calibrationFactor,
      retainedContext: retainedCompactionContext(
        task.messages,
        finalCompacted.compactedMessageCount ??
          compacted.compactedMessageCount,
        selectedContextWindow,
      ),
    });
    setTasks((all) =>
      all.map((item) =>
        item.id === task.id
          ? {
              ...item,
              contextWindowState: markContextCompacted(
                item.contextWindowState,
                item.id,
                afterTokens,
                selectedContextWindow,
              ),
            }
          : item,
      ),
    );
    flashContextToast(
      `已压缩 ${finalCompacted.compactedMessageCount} 条较早消息：${formatContextPercent(beforeTokens, selectedContextWindow)} → ${formatContextPercent(afterTokens, selectedContextWindow)}，最近对话和关键状态继续保留`,
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
    const contextWindow = resolveModelContextWindow(
      target.model.modelId,
      target.model.contextWindow,
    );
    try {
      const result = await window.kcode.chat.summarize({
        taskId: task.id,
        providerId: target.provider.id,
        modelId: target.model.modelId,
        source: contextSummarySource(
          task,
          local.compactedMessageCount,
          contextWindow,
        ),
        ledger: local.contextLedger,
      });
      const accepted = acceptModelContextSummary(local, result, contextWindow);
      if (!accepted) return local;
      return {
        ...local,
        contextSummary: accepted.summary,
        contextLedger: accepted.ledger,
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
        compactedMessageCount: task.compactedMessageCount ?? 0,
        modelGenerated: task.summaryMeta?.modelGenerated ?? false,
        durationMs: task.summaryMeta?.durationMs,
        usage: task.summaryMeta?.usage,
      },
      ...(task.summarySnapshots ?? []),
    ].slice(0, 3);
  }

  async function rebuildActiveSummary() {
    if (!activeTask || !selectedContextWindow) return;
    let task: TaskRecord;
    try {
      task = await ensureFullTaskHistory(activeTask);
    } catch (error) {
      setContextError(`加载完整对话失败：${errorMessage(error)}`);
      return;
    }
    const taskId = task.id;
    const local = compactConversation(
      {
        ...task,
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
      const compacted = await improveSummaryWithModel(task, local);
      setTasks((all) =>
        all.map((task) =>
          task.id === taskId
            ? {
                ...task,
                ...compacted,
                usage: clearPromptTokenSnapshot(task.usage),
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
              usage: clearPromptTokenSnapshot(task.usage),
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
              compactedMessageCount: snapshot.compactedMessageCount ?? 0,
              usage: clearPromptTokenSnapshot(task.usage),
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

  function queueMessage() {
    const text = readComposerValue().trim();
    if ((!text && !attachedImages.length) || !activeTask || summaryBusy) return;
    const user: QueuedChatMessage = {
      id: uid(),
      role: "user",
      content: text || "请分析这些图片",
      createdAt: Date.now(),
      images: attachedImages,
      contextAttachments: attachedFiles.length
        ? attachedFiles.map(({ name, size }) => ({ name, size }))
        : undefined,
      queued: true,
    };
    contextByMessageRef.current.set(user.id, attachedFiles);
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
    attachmentDraftsRef.current.delete(activeTask.id);
    autoFollowRef.current = true;
    scrollAfterSendRef.current = true;
    setShowScrollToBottom(false);
    flashContextToast("消息已排队，将在当前回复完成后发送");
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
              messages: task.messages.filter((message) => message.id !== messageId),
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
    const moveFirst = (all: ChatMessage[]) => {
      const item = all.find((message) => message.id === messageId);
      if (!item) return all;
      return [
        ...all.filter(
          (message) =>
            message.id !== messageId &&
            !(message.role === "user" && (message as QueuedChatMessage).queued),
        ),
        item,
        ...all.filter(
          (message) =>
            message.id !== messageId &&
            message.role === "user" && (message as QueuedChatMessage).queued,
        ),
      ];
    };
    setMessages(moveFirst);
    setTasks((all) =>
      all.map((task) =>
        task.id === activeTask.id
          ? { ...task, messages: moveFirst(task.messages), updatedAt: Date.now() }
          : task,
      ),
    );
  }

  async function send(
    override?: string,
    queuedMessageId?: string,
    queuedTaskId?: string,
  ) {
    const lockTaskId = queuedTaskId ?? activeTask?.id ?? "";
    // Synchronous re-entrancy guard: the runningId/runStatus checks below
    // only see state written after several awaits, so a fast second click
    // (or Enter) would slip through before the first call locks the task.
    if (lockTaskId && sendingTasksRef.current.has(lockTaskId)) return;
    if (lockTaskId) sendingTasksRef.current.add(lockTaskId);
    try {
      await sendInner(override, queuedMessageId, queuedTaskId);
    } finally {
      if (lockTaskId) sendingTasksRef.current.delete(lockTaskId);
    }
  }

  async function sendInner(
    override?: string,
    queuedMessageId?: string,
    queuedTaskId?: string,
  ) {
    let requestTask = queuedTaskId
      ? tasksRef.current.find((task) => task.id === queuedTaskId)
      : activeTask;
    const taskId = requestTask?.id ?? "";
    const taskIsCurrent = () =>
      isTaskViewCurrent(
        activeTaskIdRef.current,
        displayedTaskIdRef.current,
        taskId,
      );
    if (requestTask && taskHistoryIsPartial(requestTask.id)) {
      try {
        requestTask = await ensureFullTaskHistory(requestTask);
      } catch (error) {
        if (taskIsCurrent())
          setContextError(`加载完整对话失败：${errorMessage(error)}`);
        return;
      }
    }
    const taskMessages = requestTask
      ? taskIsCurrent()
        ? prependUniqueItems(requestTask.messages, messages)
        : requestTask.messages
      : [];
    const taskSelection = requestTask?.modelSelection || selected;
    const taskSummaryBusy = Boolean(
      requestTask && summarizingTasks.has(requestTask.id),
    );
    let text = queuedMessageId ? "" : (override ?? readComposerValue()).trim();
    const target = models.find(
      (x) => `${x.provider.id}|${x.model.id}` === taskSelection,
    );
    if (
      (!text && !attachedImages.length && !queuedMessageId) ||
      !target ||
      !requestTask ||
      requestTask.runningId ||
      requestTask.runStatus === "running" ||
      taskSummaryBusy
    )
      return;
    const requestRemoteWorkspace = requestTask.remoteWorkspace;
    if (!requestTask.workspacePath && !requestRemoteWorkspace) {
      setAssignFolderForTask(requestTask);
      return;
    }
    if (requestRemoteWorkspace && window.kcode?.sshRemote) {
      try {
        const connected = await restoreSshRemoteConnection(
          window.kcode.sshRemote,
          taskId,
          requestRemoteWorkspace,
        );
        if (connected.profile && connected.cachePath) {
          requestTask = attachSshWorkspace(requestTask, {
            profile: connected.profile,
            cachePath: connected.cachePath,
          });
          attachConnectedSshState(taskId, connected);
        }
        if (taskIsCurrent()) setSshRemoteState(connected);
      } catch (error) {
        if (taskIsCurrent()) {
          const credentialsRequired = isSshRemoteCredentialsRequired(error);
          const message =
            credentialsRequired
              ? "SSH Remote 暂未连接；消息仍会发送，远程操作时将使用本轮提供的凭据重连。"
              : `SSH Remote 暂未连接：${errorMessage(error)}；消息仍会发送。`;
          const disconnected = await window.kcode.sshRemote
            .state(taskId, requestRemoteWorkspace.id)
            .catch(() => undefined);
          setSshRemoteState({
            taskId,
            connected: false,
            connecting: false,
            ...disconnected,
            profile:
              disconnected?.profile ?? requestRemoteWorkspace,
            cachePath: disconnected?.cachePath ?? requestTask.workspacePath,
            error: errorMessage(error),
          });
          setContextError("");
          flashContextToast(message);
        }
      }
    }
    const requestedCollaboration = requestTask.collaboration;
    const executorTarget = requestedCollaboration
      ? models.find(
          (item) =>
            `${item.provider.id}|${item.model.id}` ===
            requestedCollaboration.executorModelSelection,
        )
      : undefined;
    if (
      requestedCollaboration &&
      (!executorTarget ||
        !executorTarget.provider.hasApiKey ||
        requestedCollaboration.executorModelSelection === taskSelection)
    ) {
      setContextError("协作模式的执行模型不可用，请重新选择执行模型");
      return;
    }
    const collaboration = executorTarget
      ? {
          mode: "planner-executor" as const,
          executor: {
            providerId: executorTarget.provider.id,
            modelId: executorTarget.model.modelId,
            displayName: executorTarget.model.displayName,
            reasoningEffort: normalizeEffort(
              requestedCollaboration?.executorReasoningEffort ?? "auto",
              reasoningEffortsForModel(executorTarget.model),
            ),
            contextWindow: resolveModelContextWindow(
              executorTarget.model.modelId,
              executorTarget.model.contextWindow,
            ),
          },
        }
      : undefined;
    if (!queuedMessageId && !taskIsCurrent()) {
      setContextError("任务切换尚未完成，请重新发送");
      return;
    }
    if (requestTask.name === "新对话") {
      const title = text.replace(/\s+/g, " ").slice(0, 28) || "新对话";
      setTasks((all) =>
        all.map((task) =>
          task.id === taskId
            ? { ...task, name: title, updatedAt: Date.now() }
            : task,
        ),
      );
    }
    const queuedIndex = queuedMessageId
      ? taskMessages.findIndex(
          (message) =>
            message.id === queuedMessageId &&
            (message as QueuedChatMessage).queued,
        )
      : -1;
    if (queuedMessageId && queuedIndex < 0) return;
    const queuedMessage =
      queuedIndex >= 0
        ? (taskMessages[queuedIndex] as QueuedChatMessage)
        : undefined;
    if (queuedMessage) text = queuedMessage.content;
    const retrying = override !== undefined && !queuedMessage;
    const sourceMessages =
      queuedIndex >= 0 ? taskMessages.slice(0, queuedIndex + 1) : taskMessages;
    const latestAssistant = [...sourceMessages]
      .reverse()
      .find((message) => message.role === "assistant");
    const resumingInterruptedRun = Boolean(
      latestAssistant &&
        (latestAssistant.error ||
          ["cancelled", "paused", "failed"].includes(
            requestTask.runStatus ?? "",
          )),
    );
    const interruptedRecoveryContext = resumingInterruptedRun
      ? buildInterruptedRunRecoveryContext(
          requestTask.activities,
          assistantRequestId(latestAssistant),
        )
      : undefined;
    const cleanMessages = sourceMessages.filter((message) => {
      if (message.role !== "assistant") return true;
      // Keep useful partial output from interrupted rounds in the next request.
      // Only discard assistant placeholders that contain no model output.
      return !(message.error && !message.content.trim());
    });
    const user: ChatMessage = queuedMessage
      ? {
          id: queuedMessage.id,
          role: queuedMessage.role,
          content: queuedMessage.content,
          createdAt: queuedMessage.createdAt,
          images: queuedMessage.images,
          contextAttachments: queuedMessage.contextAttachments,
        }
      : retrying && cleanMessages.at(-1)?.role === "user"
        ? (cleanMessages.at(-1) as ChatMessage)
        : {
            id: uid(),
            role: "user",
            content: text || "请分析这些图片",
            createdAt: Date.now(),
            images: attachedImages,
            contextAttachments: attachedFiles.length
              ? attachedFiles.map(({ name, size }) => ({ name, size }))
              : undefined,
          };
    const nextMessages = queuedMessage
      ? cleanMessages.map((message) =>
          message.id === user.id ? user : message,
        )
      : retrying && cleanMessages.at(-1)?.role === "user"
        ? cleanMessages
        : [...cleanMessages, user];
    const visibleMessages = queuedMessage
      ? taskMessages.map((message) => (message.id === user.id ? user : message))
      : retrying
        ? taskMessages
        : [...taskMessages, user];
    const requestFiles = queuedMessage
      ? (contextByMessageRef.current.get(user.id) ?? [])
      : attachedFiles;
    if (!retrying && !queuedMessage)
      contextByMessageRef.current.set(user.id, requestFiles);
    const requestContextWindow = resolveModelContextWindow(
      target.model.modelId,
      target.model.contextWindow,
    );
    const requestEfforts = reasoningEffortsForModel(target.model);
    const requestReasoningEffort = normalizeEffort(
      requestTask.reasoningEffort ?? defaultReasoningEffort,
      requestEfforts,
    );
    const requestTaskWithSelection = requestTask.modelSelection
      ? requestTask
      : { ...requestTask, modelSelection: taskSelection };
    let requestSummary = requestTask.contextSummary;
    let requestLedger = requestTask.contextLedger;
    let compactedCount = requestTask.compactedMessageCount ?? 0;
    let contextNotice = "";
    const attachmentTokens = requestFiles.reduce(
      (total, file) => total + estimateTextTokens(file.content),
      0,
    );
    const outputReserve = outputTokenReserve(
      requestContextWindow,
      requestEfforts.some((effort) => effort !== "auto"),
    );
    const requestCalibrationKey = `${target.provider.id}|${target.model.modelId}`;
    const requestCalibrationFactor =
      tokenCalibration[requestCalibrationKey] ?? 1;
    let retainedContext = retainedCompactionContext(
      nextMessages,
      compactedCount,
      requestContextWindow,
    );
    let rawEstimatedTokens = estimateRequestContextTokens({
      messages: nextMessages,
      compactedMessageCount: compactedCount,
      contextSummary: requestSummary,
      attachmentTokens,
      outputReserve,
      calibrationFactor: 1,
      retainedContext,
    });
    // Use the last round's prompt tokens as the observed floor, not the
    // accumulated billing total (usage.input) which grows every round and would
    // otherwise inflate the estimate and trigger premature compaction.
    const estimatedTokens = Math.max(
      requestTask.usage?.promptTokens ?? 0,
      Math.ceil(rawEstimatedTokens * requestCalibrationFactor),
    );
    const contextRatio = requestContextWindow
      ? estimatedTokens / requestContextWindow
      : 0;
    if (
      contextRatio >= CONTEXT_COMPACT_WARNING_RATIO &&
      contextRatio < CONTEXT_AUTO_COMPACT_RATIO
    )
      contextNotice = `预计下一次请求将占用 ${formatContextPercent(estimatedTokens, requestContextWindow)}，达到 ${Math.round(CONTEXT_AUTO_COMPACT_RATIO * 100)}% 时自动压缩`;
    if (
      requestContextWindow &&
      contextRatio >= CONTEXT_AUTO_COMPACT_RATIO &&
      requestTask
    ) {
      let compacted = compactConversation(
        { ...requestTask, messages: nextMessages },
        requestContextWindow,
      );
      if (contextRatio >= CONTEXT_FORCE_COMPACT_RATIO && !compacted)
        compacted = compactConversation(
          { ...requestTask, messages: nextMessages },
          requestContextWindow,
          true,
        );
      if (compacted) {
        setSummarizingTasks((current) => new Set(current).add(taskId));
        let finalCompacted = compacted;
        try {
          finalCompacted = await improveSummaryWithModel(
            { ...requestTaskWithSelection, messages: nextMessages },
            compacted,
          );
        } finally {
          setSummarizingTasks((current) => {
            const next = new Set(current);
            next.delete(taskId);
            return next;
          });
        }
        requestSummary = finalCompacted.contextSummary;
        requestLedger = finalCompacted.contextLedger;
        compactedCount = finalCompacted.compactedMessageCount ?? compactedCount;
        retainedContext = retainedCompactionContext(
          nextMessages,
          compactedCount,
          requestContextWindow,
        );
        rawEstimatedTokens = estimateRequestContextTokens({
          messages: nextMessages,
          compactedMessageCount: compactedCount,
          contextSummary: requestSummary,
          attachmentTokens,
          outputReserve,
          calibrationFactor: 1,
          retainedContext,
        });
        const afterEstimatedTokens = Math.ceil(
          rawEstimatedTokens * requestCalibrationFactor,
        );
        setTasks((all) =>
          all.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  ...finalCompacted,
                  contextWindowState: markContextCompacted(
                    task.contextWindowState,
                    task.id,
                    afterEstimatedTokens,
                    requestContextWindow,
                  ),
                  usage: clearPromptTokenSnapshot(task.usage),
                  summarySnapshots: summarySnapshot(task),
                  summaryMeta:
                    "summaryMeta" in finalCompacted
                      ? (finalCompacted.summaryMeta as TaskRecord["summaryMeta"])
                      : { modelGenerated: false, durationMs: 0 },
                  updatedAt: Date.now(),
                }
              : task,
          ),
        );
        contextNotice = `上下文 ${formatContextPercent(estimatedTokens, requestContextWindow)} → ${formatContextPercent(afterEstimatedTokens, requestContextWindow)}，已自动压缩 ${compactedCount} 条较早消息`;
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
      const recoveryNotice =
        resumingInterruptedRun && role === "user" && id === user.id
          ? "\n\n<interrupted_turn_recovery>上一轮被停止、暂停或中断。已有助手输出和持久化工具证据仍然有效。若当前要求是总结或给出结论，请直接基于已有结果回答，不要重新执行整轮检查；若要求继续，再从尚未完成的步骤接着做。</interrupted_turn_recovery>"
          : "";
      return {
        role,
        content: `${fileContext ? `${content}\n\n${fileContext}` : content}${recoveryNotice}`,
        images,
      };
    });
    if (requestSummary) {
      history.unshift({
        role: "user",
        content: `<conversation_summary>\n这是较早对话的压缩检查点，由另一个模型交接而来。请延续其中的目标、约束、决策、已验证结果与未完成步骤，不要重复已经完成的工作：\n${requestSummary}\n${requestLedger ? `\n<fact_ledger>${JSON.stringify(requestLedger)}</fact_ledger>` : ""}\n</conversation_summary>`,
        images: undefined,
      });
    }
    if (retainedContext) {
      history.unshift({
        role: "user",
        content: retainedContext,
        images: undefined,
      });
    }
    const payloadBytes = new TextEncoder().encode(
      JSON.stringify(history),
    ).byteLength;
    if (payloadBytes > 24 * 1024 * 1024) {
      if (taskIsCurrent())
        setContextError(
          `请求内容 ${(payloadBytes / 1024 / 1024).toFixed(1)} MB，超过 24 MB 限制；请压缩上下文或减少图片/附件`,
        );
      return;
    }
    const requestStartedAt = Date.now();
    if (taskIsCurrent()) {
      autoFollowRef.current = true;
      scrollAfterSendRef.current = true;
      setShowScrollToBottom(false);
      requestStartedRef.current = requestStartedAt;
      setUsedContextCount(requestFiles.length);
      if (!queuedMessage) {
        clearTaskDraft(taskId);
        setAttachedFiles([]);
        setAttachedImages([]);
        attachmentDraftsRef.current.delete(taskId);
      }
      if (contextNotice) flashContextToast(contextNotice);
      setMessages(visibleMessages);
      if (!queuedMessage) setInput("");
      setUsage({ input: 0, output: 0, cached: 0 });
      setUsageResolved(false);
      setDurationMs(0);
    }
    setTasks((all) =>
      all.map((task) =>
        task.id === taskId
          ? { ...task, usedContextCount: requestFiles.length }
          : task,
      ),
    );
    if (!window.kcode) {
      if (!taskIsCurrent()) return;
      const id = `preview:${uid()}`;
      const response = `我已经检查了当前项目${requestFiles.length ? `和 **${requestFiles.length} 个上下文文件**` : ""}。当前使用${effortLabels[requestReasoningEffort]}推理强度，下一步建议优先完成：\n\n1. 接入工作区文件读取与代码搜索\n2. 建立工具调用的权限确认流程\n3. 在任务右侧展示实时执行进度\n\n\`\`\`ts\nconst result = await agent.run({\n  workspace: \"D:/project/kcode\",\n  model: \"${target.model.modelId}\",\n});\n\`\`\`\n\n> 当前模型通道正常，桌面端可以继续接入 Agent 工具循环。`;
      const chunks = response.match(/[\s\S]{1,12}/g) ?? [response];
      currentRequest.current = id;
      taskRuntimeStore.start(taskId, id, requestStartedAt);
      setRunningId(id);
      setTasks((all) =>
        all.map((task) =>
          task.id === taskId
            ? {
                ...task,
                runningId: id,
                runStatus: "running",
                startedAt: requestStartedAt,
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
          const completedAt = Date.now();
          setMessages((all) =>
            all.map((message) =>
              message.id === `assistant:${id}`
                ? { ...message, completedAt }
                : message,
            ),
          );
          currentRequest.current = undefined;
          taskRuntimeStore.finish(taskId, id);
          setRunningId(undefined);
          setTasks((all) =>
            all.map((task) =>
              task.id === taskId
                ? {
                    ...task,
                    runningId: undefined,
                    runStatus: "completed",
                    updatedAt: completedAt,
                  }
                : task,
            ),
          );
          setUsage({ input: 312, output: 168, cached: 0 });
          setUsageResolved(true);
          if (requestStartedRef.current)
            setDurationMs(completedAt - requestStartedRef.current);
        }
      }, 45);
      return;
    }
    const id = uid();
    requestTasksRef.current.set(id, taskId);
    taskRuntimeStore.start(taskId, id, requestStartedAt);
    const assistantMessage: ChatMessage = {
      id: `assistant:${id}`,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      model: target.model.displayName,
    };
    const insertAssistant = (all: ChatMessage[]) => {
      if (!queuedMessage) return [...all, assistantMessage];
      const userIndex = all.findIndex((message) => message.id === user.id);
      if (userIndex < 0) return [...all, assistantMessage];
      return [
        ...all.slice(0, userIndex + 1),
        assistantMessage,
        ...all.slice(userIndex + 1),
      ];
    };
    const stillActive = isTaskViewCurrent(
      activeTaskIdRef.current,
      displayedTaskIdRef.current,
      taskId,
    );
    if (stillActive) {
      currentRequest.current = id;
      setRunningId(id);
      setMessages(insertAssistant);
    }
    setTasks((all) =>
      all.map((task) =>
        task.id === taskId
          ? {
              ...task,
              messages: insertAssistant(visibleMessages),
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
    try {
      await window.kcode.chat.start({
        requestId: id,
        taskId,
        connectionSessionId: requestTask.remoteWorkspace ? taskId : undefined,
        providerId: target.provider.id,
        modelId: target.model.modelId,
        messages: history,
        reasoningEffort: requestReasoningEffort,
        permissionMode,
        permissionPolicy,
        workspacePath: requestTask.workspacePath,
        remoteWorkspace: requestTask.remoteWorkspace,
        contextWindow: requestContextWindow,
        agentRole: collaboration ? "planner" : undefined,
        collaboration,
        recoveryContext: interruptedRecoveryContext,
      });
    } catch (error) {
      taskRuntimeStore.finish(taskId, id);
      const detail = errorMessage(error);
      const failure = detail
        ? `生成失败：模型请求未能启动。${detail}`
        : "生成失败：模型请求未能启动，请稍后重试或切换模型/供应商。";
      const completedAt = Date.now();
      const markFailed = (all: ChatMessage[]) =>
        all.map((message) =>
          message.id === assistantMessage.id
            ? { ...message, error: failure, completedAt }
            : message,
        );
      const elapsed = completedAt - requestStartedAt;
      if (taskIsCurrent()) {
        setMessages(markFailed);
        currentRequest.current = undefined;
        setRunningId(undefined);
        setDurationMs(elapsed);
        setUsageResolved(true);
      }
      setTasks((all) =>
        all.map((task) =>
          task.id === taskId
            ? {
                ...task,
                messages: markFailed(task.messages),
                runningId: undefined,
                runStatus: "failed",
                durationMs: elapsed,
                usageResolved: true,
                pendingTokenEstimate: undefined,
                pendingCalibrationKey: undefined,
                updatedAt: completedAt,
              }
            : task,
        ),
      );
      requestTasksRef.current.delete(id);
      if (taskIsCurrent()) scrollAfterSendRef.current = true;
      return;
    }
  }

  sendRef.current = send;
  queuedSendRef.current = async (taskId: string, messageId: string) => {
    await send(undefined, messageId, taskId);
  };
  useEffect(() => {
    const startQueued = queuedSendRef.current;
    if (!startQueued || !models.length) return;
    for (const task of tasks) {
      const messageId = nextQueuedMessageId(task);
      if (
        !messageId ||
        messageId === editingQueuedMessageId ||
        summarizingTasks.has(task.id) ||
        startingQueuedRef.current.has(task.id)
      )
        continue;
      startingQueuedRef.current.add(task.id);
      void startQueued(task.id, messageId).finally(() => {
        startingQueuedRef.current.delete(task.id);
      });
    }
  }, [editingQueuedMessageId, models, summarizingTasks, tasks]);

  async function triggerScheduledTask(schedule: ScheduledTask) {
    if (scheduledRunsRef.current.has(schedule.id)) return;
    scheduledRunsRef.current.add(schedule.id);
    const updateSchedule = async (patch: Partial<ScheduledTask>) => {
      const next = scheduledTasksRef.current.map((item) =>
        item.id === schedule.id ? { ...item, ...patch } : item,
      );
      scheduledTasksRef.current = next;
      setScheduledTasks(next);
      await window.kcode?.state.save("scheduledTasks", next);
    };
    try {
      const selection =
        schedule.modelSelection &&
        models.some(
          (item) =>
            `${item.provider.id}|${item.model.id}` === schedule.modelSelection,
        )
          ? schedule.modelSelection
          : models.some(
                (item) => `${item.provider.id}|${item.model.id}` === selected,
              )
            ? selected
            : models[0]
              ? `${models[0].provider.id}|${models[0].model.id}`
              : "";
      if (!selection) throw new Error("没有可用模型");
      let task = tasksRef.current.find(
        (item) => item.scheduledTaskId === schedule.id,
      );
      if (task?.runningId || task?.runStatus === "running")
        throw new Error("上一次定时运行尚未完成");
      if (!task) {
        const now = Date.now();
        task = {
          id: uid(),
          name: schedule.name,
          workspaceName: workspaceNameFromPath(schedule.workspacePath),
          workspacePath: schedule.workspacePath,
          createdAt: now,
          updatedAt: now,
          messages: [],
          activities: [],
          modelSelection: selection,
          reasoningEffort: schedule.reasoningEffort ?? defaultReasoningEffort,
          runStatus: "idle",
          scheduledTaskId: schedule.id,
        };
        hydratedTaskIdsRef.current.add(task.id);
        const nextTasks = [task, ...tasksRef.current];
        tasksRef.current = nextTasks;
        setTasks(nextTasks);
      } else if (task.modelSelection !== selection) {
        task = { ...task, modelSelection: selection };
        const nextTasks = tasksRef.current.map((item) =>
          item.id === task!.id ? task! : item,
        );
        tasksRef.current = nextTasks;
        setTasks(nextTasks);
      }
      const message: QueuedChatMessage = {
        id: uid(),
        role: "user",
        content: schedule.prompt,
        createdAt: Date.now(),
        queued: true,
      };
      contextByMessageRef.current.set(message.id, []);
      const nextTask = {
        ...task,
        messages: [...task.messages, message],
        updatedAt: Date.now(),
      };
      const nextTasks = tasksRef.current.map((item) =>
        item.id === nextTask.id ? nextTask : item,
      );
      tasksRef.current = nextTasks;
      setTasks(nextTasks);
      startingQueuedRef.current.add(nextTask.id);
      try {
        await send(undefined, message.id, nextTask.id);
      } finally {
        startingQueuedRef.current.delete(nextTask.id);
      }
      await updateSchedule({ lastRunAt: Date.now(), lastError: undefined });
    } catch (error) {
      await updateSchedule({
        lastRunAt: Date.now(),
        lastError: errorMessage(error),
      });
    } finally {
      scheduledRunsRef.current.delete(schedule.id);
    }
  }

  useEffect(() => {
    if (!taskStorageReady || !models.length || !window.kcode?.state) return;
    const tick = () => {
      const now = Date.now();
      const due = scheduledTasksRef.current.filter(
        (item) => item.enabled && item.nextRunAt <= now,
      );
      if (!due.length) return;
      const ids = new Set(due.map((item) => item.id));
      const next = scheduledTasksRef.current.map((item) =>
        ids.has(item.id)
          ? {
              ...item,
              nextRunAt:
                now + Math.max(1, item.intervalMinutes) * 60_000,
            }
          : item,
      );
      scheduledTasksRef.current = next;
      setScheduledTasks(next);
      void window.kcode.state.save("scheduledTasks", next);
      for (const item of due) void triggerScheduledTask(item);
    };
    tick();
    const timer = window.setInterval(tick, 15_000);
    return () => window.clearInterval(timer);
  }, [models, taskStorageReady]);
  async function cancel() {
    if (runningId) {
      const requestId = runningId;
      if (window.kcode) await window.kcode.chat.cancel(requestId);
      if (textFlushTimerRef.current) {
        window.clearTimeout(textFlushTimerRef.current);
        textFlushTimerRef.current = undefined;
      }
      flushPendingText(true);
      flushRemoteStreamSync(requestId);
      const partialText = consumeStreamingText(requestId, {
        emitReset: false,
      });
      const completedAt = Date.now();
      const stopActivities = (all: AgentActivity[]) =>
        all.map((activity) =>
          activity.requestId === requestId &&
          (activity.status === "running" || activity.status === "waiting")
            ? {
                ...activity,
                status: "failed" as const,
                completedAt,
                errorSummary: "操作已停止",
                output: activity.output
                  ? `${activity.output}\n\n操作已停止`
                  : "操作已停止",
              }
            : activity,
        );
      const stoppedActivities = stopActivities(
        activities.length ? activities : activeTask?.activities ?? [],
      );
      const pausedResult = completionResultFromActivities(
        stoppedActivities.filter(
          (activity) => activity.requestId === requestId,
        ),
        "本轮已停止，已有执行记录和实际改动已保留。",
      );
      const commitStoppedText = (all: ChatMessage[]) =>
        all.map((message) =>
          message.id === `assistant:${requestId}`
            ? {
                ...message,
                content: message.content + partialText,
                completionResult: pausedResult,
                completedAt,
              }
            : message,
        );
      setMessages(commitStoppedText);
      setTasks((all) =>
        all.map((task) =>
          task.id === activeTask?.id
            ? { ...task, messages: commitStoppedText(task.messages) }
            : task,
        ),
      );
      if (previewTimerRef.current)
        window.clearInterval(previewTimerRef.current);
      previewTimerRef.current = undefined;
      if (requestStartedRef.current)
        setDurationMs(completedAt - requestStartedRef.current);
      currentRequest.current = undefined;
      if (activeTask?.id) taskRuntimeStore.finish(activeTask.id, requestId);
      setRunningId(undefined);
      clearPendingReasoning(requestId);
      clearStreamingProgress(requestId);
      setActivities(stoppedActivities);
      if (activeTask?.id)
        setTasks((all) =>
          all.map((task) =>
            task.id === activeTask.id
              ? {
                  ...task,
                  activities: stopActivities(task.activities),
                  runningId: undefined,
                  runStatus: "cancelled",
                  runtimeStatus: "interrupted",
                  updatedAt: completedAt,
                }
              : task,
          ),
        );
      requestTasksRef.current.delete(requestId);
    }
  }

  remoteCommandHandlerRef.current = (envelope) => {
    void (async () => {
      try {
        const command = envelope.command;
        const current = tasksRef.current.find(
          (task) => task.id === command.taskId,
        );
        if (!current) throw new Error("手机选择的任务已不存在");
        const task = await ensureTaskLoaded(current);
        if (command.type === "task.load") {
          await window.kcode.remote.syncTasks(
            tasksRef.current
              .map((item) => (item.id === task.id ? task : item))
              .map(remoteTaskSnapshot),
          );
          if (task.runningId) flushRemoteStreamSync(task.runningId);
        } else if (command.type === "task.send") {
          const messageId = command.clientMessageId || uid();
          const alreadyQueued = tasksRef.current.some(
            (item) =>
              item.id === task.id &&
              item.messages.some((message) => message.id === messageId),
          );
          if (alreadyQueued) {
            await window.kcode.remote.syncTasks(
              tasksRef.current.map(remoteTaskSnapshot),
            );
            await window.kcode.remote.commandResult(envelope.id, true);
            return;
          }
          const { images, files } = materializeRemoteAttachments(
            command.attachments,
          );
          const content = remoteAttachmentPrompt(
            command.content,
            images.length,
            files.length,
          );
          const user: QueuedChatMessage = {
            id: messageId,
            role: "user",
            content,
            createdAt: Date.now(),
            images: images.length ? images : undefined,
            contextAttachments: files.length
              ? files.map(({ name, size }) => ({ name, size }))
              : undefined,
            queued: true,
          };
          contextByMessageRef.current.set(user.id, files);
          const nextTasks = tasksRef.current.map((item) =>
            item.id === task.id
              ? {
                  ...item,
                  messages: [...item.messages, user],
                  updatedAt: Date.now(),
                }
              : item,
          );
          tasksRef.current = nextTasks;
          setTasks(nextTasks);
          if (displayedTaskIdRef.current === task.id)
            setMessages((all) =>
              all.some((message) => message.id === user.id)
                ? all
                : [...all, user],
            );
        } else if (command.type === "task.cancel") {
          if (!task.runningId) throw new Error("任务当前没有在运行");
          if (
            displayedTaskIdRef.current === task.id &&
            currentRequest.current === task.runningId
          )
            await cancel();
          else {
            await window.kcode.chat.cancel(task.runningId);
            const completedAt = Date.now();
            const requestId = task.runningId;
            const stoppedActivities = task.activities.map((activity) =>
              activity.requestId === requestId &&
              (activity.status === "running" || activity.status === "waiting")
                ? {
                    ...activity,
                    status: "failed" as const,
                    completedAt,
                    errorSummary: "操作已从手机停止",
                    output: activity.output
                      ? `${activity.output}\n\n操作已从手机停止`
                      : "操作已从手机停止",
                  }
                : activity,
            );
            const pausedResult = completionResultFromActivities(
              stoppedActivities.filter(
                (activity) => activity.requestId === requestId,
              ),
              "本轮已从手机停止，已有执行记录和实际改动已保留。",
            );
            taskRuntimeStore.finish(task.id, task.runningId);
            setTasks((all) =>
              all.map((item) =>
                item.id === task.id
                  ? {
                      ...item,
                      runningId: undefined,
                      runStatus: "cancelled",
                      runtimeStatus: "interrupted",
                      updatedAt: completedAt,
                      messages: item.messages.map((message) =>
                        message.id === `assistant:${requestId}`
                          ? {
                              ...message,
                              completionResult: pausedResult,
                              completedAt,
                            }
                          : message,
                      ),
                      activities: stoppedActivities,
                    }
                  : item,
              ),
            );
          }
        } else if (command.type === "task.approve") {
          await window.kcode.chat.approve(
            command.requestId,
            command.activityId,
            command.allowed,
          );
        }
        await window.kcode.remote.commandResult(envelope.id, true);
      } catch (error) {
        await window.kcode?.remote?.commandResult(
          envelope.id,
          false,
          errorMessage(error),
        );
      }
    })();
  };

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
      connectionSessionId: task.remoteWorkspace ? taskId : undefined,
      messages: task.messages.map(({ role, content, images }) => ({
        role,
        content,
        images,
      })),
      permissionMode,
      permissionPolicy,
      contextWindow: selectedContextWindow,
      remoteWorkspace: task.remoteWorkspace,
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

  const selectedTarget = useMemo(
    () =>
      models.find(
        (item) => `${item.provider.id}|${item.model.id}` === selected,
      ),
    [models, selected],
  );
  const collaborationExecutorTarget = useMemo(
    () =>
      models.find(
        (item) =>
          `${item.provider.id}|${item.model.id}` ===
          activeTask?.collaboration?.executorModelSelection,
      ),
    [activeTask?.collaboration?.executorModelSelection, models],
  );
  const selectedContextWindow = resolveModelContextWindow(
    selectedTarget?.model.modelId || "",
    selectedTarget?.model.contextWindow,
  );
  const selectedCalibrationKey = selectedTarget
    ? `${selectedTarget.provider.id}|${selectedTarget.model.modelId}`
    : "";
  const calibrationFactor = tokenCalibration[selectedCalibrationKey] ?? 1;
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
          message.role === "user" && Boolean((message as QueuedChatMessage).queued),
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

  composerSubmitRef.current = () => {
    if (runningId) queueMessage();
    else void send();
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
        <Sidebar
          workspaceGroups={workspaceGroups}
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
          forkTask={onForkSidebarTask}
          assignLocalWorkspace={onAssignSidebarLocalWorkspace}
          setDeleteTarget={onSetSidebarDeleteTarget}
          openSettings={onOpenSettings}
          closeSidebar={closeSidebar}
          startSidebarResize={onStartSidebarResize}
        />
        <main
          className={`main ${workspaceView === "editor" ? "workspace-editor-mode" : ""} ${workspaceView === "editor" && activeTask?.remoteWorkspace ? "remote-editor-mode" : ""}`}
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
            editorAvailable={Boolean(activeTask?.workspacePath)}
            workspaceView={workspaceView}
            setWorkspaceView={onWorkspaceViewChange}
            forkTask={() => void forkTask()}
            exportTask={(format) => void exportActiveTask(format)}
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
            activeTask?.workspacePath &&
            !activeTask.remoteWorkspace && (
              <Suspense
                fallback={
                  <div className="ssh-editor-loading">
                    <LoaderCircle className="spinning" size={18} />
                  </div>
                }
              >
                <LocalWorkspaceEditor
                  key={`${activeTask.id}:${activeTask.workspacePath}`}
                  taskId={activeTask.id}
                  root={activeTask.workspacePath}
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
            handleConversationScroll={handleConversationScroll}
            handleConversationWheel={handleConversationWheel}
            interruptBottomSettle={interruptBottomSettle}
            conversationTurns={conversationTurns}
            turnRailRef={turnRailRef}
            turnRailOverflow={turnRailOverflow}
            updateTurnRailOverflow={updateTurnRailOverflow}
            turnButtonRefs={turnButtonRefs}
            activeConversationTurnRef={activeConversationTurnRef}
            scrollToTurn={scrollToTurn}
            messages={visibleMessages}
            hasOlderMessages={hasOlderMessages}
            olderMessagesLoading={historyLoadingTaskId === activeTaskId}
            hasNewerMessages={hasNewerMessages}
            models={models}
            writeInput={setInput}
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
            agentReasoning=""
          />
          {activeTask && !activeTask.workspacePath && !activeTask.remoteWorkspace && (
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
                    <span><ListOrdered size={14} /> 发送队列</span>
                    <small>{queuedMessages.length} 条</small>
                  </header>
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
                  <CollaborationPicker
                    providers={providers}
                    plannerSelection={selected}
                    value={activeTask?.collaboration}
                    disabled={Boolean(runningId) || summaryBusy}
                    onChange={selectCollaboration}
                  />
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
                      title={
                        activeTask?.collaboration
                          ? "规划模型推理强度"
                          : "推理强度"
                      }
                      onClick={() => setEffortMenuOpen((open) => !open)}
                    >
                      <BrainCircuit size={14} />
                      <span>
                        {activeTask?.collaboration
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
                          activeTask?.collaboration
                            ? "规划模型推理强度"
                            : "推理强度"
                        }
                      >
                        <header>
                          {activeTask?.collaboration
                            ? "规划模型推理强度"
                            : "推理强度"}
                        </header>
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
                  <PermissionPicker
                    mode={permissionMode}
                    policy={permissionPolicy}
                    disabled={summaryBusy}
                    onChange={updatePermissionMode}
                  />
                </div>
                <div className="composer-right">
                  {(usage.input > 0 || usage.output > 0) && (
                    <span className="usage">
                      {usage.input + usage.output} tokens
                    </span>
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
                          ? "加入发送队列"
                          : "发送"
                    }
                  >
                    <Send size={17} />
                  </button>
                </div>
              </div>
            </div>
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
              onClose={() => setSettings(false)}
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
