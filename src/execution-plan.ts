import type { AgentActivity } from "./types";

export type ExecutionPlanStepStatus =
  "pending" | "running" | "completed" | "failed";

export type ExecutionPlanSummary = {
  steps: string[];
  current: number;
  statuses: ExecutionPlanStepStatus[];
};

const CHINESE_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function chineseStepNumber(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "十") return 10;
  if (value.length === 2 && value[0] === "十")
    return 10 + (CHINESE_DIGITS[value[1]] ?? 0);
  if (value.length === 2 && value[1] === "十")
    return (CHINESE_DIGITS[value[0]] ?? 0) * 10;
  if (value.length === 3 && value[1] === "十")
    return (
      (CHINESE_DIGITS[value[0]] ?? 0) * 10 + (CHINESE_DIGITS[value[2]] ?? 0)
    );
  return CHINESE_DIGITS[value] ?? 0;
}

function cleanStepText(value: string) {
  return value
    .replace(/^\s*[*_-]\s*/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[:：\-]\s*/, "")
    .replace(/[。；;]+$/, "");
}

/** Extracts an explicit numbered plan from a tool-call turn's narration. */
export function extractExecutionPlan(text: string, maxSteps = 12) {
  const steps: { number: number; text: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:(\d{1,2})\s*[.)、:]|第\s*([一二三四五六七八九十\d]{1,3})\s*步)\s*(.+?)\s*$/,
    );
    if (!match) continue;
    const number = chineseStepNumber(match[1] || match[2] || "");
    const value = cleanStepText(match[3] || "");
    if (!number || !value || value.length < 2) continue;
    steps.push({ number, text: value.slice(0, 180) });
  }
  if (steps.length < 2) return [];

  const ordered: string[] = [];
  let expected = steps[0].number;
  for (const step of steps) {
    if (step.number < expected || step.number > expected + 1) continue;
    if (step.number === expected) {
      ordered.push(step.text);
      expected += 1;
    }
    if (ordered.length >= maxSteps) break;
  }
  return ordered.length >= 2 ? ordered : [];
}

export function sameExecutionPlan(first: string[], second: string[]) {
  return (
    first.length === second.length &&
    first.every((step, index) => step === second[index])
  );
}

export function summarizeExecutionPlan(
  activities: readonly AgentActivity[],
): ExecutionPlanSummary | undefined {
  const source = [...activities]
    .reverse()
    .find((activity) => activity.planSteps && activity.planSteps.length >= 2);
  if (!source?.planSteps?.length) return undefined;
  const steps = source.planSteps;
  const current = Math.min(Math.max(0, source.planStep ?? 0), steps.length - 1);
  const statuses = steps.map<ExecutionPlanStepStatus>((_, index) => {
    const related = activities.filter(
      (activity) => activity.planStep === index,
    );
    const last = related.at(-1);
    if (last?.status === "running" || last?.status === "waiting")
      return "running";
    if (last?.status === "failed" || last?.status === "denied") return "failed";
    if (last && (last.status === "success" || last.status === "completed"))
      return "completed";
    return "pending";
  });
  return { steps, current, statuses };
}
