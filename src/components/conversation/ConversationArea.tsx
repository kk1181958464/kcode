import { memo, useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Bot, ChevronDown, ChevronUp, Settings } from "lucide-react";
import type { ConversationTurn } from "../../conversation-window";
import type {
  AgentActivity,
  ChatMessage,
  ContextFile,
  ModelConfig,
  ProviderConfig,
} from "../../types";
import { ConversationHistory } from "./ConversationView";

interface ModelEntry {
  provider: ProviderConfig;
  model: ModelConfig;
}

type TurnPreviewState = ConversationTurn & {
  left: number;
  top: number;
};

export interface ConversationAreaProps {
  conversationRef: RefObject<HTMLElement | null>;
  handleConversationScroll(target: HTMLElement): void;
  interruptBottomSettle(): void;
  conversationTurns: ConversationTurn[];
  turnRailRef: RefObject<HTMLElement | null>;
  turnRailOverflow: { up: boolean; down: boolean };
  updateTurnRailOverflow(): void;
  turnButtonRefs: RefObject<Map<string, HTMLButtonElement>>;
  activeConversationTurnRef: RefObject<string | undefined>;
  scrollToTurn(id: string, index: number): void;
  messages: ChatMessage[];
  hasOlderMessages?: boolean;
  hasNewerMessages?: boolean;
  models: ModelEntry[];
  writeInput(value: string): void;
  openSettings(section: string): void;
  activitiesByRequest: Map<string, AgentActivity[]>;
  runningId: string | undefined;
  activeTaskWorkspacePath: string;
  contextByMessage: Map<string, ContextFile[]>;
  retryContent: string | undefined;
  retryMessage(content: string): void;
  handleActivityChange(activity: AgentActivity): void;
  registerTurn(messageId: string, element: HTMLDivElement | null): void;
  endRef: RefObject<HTMLDivElement | null>;
  agentReasoning: string;
}

const TURN_RAIL_ITEM_HEIGHT = 28;
const TURN_RAIL_OVERSCAN = 12;

