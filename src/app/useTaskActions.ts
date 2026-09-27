import type { SshRemoteState } from "../ssh-remote-types";
import {
  writeCollapsedWorkspaces,
  writeStoredTaskDrafts,
} from "../lib/ui-preferences";
import {
  attachSshWorkspace,
  defaultRemoteWorkspaceName,
  localWorkspacePath,
  taskWorkspaceName,
} from "../task-workspace";
import {
  uid,
  type ConversationScrollState,
  type TaskDrafts,
  type TaskRecord,
} from "../models";
import { sidebarWorkspaceKey } from "../sidebar-projection";
import {
  latestConversationWindow,
  type ConversationWindow,
} from "../conversation-window";
import { ConversationScrollController } from "../conversation-scroll-controller";
import { taskRuntimeStore } from "../task-runtime-store";
import { normalizeStoredTask } from "../lib/storage";
import { errorMessage } from "../lib/format";
import type { SidebarLocalWorkspaceTarget } from "../components/sidebar/Sidebar";
import {
  completePageMetadata,
  prependUniqueItems,
} from "../task-history-paging";
import { type DesignElementContext } from "../design-mode";
import { isTaskViewCurrent } from "../task-status";
import type {
  AgentActivity,
  ChatMessage,
  ContextFile,
  ReasoningEffort,
  WorkspaceFolder,
  ImageAttachment,
} from "../types";
import { resolveWorkspaceView, type TaskPagingState } from "./app-utils";

type TaskActionBindings = {
  setContextError: React.Dispatch<React.SetStateAction<string>>;
  taskStorageReady: boolean;
  setSettings: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingFolder: React.Dispatch<
    React.SetStateAction<WorkspaceFolder | null>
  >;
  setNewTaskName: React.Dispatch<React.SetStateAction<string>>;
  setNewTaskOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setAssignFolderForTask: React.Dispatch<
    React.SetStateAction<TaskRecord | null>
  >;
  setTasks: React.Dispatch<React.SetStateAction<TaskRecord[]>>;
  flashAppToast: (message: string, tone?: "success" | "error") => void;
  setSshRemoteDialogTaskId: React.Dispatch<
    React.SetStateAction<string | undefined>
  >;
  tasksRef: React.RefObject<TaskRecord[]>;
  setSshRemoteState: React.Dispatch<
    React.SetStateAction<SshRemoteState | undefined>
  >;
  setWorkspaceView: React.Dispatch<React.SetStateAction<"chat" | "editor">>;
  selected: string;
  activeTask: TaskRecord;
  reasoningEffort: ReasoningEffort;
  hydratedTaskIdsRef: React.RefObject<Set<string>>;
  claimTaskView: (taskId: string) => void;
  setActiveTaskId: React.Dispatch<React.SetStateAction<string>>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setActivities: React.Dispatch<React.SetStateAction<AgentActivity[]>>;
  setInput: (value: string) => void;
  setAttachedFiles: React.Dispatch<React.SetStateAction<ContextFile[]>>;
  setAttachedImages: React.Dispatch<React.SetStateAction<ImageAttachment[]>>;
  setUsage: React.Dispatch<
    React.SetStateAction<{
      input: number;
      output: number;
      cached: number;
      promptTokens?: number;
    }>
  >;
  setUsageResolved: React.Dispatch<React.SetStateAction<boolean>>;
  setDurationMs: React.Dispatch<React.SetStateAction<number>>;
  setUsedContextCount: React.Dispatch<React.SetStateAction<number>>;
  currentRequest: React.RefObject<string | undefined>;
  setRunningId: React.Dispatch<React.SetStateAction<string | undefined>>;
  requestStartedRef: React.RefObject<number | undefined>;
  contextByMessageRef: React.RefObject<Map<string, ContextFile[]>>;
  designByMessageRef: React.RefObject<Map<string, DesignElementContext[]>>;
  autoFollowRef: React.RefObject<boolean>;
  setStatusOpen: React.Dispatch<React.SetStateAction<boolean>>;
  newTaskName: string;
  pendingFolder: WorkspaceFolder | null;
  rememberTaskPaging: (taskId: string, paging: TaskPagingState) => void;
  persistedTaskRefsRef: React.RefObject<Map<string, TaskRecord>>;
  taskPagingRef: React.RefObject<
    Map<
      string,
      {
        messages: import("../types").TaskItemPageMetadata;
        activities: import("../types").TaskItemPageMetadata;
      }
    >
  >;
  fullHistoryLoadsRef: React.RefObject<Map<string, Promise<TaskRecord>>>;
  activeTaskIdRef: React.RefObject<string>;
  displayedTaskIdRef: React.RefObject<string>;
  activeTaskId: string;
  taskSwitchSequenceRef: React.RefObject<number>;
  setTaskSwitchPending: React.Dispatch<React.SetStateAction<boolean>>;
  readComposerValue: () => string;
  persistTaskDrafts: (value?: string) => void;
  attachedFiles: ContextFile[];
  attachedImages: ImageAttachment[];
  attachmentDraftsRef: React.RefObject<
    Map<
      string,
      {
        files: ContextFile[];
        images: ImageAttachment[];
      }
    >
  >;
  visibleTurnWindow: ConversationWindow;
  conversationWindowByTaskRef: React.RefObject<Map<string, ConversationWindow>>;
  conversationRef: React.RefObject<HTMLElement | null>;
  scrollStateByTaskRef: React.RefObject<Map<string, ConversationScrollState>>;
  pendingScrollRestoreRef: React.RefObject<
    | {
        taskId: string;
        state: ConversationScrollState;
      }
    | undefined
  >;
  pagedTaskRef: React.RefObject<string | undefined>;
  conversationPageSize: number;
  setVisibleTurnWindow: React.Dispatch<
    React.SetStateAction<ConversationWindow>
  >;
  setSelected: React.Dispatch<React.SetStateAction<string>>;
  defaultReasoningEffort: ReasoningEffort;
  setReasoningEffort: React.Dispatch<React.SetStateAction<ReasoningEffort>>;
  initialDrafts: React.RefObject<TaskDrafts>;
  conversationScrollControllerRef: React.RefObject<ConversationScrollController>;
  setShowScrollToBottom: React.Dispatch<React.SetStateAction<boolean>>;
  setCollapsedWorkspaces: React.Dispatch<React.SetStateAction<Set<string>>>;
  creatingConversationPathsRef: React.RefObject<Set<string>>;
  setCreatingConversationPaths: React.Dispatch<
    React.SetStateAction<Set<string>>
  >;
  flashContextToast: (message: string) => void;
  forgetTaskPaging: (taskId: string) => void;
  requestTasksRef: React.RefObject<Map<string, string>>;
  tasks: TaskRecord[];
};

