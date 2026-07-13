import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, KCodeApi } from "../src/types";

const api: KCodeApi = {
  state: {
    load: (key) => ipcRenderer.invoke("state:load", key),
    save: (key, value) => ipcRenderer.invoke("state:save", key, value),
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
  },
  chat: {
    start: (request) => ipcRenderer.invoke("chat:start", request),
    cancel: (id) => ipcRenderer.invoke("chat:cancel", id),
    approve: (requestId, activityId, allowed) =>
      ipcRenderer.invoke("chat:approve", requestId, activityId, allowed),
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
    pickFiles: () => ipcRenderer.invoke("context:pick-files"),
  },
  workspace: {
    pickFolder: () => ipcRenderer.invoke("workspace:pick-folder"),
    gitState: (path) => ipcRenderer.invoke("workspace:git-state", path),
  },
  browser: {
    activate: (sessionId) => ipcRenderer.invoke("browser:activate", sessionId),
    close: (sessionId) => ipcRenderer.invoke("browser:close", sessionId),
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
};
contextBridge.exposeInMainWorld("kcode", api);
