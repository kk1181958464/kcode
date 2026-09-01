import type { ToolEvidenceSummary } from "./agent-completion";
import { parseCommandInvocations } from "./command-canonicalize";

export type CodingOperation =
  | "inspect"
  | "modify"
  | "execute"
  | "validate"
  | "connect"
  | "upload"
  | "download";

export type CodingVerificationHistoryItem =
  | { kind: "message"; role: "user" | "assistant"; content: string }
  | {
      kind: "calls";
      calls: {
        id: string;
        name: string;
        input: Record<string, unknown>;
      }[];
    }
  | { kind: "result"; callId: string; content: string };

const MUTATION_CALL_TOOLS = new Set([
  "apply_patch",
  "write_file",
  "make_directory",
  "move_path",
  "delete_path",
  "ssh_write_file",
]);

const EXECUTION_CALL_TOOLS = new Set([
  "run_command",
  "start_process",
  "process_output",
  "stop_process",
  "diagnostics",
  "ssh_run",
  "mysql_query",
  "sqlserver_query",
  "mongodb_execute",
  "mcp_call_tool",
]);

const CONNECTION_CALL_TOOLS = new Set([
  "ssh_connect",
  "mysql_connect",
  "mysql_connect_via_ssh",
  "sqlserver_connect",
  "sqlserver_connect_via_ssh",
  "mongodb_connect",
  "mongodb_connect_via_ssh",
]);

/** Side effects become completion requirements only after a native call exists. */
export function codingOperationsRequiredByCalls(
  calls: ReadonlyArray<{
    name: string;
    input?: Record<string, unknown>;
  }>,
) {
  const operations = new Set<CodingOperation>();
  for (const call of calls) {
    if (MUTATION_CALL_TOOLS.has(call.name)) operations.add("modify");
    if (EXECUTION_CALL_TOOLS.has(call.name)) operations.add("execute");
    if (call.name === "diagnostics") operations.add("validate");
    if (
      ["run_command", "ssh_run"].includes(call.name) &&
      call.input?.purpose === "validate"
    )
      operations.add("validate");
    if (CONNECTION_CALL_TOOLS.has(call.name)) operations.add("connect");
    if (call.name === "ssh_upload_file") operations.add("upload");
    if (call.name === "ssh_download_file") operations.add("download");
  }
  return operations;
}

const EVIDENCE_OUTPUT_TOOLS = new Set([
  "process_output",
  "git_status",
  "git_log",
  "git_diff",
  "git_show",
  "run_command",
  "ssh_run",
]);

export function compactOperationEvidenceResult(
  callId: string,
  toolName: string,
  success: boolean,
  data: Record<string, unknown>,
): Extract<CodingVerificationHistoryItem, { kind: "result" }> {
  return {
    kind: "result",
    callId,
    content: JSON.stringify({
      success,
      data: {
        changed: data.changed,
        executed: data.executed,
        mutationAttempted: data.mutationAttempted,
        noChangeReported: data.noChangeReported,
        userInputRequested: data.userInputRequested,
        operationEvidence: data.operationEvidence,
        browserOperationEvidence: data.browserOperationEvidence,
        exitCode: data.exitCode,
        path: data.path,
        additions: data.additions,
        deletions: data.deletions,
        fileChanges: Array.isArray(data.fileChanges)
          ? data.fileChanges.slice(0, 100).map((change) => {
              if (!change || typeof change !== "object") return change;
              const item = change as Record<string, unknown>;
              return {
                path: item.path,
                changed: item.changed,
                additions: item.additions,
                deletions: item.deletions,
              };
            })
          : undefined,
        output: EVIDENCE_OUTPUT_TOOLS.has(toolName)
          ? String(data.output ?? "").slice(0, 1_000)
          : undefined,
      },
    }),
  };
}

type VerificationMessage = Extract<
  CodingVerificationHistoryItem,
  { kind: "message" }
>;

