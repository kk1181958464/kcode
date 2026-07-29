import { memo, useEffect, useState, type RefObject } from "react";
import { Bot, ChevronDown, Settings } from "lucide-react";
import type {
  AgentActivity,
  ChatMessage,
  ContextFile,
  ModelConfig,
  ProviderConfig,
} from "../../types";
import { ConversationHistory } from "./ConversationView";

interface ConversationTurn {
  id: string;
  question: string;
  answer: string;
}

interface ModelEntry {
  provider: ProviderConfig;
  model: ModelConfig;
}

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
  useEffect(() => {
    const frame = requestAnimationFrame(updateRailWindow);
    return () => cancelAnimationFrame(frame);
  }, [conversationTurns.length]);
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
            updateTurnRailOverflow();
            updateRailWindow();
          }}
          style={
            {
              "--turn-count": conversationTurns.length,
            } as React.CSSProperties
          }
        >
          <span
            className={`turn-rail-cue up ${turnRailOverflow.up ? "visible" : ""}`}
          >
            <ChevronDown size={12} />
          </span>
          <span
            className={`turn-rail-cue down ${turnRailOverflow.down ? "visible" : ""}`}
          >
            <ChevronDown size={12} />
          </span>
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
              ref={(element) => {
                if (element) {
                  turnButtonRefs.current.set(turn.id, element);
                  element.classList.toggle(
                    "active",
                    activeConversationTurnRef.current === turn.id,
                  );
                } else turnButtonRefs.current.delete(turn.id);
              }}
              onClick={() => scrollToTurn(turn.id, index)}
              aria-label={`跳转到：${turn.question.slice(0, 40)}`}
            >
              <span className="turn-tick" />
              <span className="turn-preview">
                <strong>{turn.question}</strong>
                <small>{turn.answer}</small>
              </span>
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
