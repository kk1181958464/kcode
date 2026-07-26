import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type {
  AppUpdateState,
  PermissionMode,
  PermissionPolicy,
  ReasoningEffort,
} from "../types";
import type { SettingsSection } from "../models";
import { policyForMode, savedEfforts, normalizeEffort } from "../lib/model-utils";

export interface SettingsState {
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  openSettings(section: SettingsSection): void;
  closeSettings(): void;

  autoFollowEnabled: boolean;
  updateAutoFollow(value: boolean): void;

  statusOpen: boolean;
  updateStatusPanel(value: boolean): void;

  permissionMode: PermissionMode;
  updatePermissionMode(value: PermissionMode): void;
  permissionPolicy: PermissionPolicy;
  updatePermissionPolicy(value: PermissionPolicy): void;

  appUpdate: AppUpdateState;
  updateOpen: boolean;
  setUpdateOpen(value: boolean): void;

  defaultReasoningEffort: ReasoningEffort;
  updateDefaultReasoningEffort(value: ReasoningEffort, efforts: ReasoningEffort[]): void;
}

const SettingsContext = createContext<SettingsState | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const [statusOpen, setStatusOpen] = useState(
    () => localStorage.getItem("kcode.statusPanel") !== "false",
  );
  const [updateOpen, setUpdateOpen] = useState(false);
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>({
    status: "idle",
    currentVersion: "",
    portable: false,
  });
  const [defaultReasoningEffort, setDefaultReasoningEffort] =
    useState<ReasoningEffort>(() => {
      const saved = localStorage.getItem("kcode.defaultReasoningEffort");
      return savedEfforts.includes(saved as ReasoningEffort)
        ? (saved as ReasoningEffort)
        : "auto";
    });

  useEffect(() => {
    let active = true;
    void window.kcode.updater.state().then((state) => {
      if (active) setAppUpdate(state);
    });
    const unsubscribe = window.kcode.updater.onState((state) => {
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

  const openSettings = useCallback((section: SettingsSection) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const updateAutoFollow = useCallback((value: boolean) => {
    setAutoFollowEnabled(value);
    localStorage.setItem("kcode.autoFollow", String(value));
  }, []);

  const updateStatusPanel = useCallback((value: boolean) => {
    setStatusOpen(value);
    localStorage.setItem("kcode.statusPanel", String(value));
  }, []);

  const updatePermissionMode = useCallback((value: PermissionMode) => {
    setPermissionMode(value);
    localStorage.setItem("kcode.permissionMode", value);
    const policy = policyForMode(value);
    setPermissionPolicy(policy);
    localStorage.setItem("kcode.permissionPolicy", JSON.stringify(policy));
  }, []);

  const updatePermissionPolicy = useCallback((value: PermissionPolicy) => {
    setPermissionPolicy(value);
    localStorage.setItem("kcode.permissionPolicy", JSON.stringify(value));
  }, []);

  const updateDefaultReasoningEffort = useCallback(
    (value: ReasoningEffort, efforts: ReasoningEffort[]) => {
      setDefaultReasoningEffort(value);
      localStorage.setItem("kcode.defaultReasoningEffort", value);
    },
    [],
  );

  return (
    <SettingsContext.Provider
      value={{
        settingsOpen,
        settingsSection,
        openSettings,
        closeSettings,
        autoFollowEnabled,
        updateAutoFollow,
        statusOpen,
        updateStatusPanel,
        permissionMode,
        updatePermissionMode,
        permissionPolicy,
        updatePermissionPolicy,
        appUpdate,
        updateOpen,
        setUpdateOpen,
        defaultReasoningEffort,
        updateDefaultReasoningEffort,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsState {
  const context = useContext(SettingsContext);
  if (!context)
    throw new Error("useSettings must be used within a SettingsProvider");
  return context;
}
