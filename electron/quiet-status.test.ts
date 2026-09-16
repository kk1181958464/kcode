import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyQuietStatus,
  quietStatusLabel,
} from "../src/quiet-status";

test("classifies live progress into quiet-status chips", () => {
  assert.equal(classifyQuietStatus(""), undefined);
  assert.equal(
    classifyQuietStatus("上游连接中断，正在重连（1/5）…"),
    "retrying",
  );
  assert.equal(
    classifyQuietStatus("上下文接近预算，正在让模型整理较早运行记录…"),
    "compacting",
  );
  assert.equal(
    classifyQuietStatus("子 Agent 没有新进展，已停止未完成的子任务…"),
    "waiting-subagents",
  );
  assert.equal(
    classifyQuietStatus("上游返回空响应，正在自动恢复（第 1 次尝试）…"),
    "recovering",
  );
  assert.equal(classifyQuietStatus("正在生成回复…"), "waiting-model");
  assert.equal(quietStatusLabel("retrying"), "正在重连");
});

test("does not quiet-collapse auto-continue progress into waiting-model", () => {
  assert.equal(
    classifyQuietStatus(
      "上游响应流中断，正在基于已有工具结果自动继续（1/3）…",
    ),
    undefined,
  );
  assert.equal(
    classifyQuietStatus(
      "模型本轮持续思考已达单轮安全边界，正在基于已有工具结果自动继续（2/3）…",
    ),
    undefined,
  );
});
