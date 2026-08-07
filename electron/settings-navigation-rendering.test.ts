import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPanel } from "../src/components/settings/SettingsPanel";
import type { RemoteControlState } from "../src/remote-types";

Object.assign(globalThis, { React });

function renderSettings(connected: boolean) {
  const remoteControlState: RemoteControlState = {
    configured: true,
    enabled: true,
    connected,
    connectionPhase: connected ? "online" : "connecting",
    serverUrl: "https://kcode.example.com",
    username: "tester",
    deviceId: "device-1",
    deviceName: "Desktop",
  };
  return renderToStaticMarkup(
    React.createElement(SettingsPanel, {
      providers: [],
      setProviders() {},
      initialSection: "remote",
      reasoningEfforts: ["auto"],
      defaultReasoningEffort: "auto",
      onDefaultReasoningEffortChange() {},
      autoFollowEnabled: true,
      onAutoFollowChange() {},
      statusPanelEnabled: true,
      onStatusPanelChange() {},
      contextDirectory: "",
      async onPickContextDirectory() {
        return null;
      },
      onClearContextDirectory() {},
      theme: "light",
      onThemeChange() {},
      accent: "indigo",
      onAccentChange() {},
      permissionMode: "confirm",
      onPermissionModeChange() {},
      permissionPolicy: {
        workspaceWrite: "confirm",
        deletePaths: "confirm",
        runCommands: "confirm",
        longRunningProcesses: "confirm",
        network: "confirm",
        gitPublish: "confirm",
      },
      onPermissionPolicyChange() {},
      remoteControlState,
      onRemoteControlStateChange() {},
      onClose() {},
    }),
  );
}

test("renders compact status and count markers in settings navigation", () => {
  const markup = renderSettings(true);
  const navigation = markup.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

  assert.match(navigation, /settings-nav-status-dot online/);
  assert.equal(
    navigation.match(/class="settings-nav-count">0<\/span>/g)?.length,
    3,
  );
  assert.doesNotMatch(navigation, />在线<|>离线<|<small/);
});

test("keeps the remote summary stable while reconnecting", () => {
  const online = renderSettings(true);
  const reconnecting = renderSettings(false);

  assert.match(online, /远程控制已开启/);
  assert.match(reconnecting, /远程控制已开启/);
  assert.match(reconnecting, /settings-nav-status-dot offline/);
  assert.doesNotMatch(
    `${online}${reconnecting}`,
    /手机可以控制这台电脑|正在连接远程服务/,
  );
});
