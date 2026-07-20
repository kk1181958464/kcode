import { Parser } from "node-sql-parser";

export type SqlRisk = "read" | "write" | "destructive";

const parser = new Parser();
const destructiveTypes = new Set(["delete", "drop", "truncate"]);
const readTypes = new Set(["select", "show", "describe", "desc", "explain"]);

function classifyNode(node: any): SqlRisk {
  const type = String(node?.type || "").toLowerCase();
  if (!type) return "destructive";
  if (destructiveTypes.has(type)) return "destructive";
  if (type === "call") return "destructive";
  if (type === "select") {
    const into = node.into;
    if (into?.keyword || into?.position) return "write";
    if (node.locking_read) return "write";
    return "read";
  }
  if (readTypes.has(type)) return "read";
  return "write";
}

function classifySql(sql: string, database: "MySQL" | "TransactSQL"): SqlRisk {
  try {
    const parsed = parser.astify(sql, { database });
    const statements = Array.isArray(parsed) ? parsed : [parsed];
    if (statements.length !== 1) return "destructive";
    return classifyNode(statements[0]);
  } catch {
    // Unknown syntax must never fall through to read-only permissions.
    return "destructive";
  }
}

export function classifyMysqlSql(sql: string): SqlRisk {
  return classifySql(sql, "MySQL");
}

export function classifySqlServerSql(sql: string): SqlRisk {
  return classifySql(sql, "TransactSQL");
}

export function assertSingleSqlServerStatement(sql: string) {
  try {
    const parsed = parser.astify(sql, { database: "TransactSQL" });
    if (Array.isArray(parsed) && parsed.length !== 1)
      throw new Error("SQL Server 每次只允许执行一条 SQL 语句。");
  } catch (error) {
    if (error instanceof Error && /每次只允许/.test(error.message)) throw error;
    throw new Error("SQL Server SQL 语句无法安全解析，已拒绝执行。");
  }
}
