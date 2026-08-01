import type { ImageAttachment, ProviderConfig } from "./types";

export const MAX_REMOTE_ATTACHMENT_BYTES = 7 * 1024 * 1024;

export type RemoteContextAttachment = {
  id: string;
  name: string;
  content: string;
  size: number;
};

export type RemoteAttachments = {
  images?: ImageAttachment[];
  files?: RemoteContextAttachment[];
};

export type RemoteControlState = {
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  serverUrl: string;
  username?: string;
  deviceId: string;
  deviceName: string;
  lastSyncedAt?: number;
  error?: string;
};

export type RemoteCommand =
  | { type: "task.load"; taskId: string }
  | {
      type: "task.send";
      taskId: string;
      content: string;
      attachments?: RemoteAttachments;
    }
  | { type: "task.cancel"; taskId: string }
  | {
      type: "task.approve";
      taskId: string;
      requestId: string;
      activityId: string;
      allowed: boolean;
    };

export type RemoteCommandEnvelope = {
  id: string;
  command: RemoteCommand;
};

export type RemoteTaskStreamEvent = {
  type: "task.event";
  event: "stream";
  taskId: string;
  requestId: string;
  content: string;
  reasoning?: string;
  progress?: string;
  updatedAt: number;
};

export type RemoteTaskSnapshot = {
  id: string;
  name: string;
  workspaceName: string;
  createdAt: number;
  updatedAt: number;
  runningId?: string;
  runStatus?: string;
  modelSelection?: string;
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    error?: string;
    createdAt: number;
    model?: string;
    imageCount?: number;
    files?: Array<{ name: string; size: number }>;
  }>;
  activities: Array<{
    id: string;
    requestId: string;
    tool: string;
    status: string;
    title: string;
    narrative?: string;
    liveStatus?: string;
    planSteps?: string[];
    planStep?: number;
    startedAt: number;
    completedAt?: number;
    path?: string;
    additions?: number;
    deletions?: number;
    exitCode?: number;
    errorSummary?: string;
  }>;
  usage?: { input: number; output: number; cached: number };
  durationMs?: number;
  archived?: boolean;
};

export type RemoteProvider = ProviderConfig & { apiKey?: string };
