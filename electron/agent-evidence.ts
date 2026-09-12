import { type AgentActivity, type AgentToolName } from "../src/types";
import {
  compactOperationEvidenceResult,
  successfulCodingEvidence,
} from "./coding-operation-verification";
import { successfulBrowserEvidence } from "./browser-operation-verification";
import type { ToolCall, HistoryItem } from "./agent-types";
import { compactEvidenceCall } from "./runtime-compaction";
import { redactedToolInput } from "./agent-input";

export function codingEvidenceFromActivities(activities: AgentActivity[]) {
  const evidence: HistoryItem[] = [];
  for (const activity of activities) {
    evidence.push({
      kind: "calls",
      calls: [
        compactEvidenceCall({
          id: activity.id,
          name: activity.tool,
          input: {
            ...activity.input,
            command: activity.command,
            path: activity.path,
          },
        }),
      ],
      rawCalls: [],
    });
    evidence.push({
      kind: "result",
      callId: activity.id,
      content: JSON.stringify({
        success: activity.status === "success",
        data: {
          changed: activity.changed,
          executed: activity.executed,
          exitCode: activity.exitCode,
          output:
            activity.tool === "process_output" ? activity.output : undefined,
        },
      }),
    });
  }
  return [...successfulCodingEvidence(evidence)];
}

export function subagentActivityHistory(
  activity: AgentActivity,
): HistoryItem[] {
  const input = {
    ...(activity.input ?? {}),
    ...(activity.command ? { command: activity.command } : {}),
    ...(activity.path ? { path: activity.path } : {}),
  };
  return [
    {
      kind: "calls",
      calls: [{ id: activity.id, name: activity.tool, input }],
      rawCalls: [],
    },
    compactOperationEvidenceResult(
      activity.id,
      activity.tool,
      activity.status === "success",
      {
        changed: activity.changed,
        executed: activity.executed,
        mutationAttempted: undefined,
        noChangeReported: undefined,
        userInputRequested: undefined,
        operationEvidence: activity.operationEvidence,
        browserOperationEvidence: activity.browserOperationEvidence,
        exitCode: activity.exitCode,
        path: activity.path,
        additions: activity.additions,
        deletions: activity.deletions,
        fileChanges: activity.fileChanges,
        diff: activity.diff,
        output: activity.output,
      },
    ),
  ];
}

export function browserEvidenceFromActivities(activities: AgentActivity[]) {
  const evidence: HistoryItem[] = [];
  for (const activity of activities) {
    evidence.push({
      kind: "calls",
      calls: [
        {
          id: activity.id,
          name: activity.tool,
          input: activity.input,
        },
      ],
      rawCalls: [],
    });
    evidence.push({
      kind: "result",
      callId: activity.id,
      content: JSON.stringify({ success: activity.status === "success" }),
    });
  }
  return [...successfulBrowserEvidence(evidence)];
}

function connectionFamily(tool: AgentToolName) {
  if (tool === "ssh_connect" || tool === "ssh_disconnect") return "ssh";
  if (tool.startsWith("mysql_")) return "mysql";
  if (tool.startsWith("sqlserver_")) return "sqlserver";
  if (tool.startsWith("mongodb_")) return "mongodb";
  return undefined;
}

export function updateActiveConnectionFacts(
  active: Map<string, string>,
  call: ToolCall,
  succeeded: boolean,
) {
  if (!succeeded) return;
  const family = connectionFamily(call.name);
  if (!family) return;
  if (call.name.endsWith("disconnect")) {
    active.delete(family);
    return;
  }
  if (call.name.includes("connect"))
    active.set(
      family,
      `${call.name} ${JSON.stringify(redactedToolInput(call))}`,
    );
}
