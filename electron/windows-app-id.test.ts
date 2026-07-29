import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCTION_APP_USER_MODEL_ID,
  isLegacyDevelopmentShortcut,
  windowsAppUserModelId,
} from "./windows-app-id";

test("keeps development taskbar identity separate from packaged KCode", () => {
  assert.equal(windowsAppUserModelId(true), PRODUCTION_APP_USER_MODEL_ID);
  assert.equal(
    windowsAppUserModelId(false),
    `${PRODUCTION_APP_USER_MODEL_ID}.dev`,
  );
});

test("only recognizes Electron shortcuts that hijack the production identity", () => {
  assert.equal(
    isLegacyDevelopmentShortcut({
      appUserModelId: PRODUCTION_APP_USER_MODEL_ID,
      target: "D:\\project\\kcode\\node_modules\\electron\\electron.exe",
    }),
    true,
  );
  assert.equal(
    isLegacyDevelopmentShortcut({
      appUserModelId: PRODUCTION_APP_USER_MODEL_ID,
      target: "D:\\kcode\\KCode.exe",
    }),
    false,
  );
  assert.equal(
    isLegacyDevelopmentShortcut({
      appUserModelId: `${PRODUCTION_APP_USER_MODEL_ID}.dev`,
      target: "D:\\project\\electron.exe",
    }),
    false,
  );
});
