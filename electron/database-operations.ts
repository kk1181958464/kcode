type QueryFn = (session: string, requestId: string, input: any, signal: AbortSignal) => Promise<string>;
type DisconnectFn = (session: string) => Promise<boolean>;
export function databaseQueryResult(sql: string, output: string, mutationAttempted: boolean, changed: boolean) {
  return { command: sql, output, executed: true, changed, mutationAttempted };
}
export async function executeSqlQuery(session: string, requestId: string, input: { sql?: unknown; values?: unknown }, signal: AbortSignal, query: QueryFn, mutationAttempted: boolean, changed: (sql: string, output: string) => boolean) {
  const sql = String(input.sql || "");
  const values = Array.isArray(input.values) ? input.values : [];
  const output = await query(session, requestId, { sql, values }, signal);
  return databaseQueryResult(sql, output, mutationAttempted, changed(sql, output));
}
export async function disconnectDatabase(session: string, disconnect: DisconnectFn, label: string) {
  return { output: (await disconnect(session)) ? `${label} 连接已关闭` : `当前任务没有活动的 ${label} 连接` };
}

const READ_ONLY_MONGO_OPERATIONS = new Set(["find", "aggregate", "countDocuments", "distinct"]);

export function mongoMutationAttempted(operation: unknown) {
  return !READ_ONLY_MONGO_OPERATIONS.has(String(operation || ""));
}

export function mongoOperationResult(operation: unknown, output: string) {
  const mutationAttempted = mongoMutationAttempted(operation);
  return { output, executed: true, changed: mutationAttempted ? mutationChangedFromOutput(output) : false, mutationAttempted };
}

function mutationChangedFromOutput(output: string) {
  return /(?:inserted|deleted|modified|matched|upserted|updated|removed)(?:Count)?\s*[":=]\s*[1-9]/i.test(output);
}
