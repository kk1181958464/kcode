import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

const savedTheme = localStorage.getItem("kcode.theme");
const initialTheme =
  savedTheme === "light" || savedTheme === "dark"
    ? savedTheme
    : savedTheme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : "dark";
document.documentElement.dataset.theme = initialTheme;
document.documentElement.style.colorScheme = initialTheme;

// Leave the splash as soon as the first React frame is painted. The minimum
// dwell is measured from navigation start (not from "ready"), so a fast start
// is not padded — it only avoids a sub-half-second flash on very fast loads.
let bootDismissScheduled = false;
const BOOT_SPLASH_MIN_MS = 450;

function dismissBootSplash() {
  const splash = document.getElementById("kcode-boot");
  if (!splash || bootDismissScheduled) return;
  bootDismissScheduled = true;
  const remaining = Math.max(0, BOOT_SPLASH_MIN_MS - performance.now());
  window.setTimeout(() => {
    if (!splash.isConnected) return;
    splash.classList.add("is-leaving");
    splash.setAttribute("aria-busy", "false");
    const remove = () => {
      if (splash.isConnected) splash.remove();
    };
    splash.addEventListener("transitionend", remove, { once: true });
    window.setTimeout(remove, 400);
  }, remaining);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

requestAnimationFrame(() => {
  requestAnimationFrame(dismissBootSplash);
});
