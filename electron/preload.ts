import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AgentEvent, KCodeApi } from "../src/types";

const api: KCodeApi = {
  updater: {
    state: () => ipcRenderer.invoke("update:state"),
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    openRelease: () => ipcRenderer.invoke("update:open-release"),
    onState: (callback) => {
      const listener = (_e: unknown, state: Parameters<typeof callback>[0]) =>
        callback(state);
      ipcRenderer.on("update:state", listener);
      return () => ipcRenderer.removeListener("update:state", listener);
    },
  },
  logs: { reveal: () => ipcRenderer.invoke("log:reveal") },
  shell: {
    openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
    revealPath: (targetPath, workspacePath) =>
      ipcRenderer.invoke("shell:reveal-path", targetPath, workspacePath),
  },
  state: {
    load: (key) => ipcRenderer.invoke("state:load", key),
    save: (key, value) => ipcRenderer.invoke("state:save", key, value),
    stats: () => ipcRenderer.invoke("state:stats"),
    compact: () => ipcRenderer.invoke("state:compact"),
    taskHeaders: () => ipcRenderer.invoke("state:task-headers"),
    loadTask: (id) => ipcRenderer.invoke("state:load-task", id),
    loadTaskWindow: (id) => ipcRenderer.invoke("state:load-task-window", id),
    taskMessagePage: (id, options) =>
      ipcRenderer.invoke("state:task-message-page", id, options),
    taskActivityPage: (id, options) =>
      ipcRenderer.invoke("state:task-activity-page", id, options),
    runtimeEvents: (id, options) =>
      ipcRenderer.invoke("state:runtime-events", id, options),
    runtimeStatuses: () => ipcRenderer.invoke("state:runtime-statuses"),
    taskActivitiesForRequests: (id, requestIds) =>
      ipcRenderer.invoke("state:task-activities-for-requests", id, requestIds),
    loadActivityPayload: (activityId) =>
      ipcRenderer.invoke("state:load-activity-payload", activityId),
    saveTask: (id, value, options) =>
      ipcRenderer.invoke("state:save-task", id, value, options),
    saveTaskOrder: (ids) => ipcRenderer.invoke("state:save-task-order", ids),
    deleteTask: (id) => ipcRenderer.invoke("state:delete-task", id),
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
  },
  providers: {
    list: () => ipcRenderer.invoke("providers:list"),
    save: (provider, apiKey) =>
      ipcRenderer.invoke("providers:save", provider, apiKey),
    remove: (id) => ipcRenderer.invoke("providers:remove", id),
    discover: (id) => ipcRenderer.invoke("providers:discover", id),
    probe: (id) => ipcRenderer.invoke("providers:probe", id),
  },
  skills: {
    list: (refresh) => ipcRenderer.invoke("skills:list", refresh),
    install: (id) => ipcRenderer.invoke("skills:install", id),
    importLocal: () => ipcRenderer.invoke("skills:import-local"),
    revealFolder: () => ipcRenderer.invoke("skills:reveal-folder"),
    uninstall: (id) => ipcRenderer.invoke("skills:uninstall", id),
    setEnabled: (id, enabled) =>
      ipcRenderer.invoke("skills:set-enabled", id, enabled),
  },
  mcp: {
    list: () => ipcRenderer.invoke("mcp:list"),
    save: (server) => ipcRenderer.invoke("mcp:save", server),
    remove: (id) => ipcRenderer.invoke("mcp:remove", id),
    test: (id) => ipcRenderer.invoke("mcp:test", id),
    tools: (id) => ipcRenderer.invoke("mcp:tools", id),
  },
  files: {
    parse: (filePath) => ipcRenderer.invoke("context:parse-file", filePath),
    saveText: (suggestedName, content, format) =>
      ipcRenderer.invoke("files:save-text", suggestedName, content, format),
  },
  runtime: {
    processes: () => ipcRenderer.invoke("runtime:processes"),
    statuses: (taskId) => ipcRenderer.invoke("runtime:statuses", taskId),
    stopProcess: (id) => ipcRenderer.invoke("runtime:stop-process", id),
    stopAll: () => ipcRenderer.invoke("runtime:stop-all"),
  },
  chat: {
    start: (request) => ipcRenderer.invoke("chat:start", request),
    steer: (requestId, content) =>
      ipcRenderer.invoke("chat:steer", requestId, content),
    cancel: (id) => ipcRenderer.invoke("chat:cancel", id),
    approve: (requestId, activityId, allowed) =>
      ipcRenderer.invoke("chat:approve", requestId, activityId, allowed),
    approveWithScope: (requestId, activityId, allowed, scope, command, category, workspace) =>
      ipcRenderer.invoke("chat:approveWithScope", requestId, activityId, allowed, scope, command, category, workspace),
    undo: (workspacePath, activityId, force) =>
      ipcRenderer.invoke("chat:undo", workspacePath, activityId, force),
    cleanup: (requestIds, activityIds) =>
      ipcRenderer.invoke("chat:cleanup", requestIds, activityIds),
    summarize: (request) => ipcRenderer.invoke("chat:summarize", request),
    cancelSummary: (taskId) =>
      ipcRenderer.invoke("chat:cancel-summary", taskId),
    checkpoints: () => ipcRenderer.invoke("chat:checkpoints"),
    removeCheckpoint: (id) => ipcRenderer.invoke("chat:remove-checkpoint", id),
    onEvent: (callback) => {
      const listener = (_e: unknown, id: string, event: AgentEvent) =>
        callback(id, event);
      ipcRenderer.on("chat:event", listener);
      return () => ipcRenderer.removeListener("chat:event", listener);
    },
  },
  context: {
    pickFiles: (defaultDirectory) =>
      ipcRenderer.invoke("context:pick-files", defaultDirectory),
    pickDirectory: (defaultDirectory) =>
      ipcRenderer.invoke("context:pick-directory", defaultDirectory),
    filePath: (file) => webUtils.getPathForFile(file),
  },
  workspace: {
    pickFolder: () => ipcRenderer.invoke("workspace:pick-folder"),
    gitState: (path, includeDiff) =>
      ipcRenderer.invoke("workspace:git-state", path, includeDiff),
    gitFileDiff: (path, filePath) =>
      ipcRenderer.invoke("workspace:git-file-diff", path, filePath),
    showFolderMenu: (path) =>
      ipcRenderer.invoke("workspace:show-folder-menu", path),
    list: (root, directory) =>
      ipcRenderer.invoke("workspace:list", root, directory),
    read: (root, filePath) =>
      ipcRenderer.invoke("workspace:read", root, filePath),
    write: (root, filePath, content, expectedContent) =>
      ipcRenderer.invoke(
        "workspace:write",
        root,
        filePath,
        content,
        expectedContent,
      ),
  },
  sshRemote: {
    profiles: () => ipcRenderer.invoke("ssh-remote:profiles"),
    connect: (input) => ipcRenderer.invoke("ssh-remote:connect", input),
    adopt: (taskId, rootPath) =>
      ipcRenderer.invoke("ssh-remote:adopt", taskId, rootPath),
    connectSaved: (taskId, profileId) =>
      ipcRenderer.invoke("ssh-remote:connect-saved", taskId, profileId),
    state: (taskId, profileId) =>
      ipcRenderer.invoke("ssh-remote:state", taskId, profileId),
    disconnect: (taskId) => ipcRenderer.invoke("ssh-remote:disconnect", taskId),
    forget: (profileId) => ipcRenderer.invoke("ssh-remote:forget", profileId),
    list: (taskId, profileId, remotePath) =>
      ipcRenderer.invoke("ssh-remote:list", taskId, profileId, remotePath),
    read: (taskId, profileId, remotePath) =>
      ipcRenderer.invoke("ssh-remote:read", taskId, profileId, remotePath),
    write: (taskId, profileId, remotePath, content, expectedContent) =>
      ipcRenderer.invoke(
        "ssh-remote:write",
        taskId,
        profileId,
        remotePath,
        content,
        expectedContent,
      ),
    pickPrivateKey: () => ipcRenderer.invoke("ssh-remote:pick-private-key"),
  },
  browser: {
    activate: (sessionId) => ipcRenderer.invoke("browser:activate", sessionId),
    close: (sessionId) => ipcRenderer.invoke("browser:close", sessionId),
    hide: (sessionId) => ipcRenderer.invoke("browser:hide", sessionId),
    navigate: (sessionId, url) =>
      ipcRenderer.invoke("browser:navigate", sessionId, url),
    back: (sessionId) => ipcRenderer.invoke("browser:back", sessionId),
    forward: (sessionId) => ipcRenderer.invoke("browser:forward", sessionId),
    reload: (sessionId) => ipcRenderer.invoke("browser:reload", sessionId),
    setWidth: (width) => ipcRenderer.invoke("browser:set-width", width),
    recordings: () => ipcRenderer.invoke("browser:recordings"),
    removeRecording: (id) => ipcRenderer.invoke("browser:remove-recording", id),
    revealRecording: (id) => ipcRenderer.invoke("browser:reveal-recording", id),
    onState: (callback) => {
      const listener = (_e: unknown, state: Parameters<typeof callback>[0]) =>
        callback(state);
      ipcRenderer.on("browser:state", listener);
      return () => ipcRenderer.removeListener("browser:state", listener);
    },
  },
  remote: {
    state: () => ipcRenderer.invoke("remote:state"),
    register: (username, password) =>
      ipcRenderer.invoke("remote:register", username, password),
    login: (username, password) =>
      ipcRenderer.invoke("remote:login", username, password),
    logout: () => ipcRenderer.invoke("remote:logout"),
    setEnabled: (enabled) => ipcRenderer.invoke("remote:set-enabled", enabled),
    setDeviceName: (name) => ipcRenderer.invoke("remote:set-device-name", name),
    syncTasks: (tasks) => ipcRenderer.invoke("remote:sync-tasks", tasks),
    syncTaskEvent: (event) =>
      ipcRenderer.invoke("remote:sync-task-event", event),
    commandResult: (id, ok, error) =>
      ipcRenderer.invoke("remote:command-result", id, ok, error),
    ready: () => ipcRenderer.invoke("remote:ready"),
    onState: (callback) => {
      const listener = (_e: unknown, state: Parameters<typeof callback>[0]) =>
        callback(state);
      ipcRenderer.on("remote:state", listener);
      return () => ipcRenderer.removeListener("remote:state", listener);
    },
    onCommand: (callback) => {
      const listener = (
        _e: unknown,
        envelope: Parameters<typeof callback>[0],
      ) => callback(envelope);
      ipcRenderer.on("remote:command", listener);
      return () => ipcRenderer.removeListener("remote:command", listener);
    },
  },
};
contextBridge.exposeInMainWorld("kcode", api);
window.addEventListener("error", (event) =>
  ipcRenderer.send("log:renderer-error", {
    message: event.message,
    filename: event.filename,
    line: event.lineno,
    column: event.colno,
    stack: event.error?.stack,
  }),
);
window.addEventListener("unhandledrejection", (event) =>
  ipcRenderer.send("log:renderer-error", {
    type: "unhandledrejection",
    reason:
      event.reason instanceof Error
        ? { message: event.reason.message, stack: event.reason.stack }
        : String(event.reason),
  }),
);