function userIntentContent(content: string) {
  return content
    .replace(/<user_steer>([\s\S]*?)<\/user_steer>/gi, "$1")
    .replace(
      /<interrupted_turn_recovery>[\s\S]*?<\/interrupted_turn_recovery>/gi,
      "",
    )
    .replace(/<runtime_verification>[\s\S]*?<\/runtime_verification>/gi, "")
    .replace(/<runtime_finalization>[\s\S]*?<\/runtime_finalization>/gi, "")
    .replace(/<runtime_hook>[\s\S]*?<\/runtime_hook>/gi, "")
    .replace(/<parent_instruction>[\s\S]*?<\/parent_instruction>/gi, "")
    .replace(/<context_file\b[^>]*>[\s\S]*?<\/context_file>/gi, "")
    .replace(/<conversation_summary>[\s\S]*?<\/conversation_summary>/gi, "")
    .trim();
}

/** Latest real user payload without interpreting its natural-language intent. */
export function latestUserRequestContent(
  history: CodingVerificationHistoryItem[],
) {
  const latest = [...history]
    .reverse()
    .find(
      (item): item is VerificationMessage =>
        item.kind === "message" && item.role === "user",
    );
  return latest ? userIntentContent(latest.content) : "";
}

/**
 * Explicit coding work must enter the native tool loop before a model can
 * finish in prose. Once the requested side effects have verifiable evidence,
 * normal automatic tool selection is restored so the model can summarize.
 */
export function shouldRequireCodingTool(
  _modelId: string,
  requested: ReadonlySet<CodingOperation>,
  evidence: ReadonlySet<CodingOperation>,
  history: CodingVerificationHistoryItem[] = [],
) {
  if (hasRequestedUserInputEvidence(history)) return false;
  const required = codingOperationsRequiringToolEvidence(requested);
  if (!required.size) return false;
  return (
    missingVerifiedCodingOperations(required, evidence, history).length > 0
  );
}

type SuccessfulResult = {
  success?: boolean;
  data?: Record<string, unknown>;
};

function parsedResults(history: CodingVerificationHistoryItem[]) {
  const results = new Map<string, SuccessfulResult>();
  for (const item of history) {
    if (item.kind !== "result") continue;
    try {
      const result = JSON.parse(item.content) as SuccessfulResult;
      results.set(item.callId, result);
    } catch {
      // Unstructured legacy output cannot prove that an operation succeeded.
    }
  }
  return results;
}

export function hasSuccessfulToolEvidence(
  history: CodingVerificationHistoryItem[],
) {
  const calls = new Map<string, string>();
  for (const item of history)
    if (item.kind === "calls")
      for (const call of item.calls) calls.set(call.id, call.name);
  const administrativeTools = new Set([
    "request_user_input",
    "report_no_change",
    "spawn_agent",
    "list_agents",
    "message_agent",
    "stop_agent",
  ]);
  for (const [callId, result] of parsedResults(history)) {
    const tool = calls.get(callId);
    if (result.success === true && tool && !administrativeTools.has(tool))
      return true;
  }
  return false;
}

export function successfulToolNames(history: CodingVerificationHistoryItem[]) {
  const calls = new Map<string, string>();
  for (const item of history)
    if (item.kind === "calls")
      for (const call of item.calls) calls.set(call.id, call.name);
  const names = new Set<string>();
  for (const [callId, result] of parsedResults(history)) {
    const name = calls.get(callId);
    if (name && result.success === true) names.add(name);
  }
  return names;
}

