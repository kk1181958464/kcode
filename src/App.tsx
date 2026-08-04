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
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
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
  GripVertical,
  LockOpen,
  LoaderCircle,
  Monitor,
  Minus,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
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
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import appLogo from "../build/icon.png";
import { inferContextWindow, inferReasoningConfig } from "./types";
import type {
  RemoteCommandEnvelope,
  RemoteControlState,
  RemoteTaskStreamEvent,
} from "./remote-types";
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
  compactConversation,
  estimateMessageTokens,
  estimateTextTokens,
} from "./context";
import type { ContextLedger } from "./context";
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
  MAX_IMAGE_FILES,
  MAX_IMAGE_FILE_BYTES,
  imageMediaType,
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
import { DeleteDialog, NewTaskDialog } from "./components/dialogs/TaskDialogs";
import { BrowserPanel } from "./components/browser/BrowserPanel";
import { TitleBar } from "./components/chrome/TitleBar";
import { TopBar } from "./components/topbar/TopBar";
import { Sidebar } from "./components/sidebar/Sidebar";
import { StatusPanel } from "./components/status/StatusPanel";
import {
  COMPOSER_STREAM_PAUSE_MS,
  STREAM_PACING_INTERVAL_MS,
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
import {
  appendActivityOutput,
  replaceActivityOutput,
  resetActivityOutput,
} from "./activity-output-store";
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
} from "./types";

