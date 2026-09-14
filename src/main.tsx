import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "katex/dist/katex.min.css";
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

// Dwell starts when the app is ready to leave the splash — not at module load.
// Importing styles/katex can already take >1.5s; counting from import made the
// splash vanish immediately after first paint of the React tree.
let bootDismissScheduled = false;
const BOOT_SPLASH_MIN_MS = 2_500;

function dismissBootSplash() {
  const splash = document.getElementById("kcode-boot");
  if (!splash || bootDismissScheduled) return;
  bootDismissScheduled = true;
  window.setTimeout(() => {
    if (!splash.isConnected) return;
    splash.classList.add("is-leaving");
    splash.setAttribute("aria-busy", "false");
    const remove = () => {
      if (splash.isConnected) splash.remove();
    };
    splash.addEventListener("transitionend", remove, { once: true });
    window.setTimeout(remove, 700);
  }, BOOT_SPLASH_MIN_MS);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

requestAnimationFrame(() => {
  requestAnimationFrame(dismissBootSplash);
});
