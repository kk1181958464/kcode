import { useEffect, useRef, useState } from "react";
import type {
  RemoteCommandEnvelope,
  RemoteControlState,
} from "../remote-types";
import { remoteTaskSnapshot } from "../remote-snapshot";
import { type TaskRecord } from "../models";
import { errorMessage } from "../lib/format";

type RemoteControlBindings = {
  tasks: TaskRecord[];
  taskStorageReady: boolean;
};

export function useRemoteControl({
  tasks,
  taskStorageReady,
}: RemoteControlBindings) {
  const [remoteControlState, setRemoteControlState] =
    useState<RemoteControlState>(() => ({
      configured: false,
      enabled: false,
      connected: false,
      connectionPhase: "disabled",
      serverUrl: "",
      deviceId: "",
      deviceName: "",
    }));
  const remoteCommandHandlerRef = useRef<
    (envelope: RemoteCommandEnvelope) => void
  >(() => undefined);
  const remoteSyncTimerRef = useRef<number | undefined>(undefined);
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
  return { remoteControlState, setRemoteControlState, remoteCommandHandlerRef };
}
