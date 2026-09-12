import { type ModelRequest } from "../src/types";
import { RetryTextReconciler } from "./stream-recovery";
import { writeLog } from "./logger";
import {
  modelNetworkTransportLabel,
  nextModelNetworkTransport,
  networkTransportErrorText,
} from "./model-network-transport";
import { isRetryableStreamError } from "./request-guard";
import { AsyncQueue } from "./async-queue";
import { SseStreamTimeoutError } from "./sse-stream";
import {
  FINALIZATION_TURN_MAX_DURATION_MS,
  MODEL_TURN_MAX_DURATION_MS,
  MODEL_STREAM_MAX_ATTEMPTS,
  modelStreamMaxAttempts,
  modelStreamRetryDelayMs,
} from "./model-stream-retry";
import { ModelAttemptBudget } from "./model-attempt-budget";
import type {
  Turn,
  TurnStreamEvent,
  ModelTurnRuntime,
  HistoryItem,
  ModelStreamFn,
} from "./agent-types";
import { modelTurn } from "./model-turn";

export function defaultStreamTurn(
  args: Parameters<ModelStreamFn>[0],
  sampleTurn: typeof modelTurn = modelTurn,
): AsyncGenerator<TurnStreamEvent> {
  return streamModelTurn(
    args.root,
    args.requestId,
    args.request,
    args.history,
    args.signal,
    args.toolsEnabled,
    args.requireToolCall,
    args.runtime,
    args.attemptBudget,
    sampleTurn,
  );
}