/** Structured execution facts used for completion UI and persistence. */
export function structuredToolEvidenceSummary(
  history: CodingVerificationHistoryItem[],
): ToolEvidenceSummary {
  const calls = new Map<
    string,
    { name: string; input: Record<string, unknown> }
  >();
  for (const item of history)
    if (item.kind === "calls")
      for (const call of item.calls)
        calls.set(call.id, { name: call.name, input: call.input ?? {} });

  let successfulTools = 0;
  let failedTools = 0;
  let additions = 0;
  let deletions = 0;
  const changedFiles = new Set<string>();
  const transfers = new Map<
    string,
    {
      direction: "download" | "upload";
      source: string;
      destination: string;
    }
  >();
  for (const [callId, result] of parsedResults(history)) {
    const call = calls.get(callId);
    if (!call) continue;
    if (result.success === true) successfulTools += 1;
    else failedTools += 1;
    const data = result.data;
    if (result.success === true && call.name === "ssh_download_file") {
      const source = String(call.input.remotePath ?? "").trim();
      const destination = String(
        data?.path ?? call.input.localPath ?? "",
      ).trim();
      if (destination) {
        const transfer = {
          direction: "download" as const,
          source,
          destination,
        };
        transfers.set(
          `${transfer.direction}:${transfer.source}:${transfer.destination}`,
          transfer,
        );
      }
      continue;
    }
    if (result.success === true && call.name === "ssh_upload_file") {
      const source = String(call.input.localPath ?? "").trim();
      const destination = String(
        data?.path ?? call.input.remotePath ?? "",
      ).trim();
      if (destination) {
        const transfer = {
          direction: "upload" as const,
          source,
          destination,
        };
        transfers.set(
          `${transfer.direction}:${transfer.source}:${transfer.destination}`,
          transfer,
        );
      }
      continue;
    }
    if (!data || !hasActualMutation(data)) continue;
    const fileChanges = Array.isArray(data.fileChanges)
      ? data.fileChanges.filter(
          (change): change is Record<string, unknown> =>
            Boolean(change) && typeof change === "object",
        )
      : [];
    if (fileChanges.length) {
      for (const change of fileChanges) {
        const filePath = String(change.path ?? "").trim();
        if (filePath) changedFiles.add(filePath);
        additions += Math.max(0, Number(change.additions) || 0);
        deletions += Math.max(0, Number(change.deletions) || 0);
      }
      continue;
    }
    const filePath = String(data.path ?? "").trim();
    if (filePath) changedFiles.add(filePath);
    additions += Math.max(0, Number(data.additions) || 0);
    deletions += Math.max(0, Number(data.deletions) || 0);
  }

  return {
    toolCalls: calls.size,
    successfulTools,
    failedTools,
    changedFiles: [...changedFiles],
    ...(transfers.size ? { transfers: [...transfers.values()] } : {}),
    additions,
    deletions,
  };
}

export function hasRequestedUserInputEvidence(
  history: CodingVerificationHistoryItem[],
) {
  const parsed = parsedResults(history);
  const calls = new Map<
    string,
    { name: string; input: Record<string, unknown> }
  >();
  for (const item of history)
    if (item.kind === "calls")
      for (const call of item.calls) calls.set(call.id, call);
  for (const [callId, result] of parsed) {
    const call = calls.get(callId);
    if (
      call?.name === "request_user_input" &&
      result.success === true &&
      result.data?.userInputRequested === true &&
      String(call.input.question ?? "").trim().length >= 8 &&
      Array.isArray(call.input.fields) &&
      call.input.fields.some((field) => String(field).trim())
    )
      return true;
  }
  return false;
}

function verifiedNoChangeEvidence(history: CodingVerificationHistoryItem[]) {
  const parsed = parsedResults(history);
  const noOpCapableTools = new Set([
    "apply_patch",
    "write_file",
    "make_directory",
    "ssh_write_file",
    "mysql_query",
    "sqlserver_query",
    "mongodb_execute",
    "diagnostics",
  ]);
  const inspectionTools = new Set([
    "list_directory",
    "glob_files",
    "read_many_files",
    "path_info",
    "read_file",
    "search_code",
    "git_status",
    "git_diff",
    "git_log",
    "git_show",
    "web_search",
    "fetch_url",
    "browser_snapshot",
    "browser_screenshot",
    "ssh_list_directory",
    "ssh_read_file",
  ]);
  const calls = new Map<
    string,
    { id: string; name: string; input: Record<string, unknown> }
  >();
  for (const item of history) {
    if (item.kind === "calls")
      for (const call of item.calls) calls.set(call.id, call);
  }
  let inspected = false;
  let mutated = false;
  let explicitReport = false;
  let verifiedNoOp = false;
  for (const item of history) {
    if (item.kind !== "result") continue;
    const call = calls.get(item.callId);
    const result = parsed.get(item.callId);
    if (!call || result?.success !== true) continue;
    const data = result.data;
    const command = ["run_command", "ssh_run"].includes(call.name)
      ? String(call.input.command ?? "")
      : "";
    if (
      inspectionTools.has(call.name) ||
      (["run_command", "ssh_run"].includes(call.name) &&
        data?.executed === true &&
        isInspectionCommand(command))
    )
      inspected = true;
    if (hasActualMutation(data)) {
      mutated = true;
      explicitReport = false;
    }
    if (noOpCapableTools.has(call.name)) {
      if (
        data?.changed === false &&
        (data.mutationAttempted === true ||
          !["mysql_query", "sqlserver_query", "mongodb_execute"].includes(
            call.name,
          ))
      )
        verifiedNoOp = true;
    }
    if (
      call.name === "report_no_change" &&
      data?.noChangeReported === true &&
      String(call.input.reason ?? "").trim().length >= 8 &&
      inspected &&
      !mutated
    )
      explicitReport = true;
  }
  return { verifiedNoOp, explicitReport };
}

