import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Database,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Monitor,
  Radio,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";

type AdminUser = { id: string; username: string };
type AdminView = "overview" | "users" | "devices" | "commands";
type AdminSnapshot = {
  viewer: AdminUser;
  service: {
    ok: boolean;
    release: string;
    startedAt: number;
    uptimeMs: number;
    serverTime: number;
    registrationOpen: boolean;
    databaseBytes: number;
    connections: { total: number; desktop: number; mobile: number };
  };
  totals: {
    users: number;
    activeSessions: number;
    devices: number;
    onlineDevices: number;
    tasks: number;
    configuredAccounts: number;
    commands24h: number;
    failedCommands24h: number;
  };
  users: Array<{
    id: string;
    username: string;
    createdAt: number;
    isAdmin: boolean;
    activeSessions: number;
    devices: number;
    onlineDevices: number;
    tasks: number;
    configured: boolean;
    configUpdatedAt?: number;
    lastSeen?: number;
  }>;
  devices: Array<{
    id: string;
    userId: string;
    username: string;
    name: string;
    platform: string;
    version: string;
    online: boolean;
    lastSeen: number;
    createdAt: number;
    tasks: number;
  }>;
  commands: Array<{
    id: string;
    username: string;
    deviceName: string;
    commandType: string;
    status: string;
    createdAt: number;
    updatedAt: number;
    durationMs: number;
    error?: string;
  }>;
};

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function adminRequest<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    credentials: "same-origin",
  });
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok)
    throw new RequestError(response.status, body.error || "请求失败");
  return body;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value?: number) {
  if (!value) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function formatDuration(value: number) {
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} 秒`;
  if (value < 3_600_000) return `${Math.floor(value / 60_000)} 分钟`;
  if (value < 86_400_000)
    return `${Math.floor(value / 3_600_000)} 小时 ${Math.floor((value % 3_600_000) / 60_000)} 分`;
  return `${Math.floor(value / 86_400_000)} 天 ${Math.floor((value % 86_400_000) / 3_600_000)} 小时`;
}

function commandLabel(type: string) {
  return (
    {
      "task.load": "打开任务",
      "task.send": "发送消息",
      "task.cancel": "停止任务",
      "task.approve": "处理确认",
      unreadable: "记录不可读",
      unknown: "未知命令",
    }[type] || type
  );
}

function commandStatus(status: string) {
  return (
    {
      sent: "已发送",
      completed: "已完成",
      failed: "失败",
    }[status] || status
  );
}

function AdminLogin({
  registrationOpen,
  onAuthenticated,
}: {
  registrationOpen: boolean;
  onAuthenticated(user: AdminUser): void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await adminRequest<{ user: AdminUser }>(
        registrationOpen ? "/api/auth/register" : "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ username, password, clientType: "mobile" }),
        },
      );
      const session = await adminRequest<{ user: AdminUser }>(
        "/api/admin/session",
      );
      onAuthenticated(session.user);
    } catch (cause) {
      if (cause instanceof RequestError && cause.status === 403)
        await adminRequest("/api/auth/logout", { method: "POST" }).catch(
          () => undefined,
        );
      setError(cause instanceof Error ? cause.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="admin-auth-shell">
      <section className="admin-auth-panel">
        <img src="/kcode-icon.png" alt="KCode" />
        <div className="admin-auth-heading">
          <p className="eyebrow">KCODE SERVER</p>
          <h1>{registrationOpen ? "创建管理员账号" : "登录管理后台"}</h1>
          <p>kcode.98104.cn</p>
        </div>
        <form className="auth-form" onSubmit={submit}>
          <label>
            <span>管理员账号</span>
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              autoComplete={
                registrationOpen ? "new-password" : "current-password"
              }
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={10}
              required
            />
          </label>
          {error && (
            <div className="form-error" role="alert">
              <CircleAlert size={15} />
              {error}
            </div>
          )}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <ShieldCheck size={16} />
            )}
            {busy
              ? "正在验证"
              : registrationOpen
                ? "创建并进入后台"
                : "进入后台"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Stat({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone?: "success" | "danger" | "accent";
}) {
  return (
    <article className={`admin-stat ${tone || ""}`}>
      <span className="admin-stat-icon">{icon}</span>
      <span className="admin-stat-copy">
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
    </article>
  );
}

function Overview({ snapshot }: { snapshot: AdminSnapshot }) {
  const failures = snapshot.commands.filter(
    (command) => command.status === "failed",
  );
  const onlineDevices = snapshot.devices.filter((device) => device.online);
  const failureRate = snapshot.totals.commands24h
    ? Math.round(
        (snapshot.totals.failedCommands24h / snapshot.totals.commands24h) * 100,
      )
    : 0;
  return (
    <div className="admin-view">
      <section className="admin-service-band">
        <span className="service-live-mark">
          <Activity size={17} />
        </span>
        <div>
          <strong>中转服务运行正常</strong>
          <span>
            已连续运行 {formatDuration(snapshot.service.uptimeMs)} · 版本{" "}
            {snapshot.service.release}
          </span>
        </div>
        <dl>
          <div>
            <dt>实时连接</dt>
            <dd>{snapshot.service.connections.total}</dd>
          </div>
          <div>
            <dt>服务器时间</dt>
            <dd>{formatDate(snapshot.service.serverTime)}</dd>
          </div>
        </dl>
      </section>

      <section className="admin-stats-grid" aria-label="服务概览">
        <Stat
          icon={<Users size={17} />}
          label="账号"
          value={formatNumber(snapshot.totals.users)}
          detail={`${snapshot.totals.activeSessions} 个有效会话`}
          tone="accent"
        />
        <Stat
          icon={<Monitor size={17} />}
          label="电脑设备"
          value={`${snapshot.totals.onlineDevices} / ${snapshot.totals.devices}`}
          detail="当前在线 / 全部设备"
          tone="success"
        />
        <Stat
          icon={<Terminal size={17} />}
          label="远程任务"
          value={formatNumber(snapshot.totals.tasks)}
          detail={`${snapshot.totals.commands24h} 条今日命令`}
        />
        <Stat
          icon={<CircleAlert size={17} />}
          label="今日失败"
          value={formatNumber(snapshot.totals.failedCommands24h)}
          detail={`${failureRate}% 命令失败率`}
          tone={snapshot.totals.failedCommands24h ? "danger" : "success"}
        />
      </section>

      <section className="admin-overview-grid">
        <article className="admin-panel">
          <header className="admin-panel-heading">
            <span>
              <Radio size={15} />
              当前连接
            </span>
            <small>{snapshot.service.connections.total} 个</small>
          </header>
          <div className="connection-breakdown">
            <div>
              <Monitor size={17} />
              <span>
                <strong>{snapshot.service.connections.desktop}</strong>
                <small>电脑端</small>
              </span>
            </div>
            <div>
              <Wifi size={17} />
              <span>
                <strong>{snapshot.service.connections.mobile}</strong>
                <small>手机端</small>
              </span>
            </div>
            <div>
              <Database size={17} />
              <span>
                <strong>{formatBytes(snapshot.service.databaseBytes)}</strong>
                <small>数据占用</small>
              </span>
            </div>
          </div>
          <div className="admin-compact-list">
            {onlineDevices.map((device) => (
              <div key={`${device.userId}:${device.id}`}>
                <span className="online-dot" />
                <span>
                  <strong>{device.name}</strong>
                  <small>
                    {device.username} · {device.platform} · {device.version}
                  </small>
                </span>
                <em>{device.tasks} 个任务</em>
              </div>
            ))}
            {!onlineDevices.length && (
              <div className="admin-inline-empty">
                <WifiOff size={16} />
                当前没有在线电脑
              </div>
            )}
          </div>
        </article>

        <article className="admin-panel">
          <header className="admin-panel-heading">
            <span>
              <CircleAlert size={15} />
              最近失败
            </span>
            <small>{failures.length} 条记录</small>
          </header>
          <div className="admin-compact-list failure-list">
            {failures.slice(0, 6).map((command) => (
              <div key={command.id}>
                <span className="failed-dot" />
                <span>
                  <strong>{commandLabel(command.commandType)}</strong>
                  <small>
                    {command.username} · {command.deviceName}
                  </small>
                  {command.error && <p>{command.error}</p>}
                </span>
                <time>{formatDate(command.createdAt)}</time>
              </div>
            ))}
            {!failures.length && (
              <div className="admin-inline-empty success">
                <CheckCircle2 size={16} />
                最近命令没有失败记录
              </div>
            )}
          </div>
        </article>
      </section>
    </div>
  );
}

function UsersView({ snapshot }: { snapshot: AdminSnapshot }) {
  return (
    <section className="admin-table-panel">
      <header className="admin-section-heading">
        <div>
          <h2>账号</h2>
          <p>{snapshot.users.length} 个已注册账号</p>
        </div>
      </header>
      <div className="admin-table-scroll">
        <table className="admin-table">
          <thead>
            <tr>
              <th>账号</th>
              <th>最近在线</th>
              <th>有效会话</th>
              <th>电脑</th>
              <th>任务</th>
              <th>模型配置</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.users.map((user) => (
              <tr key={user.id}>
                <td>
                  <span className="admin-user-cell">
                    <span>{user.username.slice(0, 1).toUpperCase()}</span>
                    <strong>{user.username}</strong>
                    {user.isAdmin && <em>管理员</em>}
                  </span>
                </td>
                <td>{formatDate(user.lastSeen)}</td>
                <td>{user.activeSessions}</td>
                <td>
                  <span className={user.onlineDevices ? "table-online" : ""}>
                    {user.onlineDevices} / {user.devices}
                  </span>
                </td>
                <td>{user.tasks}</td>
                <td>
                  <span
                    className={`table-state ${user.configured ? "configured" : ""}`}
                  >
                    {user.configured ? "已同步" : "未同步"}
                  </span>
                </td>
                <td>{formatDate(user.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DevicesView({ snapshot }: { snapshot: AdminSnapshot }) {
  return (
    <section className="admin-table-panel">
      <header className="admin-section-heading">
        <div>
          <h2>电脑设备</h2>
          <p>
            {snapshot.totals.onlineDevices} 台在线，共 {snapshot.devices.length}{" "}
            台
          </p>
        </div>
      </header>
      <div className="admin-table-scroll">
        <table className="admin-table">
          <thead>
            <tr>
              <th>设备</th>
              <th>所属账号</th>
              <th>状态</th>
              <th>系统</th>
              <th>客户端版本</th>
              <th>任务</th>
              <th>最后连接</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.devices.map((device) => (
              <tr key={`${device.userId}:${device.id}`}>
                <td>
                  <span className="admin-device-cell">
                    <Monitor size={15} />
                    <strong>{device.name}</strong>
                  </span>
                </td>
                <td>{device.username}</td>
                <td>
                  <span
                    className={`table-state ${device.online ? "online" : ""}`}
                  >
                    {device.online ? "在线" : "离线"}
                  </span>
                </td>
                <td>{device.platform}</td>
                <td>{device.version}</td>
                <td>{device.tasks}</td>
                <td>{formatDate(device.lastSeen)}</td>
              </tr>
            ))}
            {!snapshot.devices.length && (
              <tr>
                <td colSpan={7} className="admin-table-empty">
                  还没有电脑连接到服务器
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CommandsView({ snapshot }: { snapshot: AdminSnapshot }) {
  return (
    <section className="admin-table-panel">
      <header className="admin-section-heading">
        <div>
          <h2>远程命令</h2>
          <p>最近 {snapshot.commands.length} 条执行记录</p>
        </div>
      </header>
      <div className="admin-table-scroll">
        <table className="admin-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>命令</th>
              <th>账号</th>
              <th>电脑</th>
              <th>状态</th>
              <th>耗时</th>
              <th>失败原因</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.commands.map((command) => (
              <tr key={command.id}>
                <td>{formatDate(command.createdAt)}</td>
                <td>
                  <code>{commandLabel(command.commandType)}</code>
                </td>
                <td>{command.username}</td>
                <td>{command.deviceName}</td>
                <td>
                  <span className={`command-state ${command.status}`}>
                    {commandStatus(command.status)}
                  </span>
                </td>
                <td>{formatDuration(command.durationMs)}</td>
                <td className="command-error-cell">{command.error || "-"}</td>
              </tr>
            ))}
            {!snapshot.commands.length && (
              <tr>
                <td colSpan={7} className="admin-table-empty">
                  还没有远程命令记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const navigation: Array<{
  id: AdminView;
  label: string;
  icon: React.ReactNode;
}> = [
  { id: "overview", label: "概览", icon: <LayoutDashboard size={16} /> },
  { id: "users", label: "账号", icon: <Users size={16} /> },
  { id: "devices", label: "设备", icon: <Monitor size={16} /> },
  { id: "commands", label: "命令", icon: <Terminal size={16} /> },
];

export function AdminApp() {
  const [user, setUser] = useState<AdminUser>();
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<AdminSnapshot>();
  const [view, setView] = useState<AdminView>("overview");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const title = useMemo(
    () => navigation.find((item) => item.id === view)?.label || "概览",
    [view],
  );

  async function loadSnapshot(background = false) {
    if (!background) setRefreshing(true);
    try {
      const next = await adminRequest<AdminSnapshot>("/api/admin/overview");
      setSnapshot(next);
      setError("");
    } catch (cause) {
      if (cause instanceof RequestError && cause.status === 401) {
        setUser(undefined);
        setSnapshot(undefined);
      } else
        setError(cause instanceof Error ? cause.message : "后台数据加载失败");
    } finally {
      if (!background) setRefreshing(false);
    }
  }

  useEffect(() => {
    document.title = "KCode 管理后台";
    void (async () => {
      try {
        const session = await adminRequest<{ user: AdminUser }>(
          "/api/admin/session",
        );
        setUser(session.user);
      } catch {
        const health = await adminRequest<{ registrationOpen: boolean }>(
          "/api/health",
        );
        setRegistrationOpen(health.registrationOpen);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!user) return;
    void loadSnapshot();
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadSnapshot(true);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [user]);

  async function logout() {
    await adminRequest("/api/auth/logout", { method: "POST" }).catch(
      () => undefined,
    );
    setUser(undefined);
    setSnapshot(undefined);
    setRegistrationOpen(false);
  }

  if (loading)
    return (
      <main className="loading-shell">
        <LoaderCircle className="spin" size={22} />
        <span>正在连接管理后台</span>
      </main>
    );
  if (!user)
    return (
      <AdminLogin
        registrationOpen={registrationOpen}
        onAuthenticated={(nextUser) => {
          setUser(nextUser);
          setRegistrationOpen(false);
        }}
      />
    );

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <a className="admin-brand" href="/admin" aria-label="KCode 管理后台">
          <img src="/kcode-icon.png" alt="" />
          <span>
            <strong>KCode</strong>
            <small>Server Console</small>
          </span>
        </a>
        <nav aria-label="管理后台导航">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "active" : ""}
              onClick={() => setView(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.id === "devices" && snapshot && (
                <em>{snapshot.totals.onlineDevices}</em>
              )}
              {item.id === "commands" &&
                snapshot &&
                snapshot.totals.failedCommands24h > 0 && (
                  <em className="danger">
                    {snapshot.totals.failedCommands24h}
                  </em>
                )}
            </button>
          ))}
        </nav>
        <div className="admin-sidebar-status">
          <span className="online-dot" />
          <span>
            <strong>服务在线</strong>
            <small>{snapshot?.service.release || "正在读取版本"}</small>
          </span>
        </div>
        <div className="admin-account">
          <span>{user.username.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{user.username}</strong>
            <small>管理员</small>
          </div>
          <button title="退出登录" onClick={() => void logout()}>
            <LogOut size={15} />
          </button>
        </div>
      </aside>

      <section className="admin-main">
        <header className="admin-topbar">
          <div>
            <p className="eyebrow">SERVER CONTROL</p>
            <h1>{title}</h1>
          </div>
          <div className="admin-topbar-actions">
            {snapshot && (
              <span className="admin-refresh-time">
                <Clock3 size={13} />
                {formatDate(snapshot.service.serverTime)}
              </span>
            )}
            <button
              className="admin-refresh-button"
              title="刷新后台数据"
              onClick={() => void loadSnapshot()}
              disabled={refreshing}
            >
              <RefreshCw className={refreshing ? "spin" : ""} size={15} />
              刷新
            </button>
          </div>
        </header>
        {error && (
          <div className="admin-error" role="alert">
            <CircleAlert size={15} />
            <span>{error}</span>
            <button onClick={() => void loadSnapshot()}>重试</button>
          </div>
        )}
        <div className="admin-content">
          {!snapshot ? (
            <div className="admin-loading-panel">
              <LoaderCircle className="spin" size={20} />
              读取服务器数据
            </div>
          ) : view === "overview" ? (
            <Overview snapshot={snapshot} />
          ) : view === "users" ? (
            <UsersView snapshot={snapshot} />
          ) : view === "devices" ? (
            <DevicesView snapshot={snapshot} />
          ) : (
            <CommandsView snapshot={snapshot} />
          )}
        </div>
      </section>
    </main>
  );
}
