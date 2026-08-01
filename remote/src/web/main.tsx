import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bot,
  Check,
  ChevronLeft,
  CircleAlert,
  CircleDot,
  Cloud,
  FileDiff,
  FileText,
  ImagePlus,
  LoaderCircle,
  LogOut,
  Paperclip,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  Square,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { AdminApp } from "./admin";
import {
  MAX_MOBILE_FILES,
  MAX_MOBILE_IMAGES,
  addMobileContextFiles,
  addMobileImages,
  formatAttachmentSize,
  type MobileContextAttachment,
  type MobileImageAttachment,
} from "./mobile-attachments";
import "./styles.css";

type User = { id: string; username: string };
type Device = {
  id: string;
  name: string;
  platform: string;
  version: string;
  online: boolean;
  lastSeen: number;
};
type Task = {
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
type RemoteCommand =
  | { type: "task.load"; taskId: string }
  | {
      type: "task.send";
      taskId: string;
      content: string;
      clientMessageId?: string;
      attachments?: {
        images?: MobileImageAttachment[];
        files?: MobileContextAttachment[];
      };
    }
  | { type: "task.cancel"; taskId: string }
  | {
      type: "task.approve";
      taskId: string;
      requestId: string;
      activityId: string;
      allowed: boolean;
    };

type PendingMobileMessage = {
  id: string;
  deviceId: string;
  taskId: string;
  content: string;
  createdAt: number;
  status: "sending" | "sent" | "failed";
  error?: string;
  command: Extract<RemoteCommand, { type: "task.send" }>;
};

type LiveStream = {
  taskId: string;
  requestId: string;
  content: string;
  reasoning?: string;
  progress?: string;
  updatedAt: number;
};

function liveStreamKey(taskId: string, requestId: string) {
  return `${taskId}:${requestId}`;
}

function mergeLiveContent(content: string, liveContent = "") {
  if (!liveContent || content.endsWith(liveContent)) return content;
  return content + liveContent;
}

function clientId(prefix: string) {
  const id = globalThis.crypto?.randomUUID?.();
  return id
    ? `${prefix}-${id}`
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function mainBundleSource(documentRoot: Document) {
  const source = Array.from(
    documentRoot.querySelectorAll<HTMLScriptElement>(
      "script[type='module'][src]",
    ),
  )
    .map((script) => script.getAttribute("src"))
    .find(Boolean);
  return source ? new URL(source, location.href).href : "";
}

const jsonRequest = async <T,>(path: string, init?: RequestInit) => {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    credentials: "same-origin",
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & T;
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
};

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function statusText(task: Task) {
  if (task.runStatus === "running" || task.runningId) return "运行中";
  if (task.runStatus === "failed") return "失败";
  if (task.runStatus === "cancelled") return "已停止";
  if (task.runStatus === "paused") return "已暂停";
  if (task.runStatus === "completed") return "已完成";
  return "待开始";
}

function statusClass(task: Task) {
  if (task.runStatus === "running" || task.runningId) return "running";
  if (task.runStatus === "failed") return "failed";
  if (task.runStatus === "completed") return "completed";
  return "idle";
}

function latestPreview(task: Task, live?: LiveStream) {
  if (live?.content.trim()) return live.content;
  if (live?.progress?.trim()) return live.progress;
  const message = [...task.messages]
    .reverse()
    .find((item) => item.content || item.error);
  return message?.error || message?.content || "还没有消息";
}

function LoginScreen({
  registrationOpen,
  onAuthenticated,
}: {
  registrationOpen: boolean;
  onAuthenticated(user: User): void;
}) {
  const [registering, setRegistering] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await jsonRequest<{ user: User }>(
        registering ? "/api/auth/register" : "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ username, password, clientType: "mobile" }),
        },
      );
      onAuthenticated(result.user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="brand-mark">
          <Bot size={21} />
        </div>
        <p className="eyebrow">KCODE REMOTE</p>
        <h1>登录电脑上的 KCode</h1>
        <p className="auth-copy">
          登录后查看任务进度、发送消息并处理需要确认的操作。
        </p>
        <form onSubmit={submit} className="auth-form">
          <label>
            <span>账号</span>
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="账号或邮箱"
              required
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              autoComplete={registering ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 10 位"
              required
            />
          </label>
          {error && (
            <div className="form-error">
              <CircleAlert size={15} />
              {error}
            </div>
          )}
          <button className="primary-button" disabled={busy} type="submit">
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : registering ? (
              <Check size={16} />
            ) : (
              <ShieldCheck size={16} />
            )}
            {busy ? "处理中" : registering ? "创建账号" : "登录"}
          </button>
        </form>
        {registrationOpen && (
          <button
            className="text-button"
            onClick={() => {
              setRegistering((value) => !value);
              setError("");
            }}
          >
            {registering ? "已有账号，返回登录" : "创建新账号"}
          </button>
        )}
        <div className="auth-note">
          <Cloud size={14} />
          本地电脑端仍可不登录独立使用
        </div>
      </section>
    </main>
  );
}

function App() {
  const [user, setUser] = useState<User>();
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState(
    () => localStorage.getItem("kcode.remote.device") || "",
  );
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState("");
  const [mobileImages, setMobileImages] = useState<MobileImageAttachment[]>([]);
  const [mobileFiles, setMobileFiles] = useState<MobileContextAttachment[]>([]);
  const [pendingMessages, setPendingMessages] = useState<
    PendingMobileMessage[]
  >([]);
  const [liveStreams, setLiveStreams] = useState<Record<string, LiveStream>>(
    {},
  );
  const [mobileDetail, setMobileDetail] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const pendingCommandsRef = useRef(new Map<string, string>());
  const pendingTimersRef = useRef(new Map<string, number>());
  const pendingCleanupTimersRef = useRef(new Map<string, number>());
  const optimisticCommandIdsRef = useRef(new Set<string>());
  const deviceIdRef = useRef(deviceId);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const scrollTrackRef = useRef<HTMLDivElement | null>(null);
  const scrollThumbRef = useRef<HTMLElement | null>(null);
  const autoFollowRef = useRef(true);

  const selectedDevice = devices.find((item) => item.id === deviceId);
  const selectedTask = tasks.find((item) => item.id === selectedTaskId);
  const selectedLiveStream = selectedTask?.runningId
    ? liveStreams[liveStreamKey(selectedTask.id, selectedTask.runningId)]
    : undefined;
  const selectedPendingMessages = pendingMessages.filter(
    (message) =>
      message.deviceId === deviceId && message.taskId === selectedTaskId,
  );
  const online = Boolean(selectedDevice?.online && connected);

  function applyTaskSnapshots(nextTasks: Task[], targetDeviceId = deviceId) {
    if (targetDeviceId !== deviceIdRef.current) return;
    const confirmedMessageIds = new Set(
      nextTasks.flatMap((task) => task.messages.map((message) => message.id)),
    );
    setPendingMessages((current) =>
      current.filter(
        (message) =>
          message.deviceId !== targetDeviceId ||
          !confirmedMessageIds.has(message.id),
      ),
    );
    setTasks(nextTasks);
    setLiveStreams((current) => {
      const next: Record<string, LiveStream> = {};
      for (const task of nextTasks) {
        if (!task.runningId) continue;
        const key = liveStreamKey(task.id, task.runningId);
        if (current[key]) next[key] = current[key];
      }
      return next;
    });
    setSelectedTaskId((current) =>
      nextTasks.some((item) => item.id === current)
        ? current
        : nextTasks[0]?.id || "",
    );
  }

  function applyLiveStreams(
    streams: LiveStream[],
    targetDeviceId = deviceIdRef.current,
  ) {
    if (!streams.length || targetDeviceId !== deviceIdRef.current) return;
    setLiveStreams((current) => {
      const next = { ...current };
      for (const stream of streams) {
        const key = liveStreamKey(stream.taskId, stream.requestId);
        if (!next[key] || next[key].updatedAt <= stream.updatedAt)
          next[key] = stream;
      }
      return next;
    });
    const latestByTask = new Map<string, LiveStream>();
    for (const stream of streams) {
      const current = latestByTask.get(stream.taskId);
      if (!current || current.updatedAt <= stream.updatedAt)
        latestByTask.set(stream.taskId, stream);
    }
    setTasks((current) =>
      current.map((task) => {
        const stream = latestByTask.get(task.id);
        if (
          !stream ||
          (task.runningId !== stream.requestId &&
            task.updatedAt > stream.updatedAt)
        )
          return task;
        return {
          ...task,
          runningId: stream.requestId,
          runStatus: "running",
          updatedAt: Math.max(task.updatedAt, stream.updatedAt),
        };
      }),
    );
  }

  async function loadSession() {
    try {
      const result = await jsonRequest<{
        user: User;
        registrationOpen: boolean;
      }>("/api/session");
      setUser(result.user);
      setRegistrationOpen(result.registrationOpen);
    } catch {
      const health = await jsonRequest<{ registrationOpen: boolean }>(
        "/api/health",
      );
      setRegistrationOpen(health.registrationOpen);
    } finally {
      setLoading(false);
    }
  }

  async function loadDevices() {
    const result = await jsonRequest<{ devices: Device[] }>("/api/devices");
    setDevices(result.devices);
    setDeviceId((current) => {
      const preferred = result.devices.find((item) => item.id === current)?.id;
      const next = preferred || result.devices[0]?.id || "";
      if (next) localStorage.setItem("kcode.remote.device", next);
      return next;
    });
  }

  async function loadTasks(target = deviceId) {
    if (!target) {
      setTasks([]);
      return;
    }
    const result = await jsonRequest<{
      tasks: Task[];
      streams?: Array<LiveStream & { deviceId?: string }>;
    }>(`/api/devices/${encodeURIComponent(target)}/tasks`);
    applyTaskSnapshots(result.tasks, target);
    applyLiveStreams(result.streams || [], target);
  }

  function clearPendingTimer(commandId: string) {
    const timer = pendingTimersRef.current.get(commandId);
    if (timer !== undefined) window.clearTimeout(timer);
    pendingTimersRef.current.delete(commandId);
  }

  function clearPendingTransports(pendingId: string) {
    for (const [commandId, messageId] of pendingCommandsRef.current) {
      if (messageId !== pendingId) continue;
      clearPendingTimer(commandId);
      pendingCommandsRef.current.delete(commandId);
    }
  }

  function clearPendingCleanup(pendingId: string) {
    const timer = pendingCleanupTimersRef.current.get(pendingId);
    if (timer !== undefined) window.clearTimeout(timer);
    pendingCleanupTimersRef.current.delete(pendingId);
  }

  function schedulePendingCleanup(pendingId: string) {
    clearPendingCleanup(pendingId);
    pendingCleanupTimersRef.current.set(
      pendingId,
      window.setTimeout(() => {
        pendingCleanupTimersRef.current.delete(pendingId);
        setPendingMessages((current) =>
          current.filter((message) => message.id !== pendingId),
        );
      }, 3_000),
    );
  }

  function updatePendingMessage(
    pendingId: string,
    status: PendingMobileMessage["status"],
    error?: string,
  ) {
    setPendingMessages((current) =>
      current.map((message) =>
        message.id === pendingId
          ? { ...message, status, error: error || undefined }
          : message,
      ),
    );
  }

  function schedulePendingTimeout(
    commandId: string,
    pendingId: string,
    timeout: number,
    message: string,
  ) {
    clearPendingTimer(commandId);
    pendingTimersRef.current.set(
      commandId,
      window.setTimeout(() => {
        pendingTimersRef.current.delete(commandId);
        updatePendingMessage(pendingId, "failed", message);
      }, timeout),
    );
  }

  function acceptPendingCommand(commandId: string) {
    const pendingId = pendingCommandsRef.current.get(commandId);
    if (!pendingId) return false;
    updatePendingMessage(pendingId, "sending");
    schedulePendingTimeout(
      commandId,
      pendingId,
      20_000,
      "电脑端未确认收到消息，点按感叹号重试",
    );
    return true;
  }

  function finishPendingCommand(
    commandId: string,
    ok: boolean,
    error?: string,
  ) {
    const optimisticCommand = optimisticCommandIdsRef.current.delete(commandId);
    const pendingId = pendingCommandsRef.current.get(commandId);
    if (!pendingId) return optimisticCommand;
    clearPendingTimer(commandId);
    pendingCommandsRef.current.delete(commandId);
    updatePendingMessage(
      pendingId,
      ok ? "sent" : "failed",
      ok ? undefined : error || "电脑端执行失败，点按感叹号重试",
    );
    if (ok) schedulePendingCleanup(pendingId);
    return true;
  }

  async function sendPendingMessage(message: PendingMobileMessage) {
    clearPendingCleanup(message.id);
    clearPendingTransports(message.id);
    updatePendingMessage(message.id, "sending");
    const commandId = clientId("command");
    optimisticCommandIdsRef.current.add(commandId);
    pendingCommandsRef.current.set(commandId, message.id);
    schedulePendingTimeout(
      commandId,
      message.id,
      10_000,
      "服务器未确认收到消息，点按感叹号重试",
    );
    try {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(
          JSON.stringify({
            type: "command",
            id: commandId,
            deviceId: message.deviceId,
            command: message.command,
          }),
        );
      } else {
        await jsonRequest("/api/commands", {
          method: "POST",
          body: JSON.stringify({
            id: commandId,
            deviceId: message.deviceId,
            command: message.command,
          }),
        });
        acceptPendingCommand(commandId);
      }
    } catch (cause) {
      finishPendingCommand(
        commandId,
        false,
        cause instanceof Error ? cause.message : "发送失败",
      );
    }
  }

  function updateConversationScrollIndicator() {
    const conversation = conversationRef.current;
    const track = scrollTrackRef.current;
    const thumb = scrollThumbRef.current;
    if (!conversation || !track || !thumb) return;
    track.hidden = false;
    const scrollRange = conversation.scrollHeight - conversation.clientHeight;
    const trackHeight = track.clientHeight;
    if (scrollRange <= 1 || trackHeight <= 0) {
      track.hidden = true;
      return;
    }
    const thumbHeight = Math.max(
      30,
      (conversation.clientHeight / conversation.scrollHeight) * trackHeight,
    );
    const top =
      (conversation.scrollTop / scrollRange) * (trackHeight - thumbHeight);
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.top = `${Math.max(0, top)}px`;
  }

  useEffect(() => {
    void loadSession();
  }, []);

  useEffect(() => {
    deviceIdRef.current = deviceId;
  }, [deviceId]);

  useEffect(() => {
    let stopped = false;
    let checking = false;
    let lastCheckedAt = 0;
    async function checkForWebUpdate() {
      if (
        stopped ||
        checking ||
        document.visibilityState === "hidden" ||
        Date.now() - lastCheckedAt < 30_000
      )
        return;
      checking = true;
      lastCheckedAt = Date.now();
      try {
        const response = await fetch(`/?kcode-update=${Date.now()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!response.ok) return;
        const nextDocument = new DOMParser().parseFromString(
          await response.text(),
          "text/html",
        );
        const currentBundle = mainBundleSource(document);
        const nextBundle = mainBundleSource(nextDocument);
        if (!currentBundle || !nextBundle || currentBundle === nextBundle)
          return;
        const composer = document.querySelector<HTMLTextAreaElement>(
          ".mobile-composer textarea",
        );
        const busy = Boolean(
          composer?.value.trim() ||
          document.querySelector(
            ".mobile-attachment-tray, .remote-message.optimistic",
          ),
        );
        if (busy) setUpdateAvailable(true);
        else location.reload();
      } catch {
        /* The normal reconnect loop handles temporary network failures. */
      } finally {
        checking = false;
      }
    }
    const initial = window.setTimeout(() => void checkForWebUpdate(), 10_000);
    const interval = window.setInterval(
      () => void checkForWebUpdate(),
      180_000,
    );
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkForWebUpdate();
    };
    window.addEventListener("focus", checkForWebUpdate);
    window.addEventListener("online", checkForWebUpdate);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.removeEventListener("focus", checkForWebUpdate);
      window.removeEventListener("online", checkForWebUpdate);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    const update = () => updateConversationScrollIndicator();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      for (const timer of pendingTimersRef.current.values())
        window.clearTimeout(timer);
      for (const timer of pendingCleanupTimersRef.current.values())
        window.clearTimeout(timer);
      pendingTimersRef.current.clear();
      pendingCleanupTimersRef.current.clear();
      pendingCommandsRef.current.clear();
      optimisticCommandIdsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const active = new Set(pendingMessages.map((message) => message.id));
    for (const pendingId of new Set(pendingCommandsRef.current.values()))
      if (!active.has(pendingId)) clearPendingTransports(pendingId);
    for (const pendingId of pendingCleanupTimersRef.current.keys())
      if (!active.has(pendingId)) clearPendingCleanup(pendingId);
  }, [pendingMessages]);

  useEffect(() => {
    if (!user) return;
    setError("");
    void loadDevices().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "无法加载设备"),
    );
  }, [user]);

  useEffect(() => {
    if (!user || !deviceId) return;
    void loadTasks().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "无法加载任务"),
    );
  }, [user, deviceId]);

  useEffect(() => {
    if (!user) return;
    let stopped = false;
    function connect() {
      if (stopped) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/ws`);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        setConnected(true);
        setError("");
      });
      socket.addEventListener("close", () => {
        setConnected(false);
        if (!stopped) reconnectRef.current = window.setTimeout(connect, 3000);
      });
      socket.addEventListener("error", () => setConnected(false));
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(event.data) as {
            type: string;
            id?: string;
            deviceId?: string;
            tasks?: Task[];
            streams?: LiveStream[];
            devices?: Device[];
            ok?: boolean;
            error?: string;
            event?: string;
            taskId?: string;
            requestId?: string;
            content?: string;
            reasoning?: string;
            progress?: string;
            updatedAt?: number;
            message?: string;
          };
          if (
            message.type === "tasks.changed" &&
            message.deviceId === deviceIdRef.current &&
            message.tasks
          ) {
            applyTaskSnapshots(message.tasks, message.deviceId);
            applyLiveStreams(message.streams || [], message.deviceId);
          }
          if (
            message.type === "task.event" &&
            message.event === "stream" &&
            message.deviceId === deviceIdRef.current &&
            message.taskId &&
            message.requestId &&
            typeof message.content === "string" &&
            typeof message.updatedAt === "number"
          ) {
            const stream: LiveStream = {
              taskId: message.taskId,
              requestId: message.requestId,
              content: message.content,
              reasoning: message.reasoning,
              progress: message.progress,
              updatedAt: message.updatedAt,
            };
            applyLiveStreams([stream], message.deviceId);
          }
          if (message.type === "devices.changed" && message.devices)
            setDevices(message.devices);
          if (message.type === "command.accepted" && message.id) {
            acceptPendingCommand(message.id);
          }
          if (message.type === "command.result") {
            const pendingResult = Boolean(
              message.id &&
              finishPendingCommand(
                message.id,
                message.ok === true,
                message.error,
              ),
            );
            if (pendingResult) {
              void loadTasks();
              return;
            }
            setNotice(
              message.ok
                ? "电脑已收到并完成操作"
                : message.error || "电脑端执行失败",
            );
            window.setTimeout(() => setNotice(""), 3200);
            void loadTasks();
          }
          if (message.type === "error" && message.message)
            setError(message.message);
        } catch {
          /* Ignore malformed transient events. */
        }
      });
    }
    connect();
    const poll = window.setInterval(() => {
      void loadDevices().catch(() => undefined);
      void loadTasks().catch(() => undefined);
    }, 15_000);
    return () => {
      stopped = true;
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      window.clearInterval(poll);
      socketRef.current?.close();
    };
  }, [user, deviceId]);

  async function sendCommand(command: RemoteCommand) {
    setError("");
    try {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(
          JSON.stringify({ type: "command", deviceId, command }),
        );
      } else {
        await jsonRequest("/api/commands", {
          method: "POST",
          body: JSON.stringify({ deviceId, command }),
        });
      }
      setNotice("已发送到电脑");
      window.setTimeout(() => setNotice(""), 2200);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发送失败");
      return false;
    }
  }

  async function selectMobileImages(selected: File[]) {
    if (!selected.length) return;
    const result = await addMobileImages(mobileImages, mobileFiles, selected);
    setMobileImages(result.images);
    setError(result.errors.join("；"));
  }

  async function selectMobileFiles(selected: File[]) {
    if (!selected.length) return;
    const result = await addMobileContextFiles(
      mobileFiles,
      mobileImages,
      selected,
    );
    setMobileFiles(result.files);
    setError(result.errors.join("；"));
  }

  function clearMobileAttachments() {
    setMobileImages([]);
    setMobileFiles([]);
  }

  function submitMobileMessage(event: React.FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (
      !selectedTask ||
      (!content && !mobileImages.length && !mobileFiles.length)
    )
      return;
    const id = clientId("mobile-message");
    const command: Extract<RemoteCommand, { type: "task.send" }> = {
      type: "task.send",
      taskId: selectedTask.id,
      content,
      clientMessageId: id,
      attachments:
        mobileImages.length || mobileFiles.length
          ? {
              images: mobileImages.length ? mobileImages : undefined,
              files: mobileFiles.length ? mobileFiles : undefined,
            }
          : undefined,
    };
    const pending: PendingMobileMessage = {
      id,
      deviceId,
      taskId: selectedTask.id,
      content,
      createdAt: Date.now(),
      status: "sending",
      command,
    };
    autoFollowRef.current = true;
    setPendingMessages((current) => [...current, pending]);
    setDraft("");
    clearMobileAttachments();
    window.setTimeout(() => void sendPendingMessage(pending), 0);
  }

  function retryPendingMessage(message: PendingMobileMessage) {
    autoFollowRef.current = true;
    window.setTimeout(() => void sendPendingMessage(message), 0);
  }

  async function logout() {
    await jsonRequest("/api/auth/logout", { method: "POST" }).catch(
      () => undefined,
    );
    socketRef.current?.close();
    for (const timer of pendingTimersRef.current.values())
      window.clearTimeout(timer);
    for (const timer of pendingCleanupTimersRef.current.values())
      window.clearTimeout(timer);
    pendingTimersRef.current.clear();
    pendingCleanupTimersRef.current.clear();
    pendingCommandsRef.current.clear();
    optimisticCommandIdsRef.current.clear();
    setUser(undefined);
    setDevices([]);
    setTasks([]);
    setLiveStreams({});
    setPendingMessages([]);
    setSelectedTaskId("");
    setDraft("");
    clearMobileAttachments();
  }

  const waitingActivity = useMemo(
    () => selectedTask?.activities.find((item) => item.status === "waiting"),
    [selectedTask],
  );

  useEffect(() => {
    if (!autoFollowRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const conversation = conversationRef.current;
      if (conversation) conversation.scrollTop = conversation.scrollHeight;
      updateConversationScrollIndicator();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    mobileDetail,
    selectedTaskId,
    selectedTask?.messages.length,
    selectedPendingMessages.length,
    mobileImages.length,
    mobileFiles.length,
    waitingActivity?.id,
    selectedLiveStream?.content.length,
    selectedLiveStream?.reasoning?.length,
    selectedLiveStream?.progress,
  ]);

  if (loading)
    return (
      <main className="loading-shell">
        <LoaderCircle className="spin" size={22} />
        <span>连接 KCode Remote</span>
      </main>
    );
  if (!user)
    return (
      <LoginScreen
        registrationOpen={registrationOpen}
        onAuthenticated={setUser}
      />
    );

  return (
    <main className={`remote-shell ${mobileDetail ? "detail-open" : ""}`}>
      <aside className="remote-sidebar">
        <header className="remote-header">
          <div className="remote-brand">
            <span className="brand-mark small">
              <Bot size={16} />
            </span>
            <span>
              <strong>KCode</strong>
              <small>Remote</small>
            </span>
          </div>
          <button
            className="icon-button"
            title="退出登录"
            onClick={() => void logout()}
          >
            <LogOut size={16} />
          </button>
        </header>
        <div className="device-strip">
          <Smartphone size={15} />
          <select
            value={deviceId}
            onChange={(event) => {
              deviceIdRef.current = event.target.value;
              setDeviceId(deviceIdRef.current);
              setMobileDetail(false);
              setDraft("");
              clearMobileAttachments();
            }}
            aria-label="选择电脑"
          >
            {!devices.length && <option value="">没有已连接电脑</option>}
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
          {online ? (
            <Wifi className="online-icon" size={14} />
          ) : (
            <WifiOff size={14} />
          )}
        </div>
        <div className="sidebar-title">
          <span>任务</span>
          <button
            className="icon-button"
            title="刷新任务"
            onClick={() => {
              void loadDevices();
              void loadTasks();
            }}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="task-list">
          {tasks.map((task) => (
            <button
              key={task.id}
              className={`task-item ${task.id === selectedTaskId ? "selected" : ""}`}
              onClick={() => {
                if (task.id !== selectedTaskId) {
                  setDraft("");
                  clearMobileAttachments();
                }
                setSelectedTaskId(task.id);
                setMobileDetail(true);
                autoFollowRef.current = true;
                if (online)
                  void sendCommand({ type: "task.load", taskId: task.id });
              }}
            >
              <span className={`status-dot ${statusClass(task)}`} />
              <span className="task-item-copy">
                <strong>{task.name}</strong>
                <small>
                  {task.workspaceName} · {formatTime(task.updatedAt)}
                </small>
                <em>
                  {latestPreview(
                    task,
                    task.runningId
                      ? liveStreams[liveStreamKey(task.id, task.runningId)]
                      : undefined,
                  )}
                </em>
              </span>
            </button>
          ))}
          {!tasks.length && (
            <div className="empty-list">
              <Cloud size={19} />
              <strong>
                {selectedDevice ? "这台电脑还没有任务" : "等待电脑上线"}
              </strong>
              <span>打开桌面端并在设置中登录远程控制。</span>
            </div>
          )}
        </div>
      </aside>

      <section className="remote-content">
        <header className="content-header">
          <button
            className="icon-button mobile-only"
            title="返回任务列表"
            onClick={() => setMobileDetail(false)}
          >
            <ChevronLeft size={19} />
          </button>
          <div>
            <p className="eyebrow">
              {selectedDevice ? selectedDevice.name : "未选择设备"}
            </p>
            <h1>{selectedTask?.name || "选择一个任务"}</h1>
          </div>
          {updateAvailable && (
            <button
              className="icon-button update-available"
              title="有新版本，点击更新"
              onClick={() => location.reload()}
            >
              <RefreshCw size={15} />
            </button>
          )}
          <span className={`connection-pill ${online ? "online" : ""}`}>
            <CircleDot size={13} />
            {online ? "电脑在线" : "电脑离线"}
          </span>
        </header>
        {error && (
          <div className="global-error">
            <CircleAlert size={15} />
            {error}
          </div>
        )}
        {notice && (
          <div className="global-notice">
            <Check size={15} />
            {notice}
          </div>
        )}
        {selectedTask ? (
          <>
            <div
              className="conversation-view"
              ref={conversationRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                autoFollowRef.current =
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight <
                  96;
                updateConversationScrollIndicator();
              }}
            >
              {selectedTask.messages.map((message) => {
                const isLiveAssistant =
                  message.role === "assistant" &&
                  message.id === `assistant:${selectedTask.runningId}`;
                const live = isLiveAssistant ? selectedLiveStream : undefined;
                const content = mergeLiveContent(
                  message.content,
                  live?.content,
                );
                return (
                  <article
                    key={message.id}
                    className={`remote-message ${message.role}`}
                  >
                    <div className="message-meta">
                      <span>
                        {message.role === "user"
                          ? "你"
                          : message.model || "KCode"}
                      </span>
                      <time>{formatTime(message.createdAt)}</time>
                    </div>
                    <div className="message-body">
                      {message.error ? (
                        <span className="message-error">{message.error}</span>
                      ) : content ? (
                        content
                      ) : live?.reasoning ? (
                        <span className="live-reasoning">
                          {live.reasoning.slice(-1_200)}
                        </span>
                      ) : (
                        live?.progress ||
                        (isLiveAssistant ? "正在等待模型响应" : "")
                      )}
                      {isLiveAssistant && (
                        <small className="live-generation-state">
                          <i />
                          {content
                            ? "继续生成中"
                            : live?.progress || "正在生成"}
                        </small>
                      )}
                      {message.imageCount ? (
                        <small className="attachment-summary">
                          <ImagePlus size={12} />
                          {message.imageCount} 张图片
                        </small>
                      ) : null}
                      {message.files?.length ? (
                        <small className="attachment-summary">
                          <FileText size={12} />
                          {message.files.map((file) => file.name).join("、")}
                        </small>
                      ) : null}
                    </div>
                  </article>
                );
              })}
              {selectedPendingMessages.map((message) => {
                const images = message.command.attachments?.images || [];
                const files = message.command.attachments?.files || [];
                return (
                  <article
                    className={`remote-message user optimistic ${message.status}`}
                    key={message.id}
                  >
                    <div className="message-meta">
                      <span>你</span>
                      <time>{formatTime(message.createdAt)}</time>
                      {message.status === "sending" ? (
                        <span
                          className="delivery-state sending"
                          title="正在发送"
                          aria-label="正在发送"
                        >
                          <LoaderCircle className="spin" size={13} />
                        </span>
                      ) : message.status === "failed" ? (
                        <button
                          type="button"
                          className="delivery-state failed"
                          title={message.error || "发送失败，点击重试"}
                          aria-label={message.error || "发送失败，点击重试"}
                          onClick={() => retryPendingMessage(message)}
                        >
                          <CircleAlert size={15} />
                        </button>
                      ) : (
                        <span
                          className="delivery-state sent"
                          title="已送达电脑"
                          aria-label="已送达电脑"
                        >
                          <Check size={13} />
                        </span>
                      )}
                    </div>
                    <div className="message-body">
                      {message.content || "已发送附件"}
                      {images.length ? (
                        <small className="attachment-summary">
                          <ImagePlus size={12} />
                          {images.length} 张图片
                        </small>
                      ) : null}
                      {files.length ? (
                        <small className="attachment-summary">
                          <FileText size={12} />
                          {files.map((file) => file.name).join("、")}
                        </small>
                      ) : null}
                    </div>
                  </article>
                );
              })}
              {selectedLiveStream &&
                !selectedTask.messages.some(
                  (message) =>
                    message.id === `assistant:${selectedLiveStream.requestId}`,
                ) && (
                  <article className="remote-message assistant live-synthetic">
                    <div className="message-meta">
                      <span>KCode</span>
                      <time>{formatTime(selectedLiveStream.updatedAt)}</time>
                    </div>
                    <div className="message-body">
                      {selectedLiveStream.content ||
                        selectedLiveStream.reasoning?.slice(-1_200) ||
                        selectedLiveStream.progress ||
                        "正在等待模型响应"}
                      <small className="live-generation-state">
                        <i />
                        {selectedLiveStream.content
                          ? "继续生成中"
                          : selectedLiveStream.progress || "正在生成"}
                      </small>
                    </div>
                  </article>
                )}
              {waitingActivity && (
                <div className="approval-panel">
                  <ShieldCheck size={18} />
                  <div>
                    <strong>需要你的确认</strong>
                    <span>{waitingActivity.title}</span>
                  </div>
                  <div className="approval-actions">
                    <button
                      onClick={() =>
                        void sendCommand({
                          type: "task.approve",
                          taskId: selectedTask.id,
                          requestId: waitingActivity.requestId,
                          activityId: waitingActivity.id,
                          allowed: false,
                        })
                      }
                    >
                      拒绝
                    </button>
                    <button
                      className="primary-button compact"
                      onClick={() =>
                        void sendCommand({
                          type: "task.approve",
                          taskId: selectedTask.id,
                          requestId: waitingActivity.requestId,
                          activityId: waitingActivity.id,
                          allowed: true,
                        })
                      }
                    >
                      允许
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div
              className="conversation-scroll-indicator"
              ref={scrollTrackRef}
              hidden
              aria-hidden="true"
            >
              <i ref={scrollThumbRef} />
            </div>
            <form className="mobile-composer" onSubmit={submitMobileMessage}>
              <input
                ref={imageInputRef}
                hidden
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files || []);
                  event.currentTarget.value = "";
                  void selectMobileImages(files);
                }}
              />
              <input
                ref={fileInputRef}
                hidden
                type="file"
                multiple
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files || []);
                  event.currentTarget.value = "";
                  void selectMobileFiles(files);
                }}
              />
              {!!(mobileImages.length || mobileFiles.length) && (
                <div className="mobile-attachment-tray">
                  {mobileImages.map((image) => (
                    <div className="mobile-attachment image" key={image.id}>
                      <img src={image.dataUrl} alt="" />
                      <span>
                        <strong>{image.name}</strong>
                        <small>{formatAttachmentSize(image.size)}</small>
                      </span>
                      <button
                        type="button"
                        title={`移除 ${image.name}`}
                        onClick={() =>
                          setMobileImages((current) =>
                            current.filter((item) => item.id !== image.id),
                          )
                        }
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  {mobileFiles.map((file) => (
                    <div className="mobile-attachment file" key={file.id}>
                      <FileText size={16} />
                      <span>
                        <strong>{file.name}</strong>
                        <small>{formatAttachmentSize(file.size)}</small>
                      </span>
                      <button
                        type="button"
                        title={`移除 ${file.name}`}
                        onClick={() =>
                          setMobileFiles((current) =>
                            current.filter((item) => item.id !== file.id),
                          )
                        }
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mobile-composer-row">
                <button
                  type="button"
                  className="attachment-button"
                  title={`添加图片（${mobileImages.length}/${MAX_MOBILE_IMAGES}）`}
                  disabled={mobileImages.length >= MAX_MOBILE_IMAGES}
                  onClick={() => imageInputRef.current?.click()}
                >
                  <ImagePlus size={17} />
                </button>
                <button
                  type="button"
                  className="attachment-button"
                  title={`添加文件（${mobileFiles.length}/${MAX_MOBILE_FILES}）`}
                  disabled={mobileFiles.length >= MAX_MOBILE_FILES}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip size={17} />
                </button>
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={
                    online
                      ? selectedTask.runningId
                        ? "发送后将排队执行"
                        : "给电脑上的 KCode 发消息"
                      : "电脑离线，发送失败后可点按重试"
                  }
                  rows={1}
                />
                {selectedTask.runningId && (
                  <button
                    type="button"
                    className="stop-button"
                    title="停止任务"
                    onClick={() =>
                      void sendCommand({
                        type: "task.cancel",
                        taskId: selectedTask.id,
                      })
                    }
                  >
                    <Square size={15} fill="currentColor" />
                  </button>
                )}
                <button
                  type="submit"
                  className="send-button"
                  title="发送"
                  disabled={
                    !draft.trim() && !mobileImages.length && !mobileFiles.length
                  }
                >
                  <Send size={16} />
                </button>
              </div>
            </form>
          </>
        ) : (
          <div className="content-empty">
            <FileDiff size={30} />
            <strong>选择一个任务查看详情</strong>
            <span>任务消息和实时输出会在这里同步。</span>
          </div>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname.startsWith("/admin") ? <AdminApp /> : <App />}
  </StrictMode>,
);
