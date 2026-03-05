import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SQLiteAuditLog } from "./mcp/sqliteAuditLog.js";

function ensureEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") {
    throw new Error(`[MCP] Missing required environment variable: ${name}`);
  }
  return value;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({ serializationError: String(error) });
  }
}

function normalizeLimit(rawLimit) {
  if (rawLimit === undefined || rawLimit === null) {
    throw new Error("limit is required");
  }

  if (!Number.isInteger(rawLimit) || rawLimit <= 0) {
    throw new Error("limit must be a positive integer");
  }

  return rawLimit;
}

async function startMcpServer() {
  const databasePath = ensureEnv("MCP_SQLITE_PATH");

  const auditLog = new SQLiteAuditLog(databasePath);
  await auditLog.initialize();

  const server = new McpServer({
    name: "compendiumnav2-mcp",
    version: "1.0.0",
  });

  const executeWithAudit = async (toolName, args, operation) => {
    if (toolName === undefined || toolName === null) {
      throw new Error("toolName is required");
    }

    const invokedAt = new Date().toISOString();
    const requestId = null;

    try {
      const result = await operation();

      await auditLog.logToolCall({
        requestId,
        toolName,
        status: "success",
        argsJson: safeJsonStringify(args),
        resultJson: safeJsonStringify(result),
        errorMessage: null,
        invokedAt,
      });

      return {
        content: [
          {
            type: "text",
            text: safeJsonStringify(result),
          },
        ],
      };
    } catch (error) {
      await auditLog.logToolCall({
        requestId,
        toolName,
        status: "error",
        argsJson: safeJsonStringify(args),
        resultJson: null,
        errorMessage: error instanceof Error ? error.message : String(error),
        invokedAt,
      });

      throw error;
    }
  };

  server.tool(
    "mcp_health",
    "Returns MCP process health and logging backend status.",
    {},
    async () => {
      return executeWithAudit("mcp_health", {}, async () => {
        return {
          status: "ok",
          timestamp: new Date().toISOString(),
          processId: process.pid,
          sqlitePath: databasePath,
        };
      });
    }
  );

  server.tool(
    "mcp_recent_tool_calls",
    "Returns recent MCP tool audit records from SQLite.",
    {
      limit: z.number().int().positive(),
    },
    async ({ limit }) => {
      return executeWithAudit("mcp_recent_tool_calls", { limit }, async () => {
        const normalizedLimit = normalizeLimit(limit);
        const calls = await auditLog.getRecentCalls(normalizedLimit);
        return {
          count: calls.length,
          calls,
        };
      });
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", async () => {
    await auditLog.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await auditLog.close();
    process.exit(0);
  });
}

startMcpServer().catch((error) => {
  console.error("[MCP] Failed to start MCP server", error);
  process.exit(1);
});
