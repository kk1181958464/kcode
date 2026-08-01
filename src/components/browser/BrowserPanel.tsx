import {
  ArrowLeft,
  ArrowRight,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  ShieldAlert,
  LoaderCircle,
  X,
} from "lucide-react";

interface BrowserState {
  open: boolean;
  hidden?: boolean;
  sessionId?: string;
  requestId?: string;
  title?: string;
  url?: string;
  width?: number;
  recording?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  verificationRequired?: boolean;
  verificationSince?: number;
  verificationMessage?: string;
}

export interface BrowserPanelProps {
  browserState: BrowserState;
  browserAddress: string;
  setBrowserAddress(value: string): void;
  startBrowserResize(event: React.PointerEvent): void;
}

export function BrowserPanel({
  browserState,
  browserAddress,
  setBrowserAddress,
  startBrowserResize,
}: BrowserPanelProps) {
  if (!browserState.open) {
    if (browserState.hidden && browserState.sessionId) {
      return (
        <button
          className={`browser-show-tab ${browserState.verificationRequired ? "verification" : ""}`}
          title={
            browserState.verificationRequired
              ? "显示需要人工验证的网页"
              : "重新显示后台运行的浏览器"
          }
          onClick={() =>
            void window.kcode.browser.activate(browserState.sessionId)
          }
        >
          {browserState.verificationRequired ? (
            <ShieldAlert size={15} />
          ) : (
            <PanelRightOpen size={15} />
          )}
          <span>
            {browserState.verificationRequired ? "需要验证" : "显示浏览器"}
          </span>
        </button>
      );
    }
    return null;
  }

  return (
    <aside className="browser-panel" aria-label="浏览器">
      <div
        className="browser-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整浏览器宽度"
        onPointerDown={startBrowserResize}
      />
      <header>
        <div className="browser-navigation">
          <button
            className="icon"
            disabled={!browserState.canGoBack}
            title="后退"
            onClick={() =>
              void window.kcode.browser.back(browserState.sessionId)
            }
          >
            <ArrowLeft size={14} />
          </button>
          <button
            className="icon"
            disabled={!browserState.canGoForward}
            title="前进"
            onClick={() =>
              void window.kcode.browser.forward(browserState.sessionId)
            }
          >
            <ArrowRight size={14} />
          </button>
          <button
            className="icon"
            title="刷新"
            onClick={() =>
              void window.kcode.browser.reload(browserState.sessionId)
            }
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <form
          className="browser-address"
          title={browserState.title || "浏览器"}
          onSubmit={(event) => {
            event.preventDefault();
            const value = /^https?:\/\//i.test(browserAddress)
              ? browserAddress
              : `https://${browserAddress}`;
            void window.kcode.browser.navigate(browserState.sessionId, value);
          }}
        >
          <input
            value={browserAddress}
            onChange={(event) => setBrowserAddress(event.target.value)}
            aria-label="网页地址"
          />
        </form>
        {browserState.recording && (
          <b className="browser-recording">
            <i />
            录制中
          </b>
        )}
        <button
          className="icon"
          title="隐藏网页（浏览器继续在后台运行，可随时重新显示）"
          onClick={() => void window.kcode.browser.hide(browserState.sessionId)}
        >
          <PanelRightClose size={15} />
        </button>
        <button
          className="icon"
          title="关闭网页并结束浏览器进程"
          onClick={() =>
            void window.kcode.browser.close(browserState.sessionId)
          }
        >
          <X size={16} />
        </button>
      </header>
      {browserState.verificationRequired && (
        <div className="browser-verification" role="status" aria-live="polite">
          <ShieldAlert size={17} />
          <span>
            <strong>
              {browserState.verificationMessage || "请完成网页验证"}
            </strong>
            <small>完成后模型会自动继续</small>
          </span>
          <LoaderCircle className="spinning" size={15} />
        </div>
      )}
    </aside>
  );
}
