export type BrowserOperation = "open" | "type" | "click" | "verify";

export type BrowserVerificationHistoryItem =
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

export function browserOperationsRequiredByCalls(
  calls: ReadonlyArray<{ name: string }>,
) {
  const operations = new Set<BrowserOperation>();
  for (const call of calls) {
    if (call.name === "browser_open") operations.add("open");
    if (
      call.name === "browser_type" ||
      call.name === "browser_fill_credential"
    ) {
      operations.add("type");
      operations.add("verify");
    }
    if (call.name === "browser_click") {
      operations.add("click");
      operations.add("verify");
    }
  }
  return operations;
}

export function successfulBrowserEvidence(
  history: BrowserVerificationHistoryItem[],
) {
  const calls = new Map<string, string>();
  for (const item of history)
    if (item.kind === "calls")
      for (const call of item.calls) calls.set(call.id, call.name);

  const operations = new Set<BrowserOperation>();
  let sequence = 0;
  let lastInteraction = -1;
  let lastVerification = -1;
  for (const item of history) {
    if (item.kind !== "result") continue;
    sequence += 1;
    let success = false;
    try {
      success = Boolean(
        (JSON.parse(item.content) as { success?: boolean }).success,
      );
    } catch {
      // Legacy unstructured output is not execution proof.
    }
    if (!success) continue;
    const name = calls.get(item.callId);
    let childEvidence: BrowserOperation[] = [];
    try {
      const data = (
        JSON.parse(item.content) as { data?: Record<string, unknown> }
      ).data;
      childEvidence = Array.isArray(data?.browserOperationEvidence)
        ? data.browserOperationEvidence.filter(
            (operation): operation is BrowserOperation =>
              ["open", "type", "click", "verify"].includes(String(operation)),
          )
        : [];
    } catch {
      // Ignore malformed optional child evidence.
    }
    if (name === "browser_open") operations.add("open");
    if (name === "browser_type") {
      operations.add("type");
      lastInteraction = sequence;
    }
    if (name === "browser_click") {
      operations.add("click");
      lastInteraction = sequence;
    }
    if (name === "browser_snapshot" || name === "browser_screenshot")
      lastVerification = sequence;
    for (const operation of childEvidence) {
      operations.add(operation);
      if (operation === "type" || operation === "click")
        lastInteraction = sequence;
      if (operation === "verify") lastVerification = sequence + 0.5;
    }
  }
  if (lastVerification > lastInteraction) operations.add("verify");
  return operations;
}

export function missingRequestedBrowserOperations(
  requested: ReadonlySet<BrowserOperation>,
  evidence: ReadonlySet<BrowserOperation>,
) {
  return [...requested].filter((operation) => !evidence.has(operation));
}
