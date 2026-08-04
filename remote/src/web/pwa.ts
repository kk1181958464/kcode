import { registerSW } from "virtual:pwa-register";

const UPDATE_INTERVAL_MS = 3 * 60 * 1000;
const updateListeners = new Set<() => void>();
let updateReady = false;

function notifyUpdateReady() {
  updateReady = true;
  for (const listener of updateListeners) listener();
}

export function subscribePwaUpdate(listener: () => void) {
  updateListeners.add(listener);
  if (updateReady) queueMicrotask(listener);
  return () => updateListeners.delete(listener);
}

export function registerPwa() {
  if (!("serviceWorker" in navigator)) return;

  registerSW({
    immediate: true,
    onNeedReload: notifyUpdateReady,
    onRegisteredSW(_serviceWorkerUrl, registration) {
      if (!registration) return;

      const checkForUpdate = () => {
        if (!navigator.onLine || document.visibilityState !== "visible") return;
        void registration.update();
      };

      window.setInterval(checkForUpdate, UPDATE_INTERVAL_MS);
      window.addEventListener("online", checkForUpdate);
      document.addEventListener("visibilitychange", checkForUpdate);
    },
  });
}
