import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  FileCode2,
  LockOpen,
  ShieldCheck,
} from "lucide-react";
import type { PermissionMode } from "../../types";

const permissionOptions: Array<{
  mode: PermissionMode;
  label: string;
  description: string;
}> = [
  {
    mode: "confirm",
    label: "变更前确认",
    description: "写文件和运行命令前询问",
  },
  {
    mode: "read-only",
    label: "只读模式",
    description: "仅允许读取和分析工作区",
  },
  {
    mode: "full-access",
    label: "完全访问",
    description: "直接写文件和运行命令",
  },
];

function PermissionIcon({
  mode,
  size = 14,
}: {
  mode: PermissionMode;
  size?: number;
}) {
  if (mode === "full-access") return <LockOpen size={size} />;
  if (mode === "read-only") return <FileCode2 size={size} />;
  return <ShieldCheck size={size} />;
}

export function PermissionPicker({
  mode,
  disabled,
  onChange,
}: {
  mode: PermissionMode;
  disabled?: boolean;
  onChange(mode: PermissionMode): void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = permissionOptions.find((option) => option.mode === mode)!;

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="permission-picker" ref={rootRef}>
      <button
        type="button"
        className="permission-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={`操作权限：${current.label}`}
        onClick={() => setOpen((value) => !value)}
      >
        <PermissionIcon mode={mode} />
        <span>{current.label}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="permission-menu" role="menu" aria-label="操作权限">
          <header>操作权限</header>
          {permissionOptions.map((option) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={mode === option.mode}
              className={mode === option.mode ? "active" : ""}
              key={option.mode}
              onClick={() => {
                onChange(option.mode);
                setOpen(false);
              }}
            >
              <PermissionIcon mode={option.mode} size={15} />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              {mode === option.mode && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