function estimateRequestContextTokens({
  messages,
  compactedMessageCount,
  contextSummary,
  attachmentTokens,
  outputReserve,
  calibrationFactor,
}: {
  messages: ChatMessage[];
  compactedMessageCount: number;
  contextSummary?: string;
  attachmentTokens: number;
  outputReserve: number;
  calibrationFactor: number;
}) {
  return Math.ceil(
    (AGENT_STATIC_TOKENS +
      attachmentTokens +
      outputReserve +
      estimateMessageTokens(messages.slice(compactedMessageCount)) +
      estimateTextTokens(contextSummary ?? "")) *
      calibrationFactor,
  );
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
  const composerRef = useRef<ComposerTextareaHandle>(null);
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
  const [statusOpen, setStatusOpen] = useState(
    () => localStorage.getItem("kcode.statusPanel") !== "false",
  );
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
  const [remoteControlState, setRemoteControlState] =
    useState<RemoteControlState>(() => ({
      configured: false,
      enabled: false,
      connected: false,
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
  const hydratedTaskIdsRef = useRef(new Set(tasks.map((task) => task.id)));
  const persistedTaskRefsRef = useRef(new Map<string, TaskRecord>());
  const persistedTaskOrderRef = useRef("");
  const taskSwitchSequenceRef = useRef(0);
  const sidebarProjectionRef = useRef<SidebarProjection | undefined>(undefined);
  const previewTimerRef = useRef<number | undefined>(undefined);
  const followFrameRef = useRef<number | undefined>(undefined);
  const bottomLayoutFrameRef = useRef<number | undefined>(undefined);
  const bottomFollowTimerRef = useRef<number | undefined>(undefined);
  const lastBottomFollowAtRef = useRef(0);
  const bottomSettleTimerRef = useRef<number | undefined>(undefined);
  const bottomSettleDeadlineRef = useRef(0);
  const bottomIndicatorUntilRef = useRef(0);
  const bottomSettlePassesRef = useRef(0);
  const pendingLatestScrollRef = useRef<ScrollBehavior | undefined>(undefined);
  const scrollFrameRef = useRef<number | undefined>(undefined);
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
  const claimTaskView = (taskId: string) => {
    activeTaskIdRef.current = taskId;
    displayedTaskIdRef.current = taskId;
  };
  const activeTask = useMemo(
    () => tasks.find((task) => task.id === activeTaskId) ?? tasks[0],
    [tasks, activeTaskId],
  );
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
        if (Array.isArray(storedHeaders) && storedHeaders.length) {
          const headers = (storedHeaders as TaskRecord[]).map((task) =>
            normalizeStoredTask({ ...task, messages: [], activities: [] }),
          );
          const selectedHeader =
            headers.find(
              (task) => task.id === localStorage.getItem("kcode.activeTaskId"),
            ) ?? headers[0];
          const storedTask = selectedHeader
            ? await window.kcode.state.loadTask(selectedHeader.id)
            : null;
          if (cancelled) return;
          const selectedTask = storedTask
            ? normalizeStoredTask(storedTask as TaskRecord)
            : selectedHeader;
          const loaded = headers.map((task) =>
            task.id === selectedTask?.id ? selectedTask : task,
          );
          hydratedTaskIdsRef.current = new Set(
            selectedTask ? [selectedTask.id] : [],
          );
          persistedTaskRefsRef.current = new Map(
            selectedTask ? [[selectedTask.id, selectedTask]] : [],
          );
          persistedTaskOrderRef.current = JSON.stringify(
            loaded.map((task) => task.id),
          );
          claimTaskView(selectedTask?.id ?? "");
          setTasks(loaded);
          setActiveTaskId(selectedTask?.id ?? "");
          setMessages(selectedTask?.messages ?? []);
          setActivities(selectedTask?.activities ?? []);
          setInput(initialDrafts.current[selectedTask?.id ?? ""] ?? "");
          setRunningId(undefined);
          currentRequest.current = undefined;
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
    [activeTaskId, messages.length, runningId],
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
    !conversationSearchOpen && visibleTurnWindow.start > 0;
  const hasNewerMessages =
    !conversationSearchOpen && visibleTurnWindow.end < conversationTurns.length;
  const activitiesByRequest = useMemo(() => {
    const visibleRequests = new Set(
      visibleMessages
        .filter((message) => message.id.startsWith("assistant:"))
        .map((message) => message.id.slice("assistant:".length)),
    );
    const grouped = new Map<string, AgentActivity[]>();
    for (const activity of activities) {
      if (!visibleRequests.has(activity.requestId)) continue;
      const group = grouped.get(activity.requestId);
      if (group) group.push(activity);
      else grouped.set(activity.requestId, [activity]);
    }
    return grouped;
  }, [activities, visibleMessages]);
  const handleActivityChange = useCallback((next: AgentActivity) => {
    setActivities((all) =>
      all.map((item) => (item.id === next.id ? next : item)),
    );
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
      if (bottomFollowTimerRef.current !== undefined) return;
      const elapsed = performance.now() - lastBottomFollowAtRef.current;
      const delay = Math.max(0, 50 - elapsed);
      bottomFollowTimerRef.current = window.setTimeout(() => {
        bottomFollowTimerRef.current = undefined;
        lastBottomFollowAtRef.current = performance.now();
        if (
          !autoFollowRef.current &&
          !pendingScrollRestoreRef.current?.state.atBottom
        )
          return;
        if (bottomLayoutFrameRef.current) return;
        bottomLayoutFrameRef.current = requestAnimationFrame(() => {
          bottomLayoutFrameRef.current = undefined;
          const current = conversationRef.current;
          if (
            !current ||
            current !== conversation ||
            (!autoFollowRef.current &&
              !pendingScrollRestoreRef.current?.state.atBottom)
          )
            return;
          // Keep bottom following while the user is at the bottom, but do not
          // update React state or mark the scroll as programmatic here. This
          // path runs during streaming and must stay out of the input hot path.
          current.scrollTop = current.scrollHeight;
          const taskId = displayedTaskIdRef.current;
          if (taskId)
            scrollStateByTaskRef.current.set(taskId, {
              top: current.scrollHeight,
              atBottom: true,
            });
        });
      }, delay);
    };
    const observer = new ResizeObserver(() => {
      const pending = pendingScrollRestoreRef.current;
      if (!autoFollowRef.current && !pending?.state.atBottom) return;
      queueBottomFollow();
    });
    observer.observe(messageList);
    return () => {
      observer.disconnect();
      if (bottomFollowTimerRef.current !== undefined) {
        window.clearTimeout(bottomFollowTimerRef.current);
        bottomFollowTimerRef.current = undefined;
      }
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
        visibleTurnWindow.start > 0 &&
        !loadingOlderTurnsRef.current
      ) {
        loadingOlderTurnsRef.current = true;
        preserveWindowAnchor(visibleTurnWindow.start);
        setVisibleTurnWindow((current) =>
          prependConversationWindow(current, conversationPageSize),
        );
        return;
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
      const taskId = displayedTaskIdRef.current;
      if (taskId)
        scrollStateByTaskRef.current.set(taskId, {
          top: scrollTop,
          atBottom,
        });
      if (autoFollowRef.current !== atBottom) {
        autoFollowRef.current = atBottom;
        setShowScrollToBottom(!atBottom);
        if (!atBottom) refreshTurnPositions();
      }
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
      current.scrollTop = current.scrollHeight;
    });
    setActiveConversationTurn(conversationTurns.at(-1)?.id);
  }

  function interruptBottomSettle() {
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
      const atBottom = isConversationAtBottom(conversation, hasNewerMessages);
      autoFollowRef.current = atBottom;
      setShowScrollToBottom(!atBottom);
    }
    if (bottomLayoutFrameRef.current) {
      cancelAnimationFrame(bottomLayoutFrameRef.current);
      bottomLayoutFrameRef.current = undefined;
    }
  }

  function scrollToTurn(turnId: string, index: number) {
    if (index === conversationTurns.length - 1) return scrollToLatest("auto");
    const conversation = conversationRef.current;
    const element = turnRefs.current.get(turnId);
    if (!conversation) return;
    interruptBottomSettle();
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
    const projection = projectSidebarWorkspaceGroups(
      tasks,
      taskQuery,
      showArchived,
      sidebarProjectionRef.current,
    );
    sidebarProjectionRef.current = projection;
    return projection.workspaceGroups;
  }, [tasks, taskQuery, showArchived]);

  async function refreshGitState(includeDiff = gitDiffOpen) {
    if (!window.kcode?.workspace.gitState || !activeTask?.workspacePath) return;
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
        ["write_file", "apply_patch", "move_path", "delete_path"].includes(
          activity.tool,
        )
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
        ...dirty.map((task) => window.kcode.state.saveTask(task.id, task)),
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
    document.body.classList.add("resizing-sidebar");
    const move = (moveEvent: PointerEvent) => {
      const width = Math.min(
        420,
        Math.max(210, startWidth + moveEvent.clientX - startX),
      );
      appShellRef.current?.style.setProperty("--sidebar-width", `${width}px`);
    };
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
    let frame: number | undefined;
    let pendingWidth = startWidth;
    const move = (moveEvent: PointerEvent) => {
      const width = widthAt(moveEvent.clientX);
      pendingWidth = width;
      appShellRef.current?.style.setProperty("--browser-width", `${width}px`);
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        void window.kcode?.browser?.setWidth(pendingWidth);
      });
    };
    const stop = (upEvent: PointerEvent) => {
      const width = widthAt(upEvent.clientX);
      if (frame !== undefined) cancelAnimationFrame(frame);
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

  function reorderWorkspace(
    sourcePath: string | undefined,
    targetPath: string,
  ) {
    if (!sourcePath || sourcePath === targetPath) return;
    setTasks((current) => {
      const paths = [...new Set(current.map((task) => task.workspacePath))];
      const from = paths.indexOf(sourcePath),
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
    removed.forEach((task) => {
      attachmentDraftsRef.current.delete(task.id);
      hydratedTaskIdsRef.current.delete(task.id);
      persistedTaskRefsRef.current.delete(task.id);
      scrollStateByTaskRef.current.delete(task.id);
      conversationWindowByTaskRef.current.delete(task.id);
    });
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
      await Promise.all(
        removed.map((task) => window.kcode.state.deleteTask(task.id)),
      );
    }
    const nextTasks = tasks.filter(
      (task) => task.workspacePath !== workspacePath,
    );
    setTasks(nextTasks);
    if (activeTask?.workspacePath === workspacePath) {
      const next = nextTasks[0];
      if (next) {
        const loadedNext = await ensureTaskLoaded(next);
        const attachmentDraft = attachmentDraftsRef.current.get(loadedNext.id);
        claimTaskView(loadedNext.id);
        setActiveTaskId(loadedNext.id);
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
  const models = useMemo(
    () =>
      providers
        .filter((p) => p.enabled)
        .flatMap((p) => p.models.map((m) => ({ provider: p, model: m }))),
    [providers],
  );
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
    const event: RemoteTaskStreamEvent = {
      type: "task.event",
      event: "stream",
      taskId,
      requestId,
      content: getStreamingText(requestId).slice(-96_000),
      reasoning: getStreamingText(streamingReasoningKey(requestId)).slice(
        -8_000,
      ),
      progress: getStreamingText(streamingProgressKey(requestId)).slice(-1_000),
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
        now - bufferedSince >= STREAM_PACING_INTERVAL_MS * 2,
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
        const taskId = requestTasksRef.current.get(id);
        if (!taskId) return;
        const isActive = isTaskViewCurrent(
          activeTaskIdRef.current,
          displayedTaskIdRef.current,
          taskId,
        );
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
          event.type !== "reasoning" &&
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
            };
            return next;
          });
        if (event.type === "activity") {
          flushPendingText(true);
          const settledText = consumeStreamingText(id);
          const settleMessages = (all: ChatMessage[]) =>
            settledText
              ? all.map((message) =>
                  message.id === `assistant:${id}`
                    ? { ...message, content: message.content + settledText }
                    : message,
                )
              : all;
          resetActivityOutput(event.activity.id);
          const updateActivities = (all: AgentActivity[]) => {
            const exists = all.some((item) => item.id === event.activity.id);
            return exists
              ? all.map((item) =>
                  item.id === event.activity.id ? event.activity : item,
                )
              : [...all, event.activity];
          };
          startTransition(() => {
            setTasks((all) =>
              all.map((task) =>
                task.id === taskId
                  ? {
                      ...task,
                      messages: settleMessages(task.messages),
                      activities: updateActivities(task.activities),
                      updatedAt: Date.now(),
                    }
                  : task,
              ),
            );
            if (isActive) {
              if (settledText) setMessages(settleMessages);
              setActivities(updateActivities);
            }
          });
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
        if (event.type === "text_reset") {
          // Upstream broke mid-answer and the agent is retrying: discard the
          // partial text we streamed so far, both buffered and already
          // committed, so the retry renders a clean, non-duplicated answer.
          pendingTextRef.current.delete(id);
          pendingTextSinceRef.current.delete(id);
          resetStreamingText(id);
          scheduleRemoteStreamSync(id);
          return;
        }
        if (event.type === "text") {
          clearStreamingProgress(id);
          clearPendingReasoning(id);
          if (!isActive) {
            appendStreamingText(id, event.delta);
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
          clearStreamingProgress(id);
          clearPendingReasoning(id);
          if (textFlushTimerRef.current) {
            window.clearTimeout(textFlushTimerRef.current);
            textFlushTimerRef.current = undefined;
          }
          flushPendingText(true);
          flushRemoteStreamSync(id);
          const finalText = consumeStreamingText(id);
          const commitFinalText = (all: ChatMessage[]) =>
            all.map((message) =>
              message.id === `assistant:${id}`
                ? {
                    ...message,
                    content: message.content + finalText,
                    error: event.message,
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
                      task.runStatus === "cancelled" ? "cancelled" : "failed",
                    ),
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
        }
        if (event.type === "done") {
          const finishedStatus =
            event.outcome === "blocked" ? "blocked" : "completed";
          clearStreamingProgress(id);
          clearPendingReasoning(id);
          if (textFlushTimerRef.current) {
            window.clearTimeout(textFlushTimerRef.current);
            textFlushTimerRef.current = undefined;
          }
          flushPendingText(true);
          flushRemoteStreamSync(id);
          const finalText = consumeStreamingText(id);
          const commitFinalText = (all: ChatMessage[]) =>
            all.map((message) =>
              message.id === `assistant:${id}`
                ? { ...message, content: message.content + finalText }
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
          if (isActive && currentRequest.current === id) {
            currentRequest.current = undefined;
            setRunningId(undefined);
            setUsageResolved(true);
          }
          requestTasksRef.current.delete(id);
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
        programmaticScrollRef.current = true;
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
      setContextError(errorMessage(error));
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
    setPendingFolder(null);
    setNewTaskName("");
  }

  async function ensureTaskLoaded(task: TaskRecord) {
    if (hydratedTaskIdsRef.current.has(task.id) || !window.kcode?.state)
      return task;
    const stored = await window.kcode.state.loadTask(task.id);
    if (!stored) throw new Error(`找不到任务记录：${task.name}`);
    const loaded = normalizeStoredTask(stored as TaskRecord);
    hydratedTaskIdsRef.current.add(task.id);
    persistedTaskRefsRef.current.set(task.id, loaded);
    setTasks((current) =>
      current.map((item) => (item.id === loaded.id ? loaded : item)),
    );
    return loaded;
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
      collaboration: activeTask?.collaboration,
      reasoningEffort,
    };
    hydratedTaskIdsRef.current.add(task.id);
    setTasks((all) => {
      const workspaceIndex = all.findIndex(
        (item) => item.workspacePath === workspacePath,
      );
      if (workspaceIndex < 0) return [task, ...all];
      const next = [...all];
      next.splice(workspaceIndex, 0, task);
      return next;
    });
    claimTaskView(task.id);
    setActiveTaskId(task.id);
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
  }

  async function removeTask(task: TaskRecord) {
    delete initialDrafts.current[task.id];
    attachmentDraftsRef.current.delete(task.id);
    hydratedTaskIdsRef.current.delete(task.id);
    persistedTaskRefsRef.current.delete(task.id);
    scrollStateByTaskRef.current.delete(task.id);
    conversationWindowByTaskRef.current.delete(task.id);
    localStorage.setItem(
      "kcode.taskDrafts",
      JSON.stringify(initialDrafts.current),
    );
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
      await window.kcode.state.deleteTask(task.id);
    }
    const nextTasks = tasks.filter((item) => item.id !== task.id);
    setTasks(nextTasks);
    if (task.id === activeTaskId) {
      const next = nextTasks[0];
      if (next) {
        const loadedNext = await ensureTaskLoaded(next);
        const attachmentDraft = attachmentDraftsRef.current.get(loadedNext.id);
        claimTaskView(loadedNext.id);
        setActiveTaskId(loadedNext.id);
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
      if (file.size > MAX_CONTEXT_FILE_BYTES) {
        errors.push(`${file.name} 超过 512 KB，无法作为上下文添加`);
        continue;
      }
      eligible.push({ file, path });
    }
    const selectedFiles = eligible.slice(0, MAX_CONTEXT_FILES);
    const settled = await Promise.allSettled(
      selectedFiles.map(async ({ file, path }): Promise<ContextFile> => {
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
    const compacted = compactConversation(
      activeTask,
      selectedContextWindow,
      true,
    );
    if (!compacted) {
      setContextError("当前对话较短，保留最近一轮后暂无可压缩内容");
      return;
    }
    const beforeTokens = localContextTokens;
    setSummarizingTasks((current) => new Set(current).add(activeTask.id));
    let finalCompacted = compacted;
    try {
      finalCompacted = await improveSummaryWithModel(activeTask, compacted);
    } finally {
      setSummarizingTasks((current) => {
        const next = new Set(current);
        next.delete(activeTask.id);
        return next;
      });
    }
    setTasks((all) =>
      all.map((task) =>
        task.id === activeTask.id
          ? {
              ...task,
              ...finalCompacted,
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
    const afterTokens = estimateRequestContextTokens({
      messages,
      compactedMessageCount:
        finalCompacted.compactedMessageCount ?? compacted.compactedMessageCount,
      contextSummary: finalCompacted.contextSummary,
      attachmentTokens: 0,
      outputReserve: 0,
      calibrationFactor,
    });
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

  async function send(
    override?: string,
    queuedMessageId?: string,
    queuedTaskId?: string,
  ) {
    const requestTask = queuedTaskId
      ? tasksRef.current.find((task) => task.id === queuedTaskId)
      : activeTask;
    const taskId = requestTask?.id ?? "";
    const taskIsCurrent = () =>
      isTaskViewCurrent(
        activeTaskIdRef.current,
        displayedTaskIdRef.current,
        taskId,
      );
    const taskMessages = requestTask
      ? taskIsCurrent()
        ? messages
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
              "auto",
              reasoningEffortsForModel(executorTarget.model),
            ),
            contextWindow:
              executorTarget.model.contextWindow ??
              inferContextWindow(executorTarget.model.modelId),
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
    const interruptedAssistant =
      latestAssistant?.error && latestAssistant.content.trim()
        ? latestAssistant
        : undefined;
    const cleanMessages = sourceMessages.filter((message) => {
      if (message.role !== "assistant") return true;
      const legacyErrorOnly = message.content.startsWith("请求失败：");
      // Keep useful partial output from interrupted rounds in the next request.
      // Only discard assistant placeholders that contain no model output.
      return !(legacyErrorOnly || (message.error && !message.content.trim()));
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
    const requestContextWindow =
      target.model.contextWindow ?? inferContextWindow(target.model.modelId);
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
    const outputReserve = requestContextWindow
      ? Math.max(
          8_000,
          Math.floor(
            requestContextWindow *
              (requestEfforts.some((effort) => effort !== "auto")
                ? 0.18
                : 0.12),
          ),
        )
      : 8_000;
    const requestCalibrationKey = `${target.provider.id}|${target.model.modelId}`;
    const requestCalibrationFactor =
      tokenCalibration[requestCalibrationKey] ?? 1;
    let rawEstimatedTokens = estimateRequestContextTokens({
      messages: nextMessages,
      compactedMessageCount: compactedCount,
      contextSummary: requestSummary,
      attachmentTokens,
      outputReserve,
      calibrationFactor: 1,
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
            requestTaskWithSelection,
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
        rawEstimatedTokens = estimateRequestContextTokens({
          messages: nextMessages,
          compactedMessageCount: compactedCount,
          contextSummary: requestSummary,
          attachmentTokens,
          outputReserve,
          calibrationFactor: 1,
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
      const recoveryContext =
        interruptedAssistant && role === "user" && id === user.id
          ? "\n\n<interrupted_turn_recovery>上一轮因上游或模型错误中断。失败前已经生成的助手输出保留在历史中，工作区也可能已经发生修改。请从已有结果和当前工作区状态继续：先核对现状，再完成剩余步骤；不要从头重复已经完成的分析或修改，也不要假定尚未验证的步骤已经完成。</interrupted_turn_recovery>"
          : "";
      return {
        role,
        content: `${fileContext ? `${content}\n\n${fileContext}` : content}${recoveryContext}`,
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
          currentRequest.current = undefined;
          setRunningId(undefined);
          setTasks((all) =>
            all.map((task) =>
              task.id === taskId
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
    const id = uid();
    requestTasksRef.current.set(id, taskId);
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
        providerId: target.provider.id,
        modelId: target.model.modelId,
        messages: history,
        reasoningEffort: requestReasoningEffort,
        permissionMode,
        permissionPolicy,
        workspacePath: requestTask.workspacePath,
        contextWindow: requestContextWindow,
        agentRole: collaboration ? "planner" : undefined,
        collaboration,
      });
    } catch (error) {
      const detail = errorMessage(error);
      const failure = detail
        ? `生成失败：模型请求未能启动。${detail}`
        : "生成失败：模型请求未能启动，请稍后重试或切换模型/供应商。";
      const markFailed = (all: ChatMessage[]) =>
        all.map((message) =>
          message.id === assistantMessage.id
            ? { ...message, error: failure }
            : message,
        );
      const elapsed = Date.now() - requestStartedAt;
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
                updatedAt: Date.now(),
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
        summarizingTasks.has(task.id) ||
        startingQueuedRef.current.has(task.id)
      )
        continue;
      startingQueuedRef.current.add(task.id);
      void startQueued(task.id, messageId).finally(() => {
        startingQueuedRef.current.delete(task.id);
      });
    }
  }, [models, summarizingTasks, tasks]);
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
      const partialText = consumeStreamingText(requestId);
      if (partialText) {
        const commitPartialText = (all: ChatMessage[]) =>
          all.map((message) =>
            message.id === `assistant:${requestId}`
              ? { ...message, content: message.content + partialText }
              : message,
          );
        setMessages(commitPartialText);
        setTasks((all) =>
          all.map((task) =>
            task.id === activeTask?.id
              ? { ...task, messages: commitPartialText(task.messages) }
              : task,
          ),
        );
      }
      if (previewTimerRef.current)
        window.clearInterval(previewTimerRef.current);
      previewTimerRef.current = undefined;
      if (requestStartedRef.current)
        setDurationMs(Date.now() - requestStartedRef.current);
      currentRequest.current = undefined;
      setRunningId(undefined);
      clearPendingReasoning(requestId);
      clearStreamingProgress(requestId);
      const stopActivities = (all: AgentActivity[]) =>
        all.map((activity) =>
          activity.requestId === requestId &&
          (activity.status === "running" || activity.status === "waiting")
            ? {
                ...activity,
                status: "failed" as const,
                completedAt: Date.now(),
                errorSummary: "操作已停止",
                output: activity.output
                  ? `${activity.output}\n\n操作已停止`
                  : "操作已停止",
              }
            : activity,
        );
      setActivities(stopActivities);
      if (activeTask?.id)
        setTasks((all) =>
          all.map((task) =>
            task.id === activeTask.id
              ? {
                  ...task,
                  activities: stopActivities(task.activities),
                  runningId: undefined,
                  runStatus: "cancelled",
                  updatedAt: Date.now(),
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
            setTasks((all) =>
              all.map((item) =>
                item.id === task.id
                  ? {
                      ...item,
                      runningId: undefined,
                      runStatus: "cancelled",
                      updatedAt: completedAt,
                      activities: item.activities.map((activity) =>
                        activity.requestId === task.runningId &&
                        (activity.status === "running" ||
                          activity.status === "waiting")
                          ? {
                              ...activity,
                              status: "failed" as const,
                              completedAt,
                              errorSummary: "操作已从手机停止",
                            }
                          : activity,
                      ),
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
  const selectedContextWindow =
    selectedTarget?.model.contextWindow ??
    inferContextWindow(selectedTarget?.model.modelId || "");
  const selectedCalibrationKey = selectedTarget
    ? `${selectedTarget.provider.id}|${selectedTarget.model.modelId}`
    : "";
  const calibrationFactor = tokenCalibration[selectedCalibrationKey] ?? 1;
  const deferredMessages = useDeferredValue(messages);
  const localContextTokens = useMemo(
    () =>
      Math.ceil(
        (AGENT_STATIC_TOKENS +
          estimateTextTokens(activeTask?.contextSummary ?? "") +
          estimateMessageTokens(
            deferredMessages.slice(activeTask?.compactedMessageCount ?? 0),
          )) *
          calibrationFactor,
      ),
    [
      activeTask?.compactedMessageCount,
      activeTask?.contextSummary,
      calibrationFactor,
      deferredMessages,
    ],
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
  const lastUserMessage = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1)
      if (messages[index].role === "user") return messages[index];
    return undefined;
  }, [messages]);
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
  const onOpenSettings = useEventCallback(openSettings);
  const onStartSidebarResize = useEventCallback(startSidebarResize);
  const onUpdateStatusPanel = useEventCallback(updateStatusPanel);
  const onSetSidebarDeleteTarget = useEventCallback(
    (
      target:
        | { kind: "workspace"; path: string; name: string; count: number }
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
        className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"} ${statusOpen ? "" : "status-collapsed"} ${browserState.open ? "browser-open" : ""}`}
        style={
          {
            "--sidebar-width": `${sidebarWidth}px`,
            "--browser-width": `${browserState.width ?? 520}px`,
          } as React.CSSProperties
        }
      >
        <Sidebar
          workspaceGroups={workspaceGroups}
          activeTaskId={activeTask?.id}
          taskQuery={taskQuery}
          setTaskQuery={setTaskQuery}
          showArchived={showArchived}
          setShowArchived={setShowArchived}
          collapsedWorkspaces={collapsedWorkspaces}
          startNewTask={onStartNewTask}
          reorderWorkspace={onReorderWorkspace}
          reorderTask={onReorderTask}
          toggleWorkspace={onToggleWorkspace}
          createConversation={onCreateConversation}
          switchTask={onSwitchTask}
          toggleTaskArchived={onToggleTaskArchived}
          setDeleteTarget={onSetSidebarDeleteTarget}
          setContextError={setContextError}
          openSettings={onOpenSettings}
          startSidebarResize={onStartSidebarResize}
        />
        <main className="main">
          <TopBar
            taskName={activeTask?.name || "新任务"}
            sidebarOpen={sidebarOpen}
            setSidebarOpen={setSidebarOpen}
            statusOpen={statusOpen}
            updateStatusPanel={onUpdateStatusPanel}
            gitState={gitState}
          />
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
              className={`composer ${composerDragActive ? "drag-active" : ""}`}
              onDragEnter={handleComposerDragEnter}
              onDragOver={handleComposerDragOver}
              onDragLeave={handleComposerDragLeave}
              onDrop={(event) => void handleComposerDrop(event)}
            >
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
                    title={
                      effectiveContextDirectory
                        ? `添加文本或代码文件 · ${effectiveContextDirectory}`
                        : "添加文本或代码文件"
                    }
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
        {!browserState.open && !settings && (
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