async function* streamModelTurn(
  root: string,
  requestId: string,
  request: ModelRequest,
  history: HistoryItem[],
  signal: AbortSignal,
  toolsEnabled: boolean,
  requireToolCall: boolean,
  runtime: ModelTurnRuntime,
  attemptBudget: ModelAttemptBudget,
  sampleTurn: typeof modelTurn,
): AsyncGenerator<TurnStreamEvent> {
  const queue = new AsyncQueue<TurnStreamEvent>();
  let turn: Turn | undefined;
  let reasoningOnlyRecoveryAttempted = false;
  const turnMaxDurationMs = toolsEnabled
    ? MODEL_TURN_MAX_DURATION_MS
    : FINALIZATION_TURN_MAX_DURATION_MS;
  const turnDeadlineAt = Date.now() + turnMaxDurationMs;
  const remainingTurnMs = () => turnDeadlineAt - Date.now();
  const turnTimeout = () =>
    new SseStreamTimeoutError("absolute", turnMaxDurationMs);
  const reconciler = new RetryTextReconciler();
  const reasoningReconciler = new RetryTextReconciler();
  const enqueue = (event: TurnStreamEvent) => {
    queue.push(event);
  };
  const pushText = (delta: string) => {
    if (!delta) return;
    const reconciled = reconciler.push(delta);
    if (reconciled.reset) {
      // A divergent retry replaces the visible fragment atomically. Emitting a
      // bare reset followed by a text delta produces a blank React frame and a
      // conspicuous flash on long answers.
      enqueue({ type: "text_reset", replacement: reconciled.delta });
    } else if (reconciled.delta) {
      enqueue({ type: "text", delta: reconciled.delta });
    }
  };
  const completeTextAttempt = () => {
    const reconciled = reconciler.completeAttempt();
    if (reconciled.reset)
      enqueue({ type: "text_reset", replacement: reconciled.delta });
    else if (reconciled.delta)
      enqueue({ type: "text", delta: reconciled.delta });
  };
  const pushReasoning = (delta: string) => {
    if (!delta) return;
    const reconciled = reasoningReconciler.push(delta);
    if (reconciled.reset) enqueue({ type: "reasoning_reset" });
    if (reconciled.delta)
      enqueue({ type: "reasoning", delta: reconciled.delta });
  };
  const completeReasoningAttempt = () => {
    const reconciled = reasoningReconciler.completeAttempt();
    if (reconciled.reset) enqueue({ type: "reasoning_reset" });
    if (reconciled.delta)
      enqueue({ type: "reasoning", delta: reconciled.delta });
  };
  const pushProgress = (message: string) => {
    if (message) enqueue({ type: "progress", message });
  };
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(finish, ms);
      function finish() {
        signal.removeEventListener("abort", finish);
        resolve();
      }
      signal.addEventListener("abort", finish, { once: true });
    });
  // Reconcile restarted streams with text already shown to the user. Stream
  // retries have their own Codex-style budget; the larger request budget only
  // covers API-key and protocol fallbacks inside modelTurn.
  const run = async () => {
    for (let attempt = 1; ; attempt += 1) {
      if (remainingTurnMs() <= 0) throw turnTimeout();
      reconciler.beginAttempt();
      reasoningReconciler.beginAttempt();
      try {
        turn = await sampleTurn(
          root,
          requestId,
          request,
          history,
          signal,
          toolsEnabled,
          requireToolCall,
          pushText,
          pushReasoning,
          pushProgress,
          undefined,
          runtime,
          attemptBudget,
          turnDeadlineAt,
        );
        completeReasoningAttempt();
        completeTextAttempt();
        return;
      } catch (error) {
        const absoluteTurnLimitReached =
          (error instanceof SseStreamTimeoutError &&
            error.timeoutKind === "absolute") ||
          remainingTurnMs() <= 0;
        if (absoluteTurnLimitReached) {
          const timeout =
            error instanceof SseStreamTimeoutError &&
            error.timeoutKind === "absolute"
              ? error
              : turnTimeout();
          writeLog("warn", "model.stream.turn-timeout", {
            requestId,
            timeoutMs: timeout.timeoutMs,
            toolsEnabled,
          });
          pushProgress(
            toolsEnabled
              ? "模型单轮响应超过安全时限，已停止继续等待；已有输出和工具结果会保留…"
              : "模型收尾单轮响应超过安全时限，已停止继续等待…",
          );
          throw timeout;
        }
        const reasoningOnlyStream =
          error instanceof SseStreamTimeoutError &&
          error.timeoutKind === "meaningful";
        if (reasoningOnlyStream) {
          if (!toolsEnabled)
            throw new Error(
              "模型收尾阶段持续只有思考内容，未返回正文或工具调用。",
            );
          if (
            signal.aborted ||
            reasoningOnlyRecoveryAttempted ||
            !attemptBudget.canAttempt()
          )
            throw new Error(
              "模型连续只输出思考内容，未返回正文或工具调用。已自动停止，请重试或切换模型。",
            );
          reasoningOnlyRecoveryAttempted = true;
          history.push({
            kind: "message",
            role: "user",
            content:
              "<runtime_verification>上一轮上游持续输出内部推理，但超过时限没有正文或工具调用。不要继续讨论 channel、final 或输出方式。请立即基于已有工具结果用普通正文给出结论；若任务未完成，直接调用下一项具体工具。</runtime_verification>",
          });
          pushProgress(
            "模型持续只有思考内容，正在要求它直接收尾（仅自动重试一次）…",
          );
          await sleep(Math.min(1_500, Math.max(1, remainingTurnMs())));
          if (signal.aborted) throw error;
          continue;
        }
        const retryable = isRetryableStreamError(error);
        const maxAttempts = Math.min(
          MODEL_STREAM_MAX_ATTEMPTS,
          modelStreamMaxAttempts(error),
        );
        if (
          signal.aborted ||
          attempt >= maxAttempts ||
          !attemptBudget.canAttempt() ||
          !retryable
        )
          throw error;
        const currentTransport = runtime.networkTransport ?? "electron";
        const nextTransport = nextModelNetworkTransport(
          currentTransport,
          error,
        );
        runtime.networkTransport = nextTransport;
        writeLog("warn", "model.stream.retry", {
          requestId,
          attempt,
          maxAttempts,
          transport: modelNetworkTransportLabel(currentTransport),
          nextTransport: modelNetworkTransportLabel(nextTransport),
          error: networkTransportErrorText(error),
        });
        if (nextTransport !== currentTransport)
          pushProgress(
            nextTransport === "direct"
              ? "检测到应用网络通道断流，正在切换备用直连通道重试…"
              : "备用直连通道不可用，正在切回应用网络通道重试…",
          );
        // Keep already visible text. The next attempt is reconciled against
        // that prefix, so replayed output is suppressed without a visual reset.
        const remaining = remainingTurnMs();
        if (remaining <= 0) throw turnTimeout();
        const delay = Math.min(
          modelStreamRetryDelayMs(error, attempt),
          Math.max(1, remaining),
        );
        pushProgress(
          `上游连接中断，正在重连（${attempt}/${Math.max(1, maxAttempts - 1)}），${Math.ceil(delay / 1_000)} 秒后继续；已有输出和工具结果会保留…`,
        );
        await sleep(delay);
        if (signal.aborted) throw error;
        if (remainingTurnMs() <= 0) throw turnTimeout();
      }
    }
  };
  void run()
    .then(() => {
      queue.close();
    })
    .catch((error) => queue.fail(error));
  for await (const event of queue) yield event;
  yield { type: "complete", turn: turn! };
}
