import test from "node:test";
import assert from "node:assert/strict";
import { classifyMysqlSql, redactSqlForActivity } from "./sql-policy";

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

test("redacts credential-bearing SQL", () => {
  assert.equal(
    redactSqlForActivity("CREATE USER app IDENTIFIED BY 'secret'"),
    "[包含凭据的 SQL 已隐藏]",
  );
  assert.equal(redactSqlForActivity("SELECT 1"), "SELECT 1");
});