export const ConversationArea = memo(function ConversationArea({
  conversationRef,
  handleConversationScroll,
  interruptBottomSettle,
  conversationTurns,
  turnRailRef,
  turnRailOverflow,
  updateTurnRailOverflow,
  turnButtonRefs,
  activeConversationTurnRef,
  scrollToTurn,
  messages,
  hasOlderMessages = false,
  hasNewerMessages = false,
  models,
  writeInput,
  openSettings,
  activitiesByRequest,
  runningId,
  activeTaskWorkspacePath,
  contextByMessage,
  retryContent,
  retryMessage,
  handleActivityChange,
  registerTurn,
  endRef,
  agentReasoning,
}: ConversationAreaProps) {
  const [railWindow, setRailWindow] = useState({ start: 0, end: 80 });
  const [turnPreview, setTurnPreview] = useState<TurnPreviewState>();
  const showTurnPreview = (
    turn: ConversationTurn,
    button: HTMLButtonElement,
  ) => {
    const rect = button.getBoundingClientRect();
    const previewWidth = Math.min(320, Math.max(180, window.innerWidth - 24));
    setTurnPreview({
      ...turn,
      left: Math.max(
        12,
        Math.min(rect.left + 34, window.innerWidth - previewWidth - 12),
      ),
      top: Math.max(
        52,
        Math.min(rect.top + rect.height / 2, window.innerHeight - 52),
      ),
    });
  };
  const hideTurnPreview = (turnId: string) =>
    setTurnPreview((current) => (current?.id === turnId ? undefined : current));
  const updateRailWindow = () => {
    const rail = turnRailRef.current;
    if (!rail) return;
    const start = Math.max(
      0,
      Math.floor(rail.scrollTop / TURN_RAIL_ITEM_HEIGHT) - TURN_RAIL_OVERSCAN,
    );
    const visible = Math.ceil(rail.clientHeight / TURN_RAIL_ITEM_HEIGHT);
    const end = Math.min(
      conversationTurns.length,
      start + visible + TURN_RAIL_OVERSCAN * 2,
    );
    setRailWindow((current) =>
      current.start === start && current.end === end ? current : { start, end },
    );
  };
  const scrollTurnRail = (direction: -1 | 1) => {
    const rail = turnRailRef.current;
    if (!rail) return;
    setTurnPreview(undefined);
    rail.scrollBy({
      top:
        direction *
        Math.max(TURN_RAIL_ITEM_HEIGHT * 4, rail.clientHeight * 0.55),
      behavior: "smooth",
    });
  };
  useEffect(() => {
    const frame = requestAnimationFrame(updateRailWindow);
    return () => cancelAnimationFrame(frame);
  }, [conversationTurns.length]);
  useEffect(() => {
    setTurnPreview((current) => {
      if (!current) return current;
      const updated = conversationTurns.find((turn) => turn.id === current.id);
      if (!updated) return undefined;
      if (
        updated.question === current.question &&
        updated.answer === current.answer
      )
        return current;
      return { ...current, ...updated };
    });
  }, [conversationTurns]);
  const visibleTurns = conversationTurns.slice(
    railWindow.start,
    railWindow.end,
  );
  return (
    <section
      ref={conversationRef}
      className="conversation"
      onScroll={(event) => handleConversationScroll(event.currentTarget)}
      onWheelCapture={interruptBottomSettle}
      onTouchStart={interruptBottomSettle}
      onPointerDown={interruptBottomSettle}
    >
      {conversationTurns.length > 1 && (
        <nav
          ref={turnRailRef}
          className="turn-rail"
          aria-label="对话记录导航"
          onScroll={() => {
            setTurnPreview(undefined);
            updateTurnRailOverflow();
            updateRailWindow();
          }}
          style={
            {
              "--turn-count": conversationTurns.length,
            } as React.CSSProperties
          }
        >
          <button
            type="button"
            className={`turn-rail-cue up ${turnRailOverflow.up ? "visible" : ""}`}
            aria-label="向上浏览较早对话"
            aria-hidden={!turnRailOverflow.up}
            tabIndex={turnRailOverflow.up ? 0 : -1}
            title="向上浏览较早对话"
            onClick={() => scrollTurnRail(-1)}
          >
            <ChevronUp size={15} strokeWidth={2.4} />
          </button>
          <button
            type="button"
            className={`turn-rail-cue down ${turnRailOverflow.down ? "visible" : ""}`}
            aria-label="向下浏览较新对话"
            aria-hidden={!turnRailOverflow.down}
            tabIndex={turnRailOverflow.down ? 0 : -1}
            title="向下浏览较新对话"
            onClick={() => scrollTurnRail(1)}
          >
            <ChevronDown size={15} strokeWidth={2.4} />
          </button>
          <div className="turn-rail-line" />
          {railWindow.start > 0 && (
            <div
              className="turn-rail-spacer"
              style={{ height: railWindow.start * TURN_RAIL_ITEM_HEIGHT }}
            />
          )}
          {visibleTurns.map((turn, offset) => {
            const index = railWindow.start + offset;
            return (
              <button
                key={turn.id}
                className="turn-rail-turn"
                ref={(element) => {
                  if (element) {
                    turnButtonRefs.current.set(turn.id, element);
                    element.classList.toggle(
                      "active",
                      activeConversationTurnRef.current === turn.id,
                    );
                  } else turnButtonRefs.current.delete(turn.id);
                }}
                onMouseEnter={(event) =>
                  showTurnPreview(turn, event.currentTarget)
                }
                onMouseLeave={() => hideTurnPreview(turn.id)}
                onFocus={(event) => showTurnPreview(turn, event.currentTarget)}
                onBlur={() => hideTurnPreview(turn.id)}
                onClick={() => {
                  setTurnPreview(undefined);
                  scrollToTurn(turn.id, index);
                }}
                aria-label={`跳转到：${turn.question.slice(0, 40)}`}
              >
                <span className="turn-tick" />
              </button>
            );
          })}
          {railWindow.end < conversationTurns.length && (
            <div
              className="turn-rail-spacer"
              style={{
                height:
                  (conversationTurns.length - railWindow.end) *
                  TURN_RAIL_ITEM_HEIGHT,
              }}
            />
          )}
        </nav>
      )}
      {turnPreview &&
        createPortal(
          <span
            className="turn-preview"
            role="tooltip"
            style={{ left: turnPreview.left, top: turnPreview.top }}
          >
            <strong>{turnPreview.question}</strong>
            <small>{turnPreview.answer || "此轮正在等待回复"}</small>
          </span>,
          document.body,
        )}
      {messages.length === 0 ? (
        <div className="welcome">
          <div className="welcome-context">
            <span className="context-dot" />
            工作区已连接
          </div>
          <div className="logo-large">
            <Bot size={25} />
          </div>
          <h2>{models.length ? "今天要构建什么？" : "先连接一个模型"}</h2>
          <p>
            {models.length
              ? "描述目标，Agent 会读取项目、制定计划并执行修改。"
              : "添加模型供应商后，即可在当前工作区启动 Agent 任务。"}
          </p>
          {models.length ? (
            <div className="prompts">
              <button
                onClick={() =>
                  writeInput("检查当前项目结构，并给出下一步实现计划")
                }
              >
                <span>01</span>检查项目结构并制定计划
              </button>
              <button
                onClick={() => writeInput("为这个项目补充 README 和开发说明")}
              >
                <span>02</span>完善项目文档
              </button>
            </div>
          ) : (
            <button
              className="connect-model"
              onClick={() => openSettings("models")}
            >
              <Settings size={15} />
              打开模型设置
            </button>
          )}
        </div>
      ) : (
        <ConversationHistory
          messages={messages}
          hasOlderMessages={hasOlderMessages}
          hasNewerMessages={hasNewerMessages}
          activitiesByRequest={activitiesByRequest}
          runningId={runningId}
          workspacePath={activeTaskWorkspacePath}
          contextByMessage={contextByMessage}
          retryContent={retryContent}
          onRetry={retryMessage}
          onActivityChange={handleActivityChange}
          registerTurn={registerTurn}
          endRef={endRef}
          reasoning={agentReasoning}
        />
      )}
    </section>
  );
});
