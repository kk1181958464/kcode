import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSingleSqlServerStatement,
  classifyMysqlSql,
  classifySqlServerSql,
} from "./sql-policy";

test("classifies SQL Server statements with the T-SQL dialect", () => {
  assert.equal(classifySqlServerSql("SELECT TOP 10 * FROM users"), "read");
  assert.equal(classifySqlServerSql("UPDATE users SET active = 1"), "write");
  assert.equal(
    classifySqlServerSql("DELETE FROM users WHERE id = @p1"),
    "destructive",
  );
});

test("rejects SQL Server batches with multiple statements", () => {
  assert.doesNotThrow(() =>
    assertSingleSqlServerStatement("SELECT ';' AS value;"),
  );
  assert.throws(
    () => assertSingleSqlServerStatement("SELECT 1; DELETE FROM users;"),
    /只允许执行一条/,
  );
});

test("classifies MySQL statements by parsed effect", () => {
  assert.equal(classifyMysqlSql("SELECT * FROM users"), "read");
  assert.equal(classifyMysqlSql("SELECT * FROM users WHERE id = ?"), "read");
  assert.equal(classifyMysqlSql("SHOW TABLES"), "read");
  assert.equal(classifyMysqlSql("INSERT INTO users(id) VALUES (1)"), "write");
  assert.equal(
    classifyMysqlSql("/* comment */ DROP TABLE users"),
    "destructive",
  );
  assert.equal(
    classifyMysqlSql(
      "WITH ids AS (SELECT id FROM users) DELETE FROM users WHERE id IN (SELECT id FROM ids)",
    ),
    "destructive",
  );
  assert.equal(
    classifyMysqlSql("SELECT * FROM users INTO OUTFILE '/tmp/users.csv'"),
    "write",
  );
  assert.equal(classifyMysqlSql("CALL destructive_procedure()"), "destructive");
  assert.equal(classifyMysqlSql("not valid sql"), "destructive");
});
