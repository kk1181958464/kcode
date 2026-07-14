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

export function classifyMysqlSql(sql: string): SqlRisk {
  try {
    const parsed = parser.astify(sql, { database: "MySQL" });
    const statements = Array.isArray(parsed) ? parsed : [parsed];
    if (statements.length !== 1) return "destructive";
    return classifyNode(statements[0]);
  } catch {
    // Unknown syntax must never fall through to read-only permissions.
    return "destructive";
  }
}

export function redactSqlForActivity(sql: string) {
  if (
    /\b(create\s+user|alter\s+user|set\s+password|identified\s+(?:with\s+\S+\s+)?by)\b/i.test(
      sql,
    )
  )
    return "[包含凭据的 SQL 已隐藏]";
  return sql;
}
