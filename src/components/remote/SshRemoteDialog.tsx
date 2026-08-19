import { useEffect, useState } from "react";
import {
  FolderKey,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Server,
  Trash2,
  X,
} from "lucide-react";
import type {
  SshRemoteAuthType,
  SshRemoteConnectInput,
  SshRemoteProfile,
  SshRemoteState,
} from "../../ssh-remote-types";
import { errorMessage } from "../../lib/format";

export function SshRemoteDialog({
  taskId,
  initialProfile,
  onConnected,
  onClose,
}: {
  taskId: string;
  initialProfile?: SshRemoteProfile;
  onConnected(state: SshRemoteState): void;
  onClose(): void;
}) {
  const [profiles, setProfiles] = useState<SshRemoteProfile[]>([]);
  const [name, setName] = useState(initialProfile?.name ?? "");
  const [host, setHost] = useState(initialProfile?.host ?? "");
  const [port, setPort] = useState(String(initialProfile?.port ?? 22));
  const [username, setUsername] = useState(initialProfile?.username ?? "");
  const [rootPath, setRootPath] = useState(initialProfile?.rootPath ?? "~");
  const [authType, setAuthType] = useState<SshRemoteAuthType>(
    initialProfile?.authType ?? "private-key",
  );
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const [confirmingProfile, setConfirmingProfile] = useState<string>();

  useEffect(() => {
    let active = true;
    void window.kcode.sshRemote
      .profiles()
      .then((items) => active && setProfiles(items))
      .catch((reason) => active && setError(errorMessage(reason)));
    return () => {
      active = false;
    };
  }, []);

  async function useProfile(profile: SshRemoteProfile) {
    setBusy(profile.id);
    setError("");
    try {
      onConnected(
        await window.kcode.sshRemote.connectSaved(
          taskId,
          profile.id,
          initialProfile?.id === profile.id
            ? initialProfile.rootPath
            : profile.rootPath,
        ),
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(undefined);
    }
  }

  async function connect() {
    const numericPort = Number(port);
    if (!host.trim() || !username.trim()) {
      setError("请填写服务器地址和用户名。");
      return;
    }
    if (
      !Number.isInteger(numericPort) ||
      numericPort < 1 ||
      numericPort > 65_535
    ) {
      setError("SSH 端口必须是 1 到 65535 之间的整数。");
      return;
    }
    if (authType === "password" && !password) {
      setError("请输入 SSH 密码。");
      return;
    }
    if (authType === "private-key" && !privateKeyPath) {
      setError("请选择 SSH 私钥文件。");
      return;
    }
    const input: SshRemoteConnectInput = {
      taskId,
      profileId: initialProfile?.id,
      name,
      host,
      port: numericPort,
      username,
      rootPath,
      authType,
      password: authType === "password" ? password : undefined,
      privateKeyPath: authType === "private-key" ? privateKeyPath : undefined,
      passphrase: authType === "private-key" ? passphrase : undefined,
      remember,
    };
    setBusy("connect");
    setError("");
    try {
      onConnected(await window.kcode.sshRemote.connect(input));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(undefined);
    }
  }

  async function forgetProfile(profileId: string) {
    if (confirmingProfile !== profileId) {
      setConfirmingProfile(profileId);
      return;
    }
    setBusy(`forget:${profileId}`);
    setError("");
    try {
      setProfiles(await window.kcode.sshRemote.forget(profileId));
      setConfirmingProfile(undefined);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="ssh-remote-dialog-layer" role="presentation">
      <section
        className="ssh-remote-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-remote-title"
      >
        <header>
          <span className="ssh-remote-dialog-icon">
            <Server size={18} />
          </span>
          <span>
            <strong id="ssh-remote-title">SSH Remote</strong>
            <small>
              {initialProfile ? "重新验证远程工作区凭据" : "连接远程工作区"}
            </small>
          </span>
          <button
            type="button"
            title="关闭"
            aria-label="关闭 SSH Remote"
            disabled={Boolean(busy)}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>

        {profiles.length > 0 && (
          <div className="ssh-saved-profiles">
            <strong>已保存</strong>
            <div>
              {profiles.map((profile) => (
                <article key={profile.id}>
                  <button
                    type="button"
                    className="ssh-saved-profile-main"
                    disabled={Boolean(busy)}
                    onClick={() => void useProfile(profile)}
                  >
                    <Server size={15} />
                    <span>
                      <strong>{profile.name}</strong>
                      <small>
                        {profile.username}@{profile.host}:{profile.port}
                      </small>
                    </span>
                    {busy === profile.id && (
                      <LoaderCircle className="spinning" size={14} />
                    )}
                  </button>
                  <button
                    type="button"
                    className={
                      confirmingProfile === profile.id ? "confirming" : ""
                    }
                    title={
                      confirmingProfile === profile.id
                        ? "再次点击确认删除"
                        : "删除已保存连接"
                    }
                    aria-label={`删除连接 ${profile.name}`}
                    disabled={Boolean(busy)}
                    onClick={() => void forgetProfile(profile.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </article>
              ))}
            </div>
          </div>
        )}

        <div className="ssh-remote-form">
          <label className="ssh-field ssh-field-wide">
            <span>名称</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="生产服务器"
              maxLength={160}
            />
          </label>
          <label className="ssh-field ssh-field-host">
            <span>服务器</span>
            <input
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="example.com"
              autoComplete="off"
            />
          </label>
          <label className="ssh-field ssh-field-port">
            <span>端口</span>
            <input
              value={port}
              inputMode="numeric"
              onChange={(event) => setPort(event.target.value)}
            />
          </label>
          <label className="ssh-field">
            <span>用户名</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="ssh-field">
            <span>远程目录</span>
            <input
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              placeholder="~/project"
            />
          </label>
          <div
            className="ssh-auth-mode ssh-field-wide"
            role="group"
            aria-label="认证方式"
          >
            <button
              type="button"
              className={authType === "private-key" ? "active" : ""}
              onClick={() => setAuthType("private-key")}
            >
              <KeyRound size={14} />
              私钥
            </button>
            <button
              type="button"
              className={authType === "password" ? "active" : ""}
              onClick={() => setAuthType("password")}
            >
              <LockKeyhole size={14} />
              密码
            </button>
          </div>
          {authType === "password" ? (
            <label className="ssh-field ssh-field-wide">
              <span>密码</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </label>
          ) : (
            <>
              <label className="ssh-field ssh-field-key">
                <span>私钥文件</span>
                <span className="ssh-key-picker">
                  <input
                    value={privateKeyPath}
                    readOnly
                    placeholder="选择私钥"
                  />
                  <button
                    type="button"
                    title="选择私钥文件"
                    onClick={() =>
                      void window.kcode.sshRemote
                        .pickPrivateKey()
                        .then((value) => value && setPrivateKeyPath(value))
                    }
                  >
                    <FolderKey size={14} />
                  </button>
                </span>
              </label>
              <label className="ssh-field">
                <span>私钥口令</span>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  placeholder="可选"
                  autoComplete="off"
                />
              </label>
            </>
          )}
          <label className="ssh-remember ssh-field-wide">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>记住连接</span>
          </label>
        </div>

        {error && <div className="ssh-remote-error">{error}</div>}
        <footer>
          <button type="button" disabled={Boolean(busy)} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={Boolean(busy)}
            onClick={() => void connect()}
          >
            {busy === "connect" ? (
              <LoaderCircle className="spinning" size={14} />
            ) : (
              <Server size={14} />
            )}
            连接并打开
          </button>
        </footer>
      </section>
    </div>
  );
}