export function hasVerifiedNoChangeEvidence(
  history: CodingVerificationHistoryItem[],
) {
  const evidence = verifiedNoChangeEvidence(history);
  return evidence.verifiedNoOp || evidence.explicitReport;
}

export function hasVerifiedNoChangeReport(
  history: CodingVerificationHistoryItem[],
) {
  return verifiedNoChangeEvidence(history).explicitReport;
}

function hasActualMutation(data: Record<string, unknown> | undefined) {
  if (!data) return false;
  if (data.changed === false) return false;
  if (data.changed === true) return true;
  if (Number(data.additions) > 0 || Number(data.deletions) > 0) return true;
  if (typeof data.diff === "string" && data.diff.trim()) return true;
  if (!Array.isArray(data.fileChanges)) return false;
  return data.fileChanges.some((change) => {
    if (!change || typeof change !== "object") return false;
    const item = change as Record<string, unknown>;
    return (
      item.changed === true ||
      Number(item.additions) > 0 ||
      Number(item.deletions) > 0 ||
      (typeof item.diff === "string" && Boolean(item.diff.trim()))
    );
  });
}

export function isValidationCommand(command: string) {
  const validationScripts =
    /^(?:test|check|verify|validate|typecheck|lint|build|compile)(?::[\w.-]+)?$/i;
  const validationFiles =
    /^(?:test|check|verify|validate)[\w.-]*\.(?:[cm]?js|tsx?|py|php|sh|rb)$/i;
  const directTools = new Set([
    "vitest",
    "jest",
    "pytest",
    "phpunit",
    "tsc",
    "vue-tsc",
    "eslint",
  ]);
  const baseName = (value: string) =>
    value.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  const meaningfulArgs = (args: string[]) =>
    args.map((arg) => arg.toLowerCase()).filter((arg) => arg !== "--");
  const hasShellControlFlow =
    /(?:^|[;&|()\s])(?:if|then|elif|else|fi|for|while|until|do|done)(?=$|[;&|()\s])/i.test(
      command,
    );
  const preservesNestedFailure =
    /\|\|\s*(?:exit|return)\s+[1-9]\d*\b|(?:^|[;&|()\s])set\s+-[^\s;&|]*e\b/i.test(
      command,
    );
  if (hasShellControlFlow && !preservesNestedFailure) return false;

  return parseCommandInvocations(command).some(({ executable, args }) => {
    const lowerArgs = meaningfulArgs(args);
    if (directTools.has(executable)) return true;
    if (executable === "biome")
      return ["check", "lint"].includes(lowerArgs[0] ?? "");
    if (executable === "prettier") return lowerArgs.includes("--check");
    if (["test-json", "convertfrom-json"].includes(executable)) return true;
    if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
      const first = lowerArgs.find((arg) => !arg.startsWith("-")) ?? "";
      const firstIndex = lowerArgs.indexOf(first);
      const script =
        first === "run" || first === "exec"
          ? (lowerArgs
              .slice(firstIndex + 1)
              .find((arg) => !arg.startsWith("-")) ?? "")
          : first;
      return (
        validationScripts.test(script) ||
        directTools.has(baseName(script)) ||
        ["biome", "prettier"].includes(baseName(script))
      );
    }
    if (["npx", "bunx"].includes(executable)) {
      const tool = lowerArgs.find((arg) => !arg.startsWith("-")) ?? "";
      return (
        directTools.has(baseName(tool)) ||
        ["biome", "prettier"].includes(baseName(tool))
      );
    }
    if (/^python(?:\d+(?:\.\d+)*)?$/.test(executable)) {
      const moduleIndex = lowerArgs.indexOf("-m");
      if (
        moduleIndex >= 0 &&
        [
          "pytest",
          "unittest",
          "py_compile",
          "compileall",
          "json.tool",
        ].includes(lowerArgs[moduleIndex + 1] ?? "")
      )
        return true;
      return lowerArgs.some((arg) => validationFiles.test(baseName(arg)));
    }
    if (executable === "node")
      return (
        lowerArgs.includes("--check") ||
        lowerArgs.some((arg) => validationFiles.test(baseName(arg)))
      );
    if (executable === "php")
      return (
        lowerArgs.includes("-l") ||
        (lowerArgs[0] === "artisan" && lowerArgs[1] === "test") ||
        lowerArgs.some((arg) => validationFiles.test(baseName(arg)))
      );
    if (executable === "composer") return lowerArgs[0] === "test";
    if (executable === "go")
      return ["test", "vet"].includes(lowerArgs[0] ?? "");
    if (executable === "cargo")
      return ["test", "check", "clippy", "build"].includes(lowerArgs[0] ?? "");
    if (executable === "dotnet")
      return ["test", "build"].includes(lowerArgs[0] ?? "");
    if (["mvn", "mvnw", "gradle", "gradlew"].includes(executable))
      return lowerArgs.some((arg) =>
        /^(?:test|verify|check|build|package)$/.test(arg),
      );
    if (executable === "make")
      return ["test", "check"].includes(lowerArgs[0] ?? "");
    if (executable === "deno")
      return ["test", "check"].includes(lowerArgs[0] ?? "");
    if (["bash", "sh"].includes(executable))
      return (
        lowerArgs.includes("-n") ||
        lowerArgs.some((arg) => validationFiles.test(baseName(arg)))
      );
    if (executable === "ruby")
      return (
        lowerArgs.includes("-c") ||
        lowerArgs.some((arg) => validationFiles.test(baseName(arg)))
      );
    if (executable === "jq")
      return lowerArgs.includes("empty") || lowerArgs.includes("--exit-status");
    return validationFiles.test(baseName(executable));
  });
}