export function useTaskActions({
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
}: TaskActionBindings) {
  function startNewTask() {
    setContextError("");
    if (!taskStorageReady) return;
    if (window.kcode && !window.kcode.workspace) {
      setContextError("桌面主进程版本较旧，请重启应用后再试");
      return;
    }
    setSettings(false);
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
    designByMessageRef.current.clear();
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
    designByMessageRef.current.clear();
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
    setTaskSwitchPending(true);
    try {
      task = await ensureTaskLoaded(task);
    } catch (error) {
      if (switchSequence === taskSwitchSequenceRef.current) {
        setTaskSwitchPending(false);
      }
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
    designByMessageRef.current.clear();
    autoFollowRef.current = targetScroll.atBottom;
    conversationScrollControllerRef.current.reset();
    setShowScrollToBottom(!targetScroll.atBottom);
    setTaskSwitchPending(false);
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

  async function renameTask(taskId: string, name: string) {
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (!task) throw new Error("找不到要重命名的任务");
    const normalizedName = name.replace(/\s+/g, " ").trim();
    if (!normalizedName) throw new Error("任务名称不能为空");
    if (normalizedName.length > 80)
      throw new Error("任务名称不能超过 80 个字符");
    if (normalizedName === task.name) return;

    const updatedAt = Date.now();
    let renamed: { name: string; updatedAt: number };
    if (window.kcode?.state.renameTask) {
      renamed = await window.kcode.state.renameTask(taskId, normalizedName);
    } else if (window.kcode?.state.saveTask) {
      // Keep compatibility with an older preload while preserving paged-out
      // messages and activities.
      const loadedTask = await ensureTaskLoaded(task);
      await window.kcode.state.saveTask(
        taskId,
        { ...loadedTask, name: normalizedName, updatedAt },
        { preserveUnloadedItems: true },
      );
      renamed = { name: normalizedName, updatedAt };
    } else {
      renamed = { name: normalizedName, updatedAt };
    }
    setTasks((current) =>
      current.map((item) =>
        item.id === taskId
          ? { ...item, name: renamed.name, updatedAt: renamed.updatedAt }
          : item,
      ),
    );
    const persisted = persistedTaskRefsRef.current.get(taskId);
    if (persisted)
      persistedTaskRefsRef.current.set(taskId, {
        ...persisted,
        name: renamed.name,
        updatedAt: renamed.updatedAt,
      });
    flashAppToast("任务已重命名");
  }

  async function renameWorkspace(workspaceKey: string, name: string) {
    const members = tasksRef.current.filter(
      (task) => sidebarWorkspaceKey(task) === workspaceKey,
    );
    if (!members.length) throw new Error("找不到要重命名的工作区");
    const normalizedName = name.replace(/\s+/g, " ").trim();
    if (!normalizedName) throw new Error("工作区名称不能为空");
    if (normalizedName.length > 80)
      throw new Error("工作区名称不能超过 80 个字符");
    if (members.every((task) => task.workspaceName === normalizedName)) return;

    const taskIds = members.map((task) => task.id);
    const updatedAt = Date.now();
    let renamed: { name: string; updatedAt: number };
    if (window.kcode?.state.renameWorkspace) {
      renamed = await window.kcode.state.renameWorkspace(
        taskIds,
        normalizedName,
      );
    } else if (window.kcode) {
      await Promise.all(
        members.map(async (task) => {
          const loadedTask = await ensureTaskLoaded(task);
          await window.kcode!.state.saveTask(
            task.id,
            {
              ...loadedTask,
              workspaceName: normalizedName,
              updatedAt,
            },
            { preserveUnloadedItems: true },
          );
        }),
      );
      renamed = { name: normalizedName, updatedAt };
    } else {
      renamed = { name: normalizedName, updatedAt };
    }

    const memberIds = new Set(taskIds);
    const nextTasks = tasksRef.current.map((task) =>
      memberIds.has(task.id)
        ? {
            ...task,
            workspaceName: renamed.name,
            updatedAt: renamed.updatedAt,
          }
        : task,
    );
    tasksRef.current = nextTasks;
    setTasks(nextTasks);
    for (const taskId of taskIds) {
      const persisted = persistedTaskRefsRef.current.get(taskId);
      if (persisted)
        persistedTaskRefsRef.current.set(taskId, {
          ...persisted,
          workspaceName: renamed.name,
          updatedAt: renamed.updatedAt,
        });
    }

    const renamedMember = nextTasks.find((task) => memberIds.has(task.id));
    const nextWorkspaceKey = renamedMember
      ? sidebarWorkspaceKey(renamedMember)
      : workspaceKey;
    if (nextWorkspaceKey !== workspaceKey)
      setCollapsedWorkspaces((current) => {
        if (!current.has(workspaceKey)) return current;
        const next = new Set(current);
        next.delete(workspaceKey);
        next.add(nextWorkspaceKey);
        writeCollapsedWorkspaces(next);
        return next;
      });
    flashAppToast("工作区已重命名");
  }

  async function createConversation(workspaceKey: string) {
    if (creatingConversationPathsRef.current.has(workspaceKey)) return;
    creatingConversationPathsRef.current.add(workspaceKey);
    setCreatingConversationPaths(new Set(creatingConversationPathsRef.current));
    try {
      const sourceTask = tasksRef.current.find(
        (task) => sidebarWorkspaceKey(task) === workspaceKey,
      );
      if (!sourceTask) return;
      const now = Date.now();
      const taskId = uid();
      // Inherit the workspace identity immediately. Do not await SSH reconnect
      // here — that made secondary tasks under an already-connected remote
      // feel stuck, and activeTask's effect restores the session in background.
      const remoteWorkspace = sourceTask.remoteWorkspace;
      const targetWorkspacePath =
        sourceTask.workspacePath || localWorkspacePath(sourceTask) || "";
      const task: TaskRecord = {
        id: taskId,
        name: "新对话",
        workspaceName: sourceTask ? taskWorkspaceName(sourceTask) : undefined,
        localWorkspacePath: sourceTask
          ? localWorkspacePath(sourceTask)
          : undefined,
        workspacePath: targetWorkspacePath,
        remoteWorkspace,
        // New conversations start in chat even for SSH workspaces; the user
        // can switch to the editor explicitly.
        workspaceView: "chat",
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
      setWorkspaceView("chat");
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
      designByMessageRef.current.clear();
      pendingScrollRestoreRef.current = undefined;
      autoFollowRef.current = true;
      setShowScrollToBottom(false);
      flashAppToast("已新建对话");
    } catch (error) {
      setContextError(`新建对话失败：${errorMessage(error)}`);
      flashAppToast("新建对话失败", "error");
    } finally {
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
        workspaceView: "chat",
      };
      hydratedTaskIdsRef.current.add(fork.id);
      setTasks((all) => [fork, ...all]);
      claimTaskView(fork.id);
      setActiveTaskId(fork.id);
      setWorkspaceView("chat");
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
      designByMessageRef.current.clear();
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
      const source = await ensureFullTaskHistory(
        await ensureTaskLoaded(activeTask),
      );
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
        const saved = await window.kcode.files.saveText(
          baseName,
          content,
          format,
        );
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
    writeStoredTaskDrafts(initialDrafts.current);
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
  return {
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
  };
}
