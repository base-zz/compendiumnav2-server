import sqlite3 from "sqlite3";

function ensureValueExists(value, fieldName) {
  if (value === undefined || value === null) {
    throw new Error(`[MCP][SQLiteAuditLog] Missing required value: ${fieldName}`);
  }
}

export class SQLiteAuditLog {
  constructor(databasePath) {
    ensureValueExists(databasePath, "databasePath");

    this.databasePath = databasePath;
    this.database = new sqlite3.Database(this.databasePath);
  }

  async initialize() {
    const createTableSql = `
      CREATE TABLE IF NOT EXISTS mcp_tool_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        args_json TEXT,
        result_json TEXT,
        error_message TEXT,
        invoked_at TEXT NOT NULL
      )
    `;

    await this.run(createTableSql);

    const createIndexSql = `
      CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_invoked_at
      ON mcp_tool_audit (invoked_at)
    `;

    await this.run(createIndexSql);
  }

  async logToolCall({ requestId, toolName, status, argsJson, resultJson, errorMessage, invokedAt }) {
    ensureValueExists(toolName, "toolName");
    ensureValueExists(status, "status");
    ensureValueExists(invokedAt, "invokedAt");

    const insertSql = `
      INSERT INTO mcp_tool_audit (
        request_id,
        tool_name,
        status,
        args_json,
        result_json,
        error_message,
        invoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      requestId ?? null,
      toolName,
      status,
      argsJson ?? null,
      resultJson ?? null,
      errorMessage ?? null,
      invokedAt,
    ];

    await this.run(insertSql, params);
  }

  async getRecentCalls(limit) {
    ensureValueExists(limit, "limit");

    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("[MCP][SQLiteAuditLog] limit must be a positive integer");
    }

    const selectSql = `
      SELECT
        id,
        request_id AS requestId,
        tool_name AS toolName,
        status,
        args_json AS argsJson,
        result_json AS resultJson,
        error_message AS errorMessage,
        invoked_at AS invokedAt
      FROM mcp_tool_audit
      ORDER BY id DESC
      LIMIT ?
    `;

    return this.all(selectSql, [limit]);
  }

  run(sql, params = []) {
    ensureValueExists(sql, "sql");

    return new Promise((resolve, reject) => {
      this.database.run(sql, params, function onRun(error) {
        if (error) {
          reject(error);
          return;
        }
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  all(sql, params = []) {
    ensureValueExists(sql, "sql");

    return new Promise((resolve, reject) => {
      this.database.all(sql, params, (error, rows) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(rows);
      });
    });
  }

  close() {
    return new Promise((resolve, reject) => {
      this.database.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