export function isInspectionCommand(command: string) {
  const inspectionTools = new Set([
    "cat",
    "type",
    "find",
    "findstr",
    "rg",
    "grep",
    "ls",
    "dir",
    "pwd",
    "tree",
    "head",
    "tail",
    "wc",
    "stat",
    "file",
    "where",
    "which",
    "get-content",
    "get-childitem",
    "get-item",
    "get-command",
    "select-string",
    "test-path",
    "resolve-path",
  ]);
  return parseCommandInvocations(command).some(({ executable, args }) => {
    if (inspectionTools.has(executable)) return true;
    if (executable !== "git") return false;
    const subcommand = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
    return ["status", "diff", "log", "show"].includes(subcommand ?? "");
  });
}

/** Successful native tool results generated during this Agent run. */
export function successfulCodingEvidence(
  history: CodingVerificationHistoryItem[],
) {
  const parsed = parsedResults(history);
  const operations = new Set<CodingOperation>();
  const inspectTools = new Set([
    "list_directory",
    "glob_files",
    "read_many_files",
    "path_info",
    "read_file",
    "search_code",
    "git_status",
    "git_diff",
    "git_log",
    "git_show",
    "web_search",
    "fetch_url",
    "browser_snapshot",
    "browser_screenshot",
    "ssh_list_directory",
    "ssh_read_file",
  ]);
  const executeTools = new Set([
    "run_command",
    "ssh_run",
    "mysql_query",
    "sqlserver_query",
    "mongodb_execute",
  ]);
  const connectTools = new Set([
    "ssh_connect",
    "mysql_connect",
    "mysql_connect_via_ssh",
    "sqlserver_connect",
    "sqlserver_connect_via_ssh",
    "mongodb_connect",
    "mongodb_connect_via_ssh",
  ]);
  const calls = new Map<
    string,
    { id: string; name: string; input: Record<string, unknown> }
  >();
  for (const item of history)
    if (item.kind === "calls")
      for (const call of item.calls) calls.set(call.id, call);

  let sequence = 0;
  let lastMutation = -1;
  let lastValidation = -1;
  for (const item of history) {
    if (item.kind !== "result") continue;
    sequence += 1;
    const result = parsed.get(item.callId);
    const call = calls.get(item.callId);
    if (!result || !call) continue;
    const data = result.data;
    const successful = result.success === true;
    if (successful && inspectTools.has(call.name)) operations.add("inspect");
    if (successful && connectTools.has(call.name)) operations.add("connect");
    if (successful && call.name === "ssh_upload_file") operations.add("upload");
    if (successful && call.name === "ssh_download_file")
      operations.add("download");
    const childEvidence = Array.isArray(data?.operationEvidence)
      ? data.operationEvidence.filter(
          (operation): operation is CodingOperation =>
            [
              "inspect",
              "modify",
              "execute",
              "validate",
              "connect",
              "upload",
              "download",
            ].includes(String(operation)),
        )
      : [];
    for (const operation of childEvidence)
      if (operation !== "validate") operations.add(operation);
    if (childEvidence.includes("modify")) lastMutation = sequence;
    if (childEvidence.includes("validate")) lastValidation = sequence + 0.5;

    const command = ["run_command", "ssh_run"].includes(call.name)
      ? String(call.input.command ?? "")
      : "";
    // Command text only describes intent. It cannot prove that the workspace
    // actually changed (for example `2>$null` or a no-op formatter). Mutation
    // evidence must come from structured tool-result metadata.
    const mutated =
      successful &&
      (call.name === "wait_agent" || call.name === "stop_agent"
        ? childEvidence.includes("modify")
        : !["ssh_upload_file", "ssh_download_file"].includes(call.name) &&
          hasActualMutation(data));
    if (mutated) {
      operations.add("modify");
      lastMutation = sequence;
    }

    const executed =
      data?.executed === true &&
      (successful ||
        data.exitCode !== undefined ||
        call.name === "diagnostics");
    if (executeTools.has(call.name) && executed) operations.add("execute");
    if (
      ["mysql_query", "sqlserver_query", "mongodb_execute"].includes(
        call.name,
      ) &&
      data?.executed === true &&
      data.changed !== true
    )
      operations.add("inspect");
    if (["run_command", "ssh_run"].includes(call.name)) {
      if (
        (successful || (executed && data?.exitCode === 1)) &&
        isInspectionCommand(command)
      )
        operations.add("inspect");
      if (successful && executed && isValidationCommand(command))
        lastValidation = sequence;
    }
    if (call.name === "diagnostics" && successful && data?.executed === true) {
      operations.add("execute");
      lastValidation = sequence;
    }
  }
  if (lastValidation > lastMutation) operations.add("validate");
  return operations;
}

export function missingRequestedCodingOperations(
  requested: ReadonlySet<CodingOperation>,
  evidence: ReadonlySet<CodingOperation>,
) {
  return [...requested].filter((operation) => !evidence.has(operation));
}

/**
 * Inspection is useful evidence when tools are available, but it is not a
 * side effect. A screenshot, attachment, or supplied error can be answered
 * without opening the workspace, so inspection alone must not become a failed
 * task.
 */
export function codingOperationsRequiringToolEvidence(
  operations: ReadonlySet<CodingOperation>,
) {
  return new Set(
    [...operations].filter((operation) => operation !== "inspect"),
  );
}

export function missingVerifiedCodingOperations(
  required: ReadonlySet<CodingOperation>,
  evidence: ReadonlySet<CodingOperation>,
  history: CodingVerificationHistoryItem[],
) {
  const noChangeEvidence = hasVerifiedNoChangeEvidence(history);
  const noChangeReport = hasVerifiedNoChangeReport(history);
  return missingRequestedCodingOperations(required, evidence).filter(
    (operation) =>
      !(
        (operation === "modify" && noChangeEvidence) ||
        (operation === "validate" && noChangeReport)
      ),
  );
}
