export const PRODUCTION_APP_USER_MODEL_ID = "com.kcode.desktop";

export function windowsAppUserModelId(isPackaged: boolean) {
  return isPackaged
    ? PRODUCTION_APP_USER_MODEL_ID
    : `${PRODUCTION_APP_USER_MODEL_ID}.dev`;
}

export function isLegacyDevelopmentShortcut(shortcut: {
  appUserModelId?: string;
  target?: string;
}) {
  const targetName =
    shortcut.target?.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() || "";
  return (
    shortcut.appUserModelId === PRODUCTION_APP_USER_MODEL_ID &&
    targetName === "electron.exe"
  );
}
