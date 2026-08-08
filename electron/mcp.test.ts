import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import {
  callMcpTool,
  closeMcpServers,
  configureMcpServers,
  listMcpTools,
} from "./mcp";

test("lists and calls tools on a stdio MCP server", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kcode-mcp-"));
  const server = path.join(directory, "server.mjs");
  await writeFile(
    server,
    `import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize")
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result:{protocolVersion:"2024-11-05",capabilities:{}}}) + "\\n");
  else if (message.method === "tools/list")
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result:{tools:[{name:"echo",description:"Echo text",inputSchema:{type:"object",properties:{text:{type:"string"}}}}]}}) + "\\n");
  else if (message.method === "tools/call")
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result:{content:[{type:"text",text:String(message.params.arguments.text)}]}}) + "\\n");
});
`,
    "utf8",
  );
  configureMcpServers([
    {
      id: "fixture",
      name: "Fixture",
      enabled: true,
      transport: { type: "stdio", command: process.execPath, args: [server] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]);
  try {
    const tools = await listMcpTools("fixture");
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["echo"],
    );
    const result = await callMcpTool("fixture", "echo", { text: "hello" });
    assert.equal(result.output, "hello");
    assert.equal(result.isError, false);
  } finally {
    closeMcpServers();
    await rm(directory, { recursive: true, force: true });
  }
});

test("initializes an HTTP MCP session and parses SSE responses", async () => {
  const methods: string[] = [];
  const sessionHeaders: Array<string | undefined> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id?: number;
      method: string;
      params?: Record<string, any>;
    };
    methods.push(message.method);
    sessionHeaders.push(
      request.headers["mcp-session-id"] as string | undefined,
    );
    if (message.method === "initialize") {
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "session-1",
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2024-11-05", capabilities: {} },
        }),
      );
      return;
    }
    if (message.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    if (message.method === "tools/list") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } })}\n\n`,
      );
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            { type: "text", text: String(message.params?.arguments?.text) },
          ],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  configureMcpServers([
    {
      id: "http-fixture",
      name: "HTTP Fixture",
      enabled: true,
      transport: { type: "http", url: `http://127.0.0.1:${address.port}` },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]);
  try {
    assert.deepEqual(
      (await listMcpTools("http-fixture")).map((tool) => tool.name),
      ["echo"],
    );
    assert.equal(
      (await callMcpTool("http-fixture", "echo", { text: "http" })).output,
      "http",
    );
    assert.deepEqual(methods, [
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    assert.deepEqual(sessionHeaders, [
      undefined,
      "session-1",
      "session-1",
      "session-1",
    ]);
  } finally {
    closeMcpServers();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("uses the legacy SSE endpoint and routes JSON-RPC replies", async () => {
  const methods: string[] = [];
  let eventStream:
    | import("node:http").ServerResponse<import("node:http").IncomingMessage>
    | undefined;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/sse") {
      eventStream = response;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write("event: endpoint\ndata: /messages\n\n");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id?: number;
      method: string;
      params?: Record<string, any>;
    };
    methods.push(message.method);
    if (message.id !== undefined && eventStream) {
      const result =
        message.method === "initialize"
          ? { protocolVersion: "2024-11-05", capabilities: {} }
          : message.method === "tools/list"
            ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
            : {
                content: [
                  {
                    type: "text",
                    text: String(message.params?.arguments?.text),
                  },
                ],
              };
      eventStream.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
      );
    }
    response.writeHead(202);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  configureMcpServers([
    {
      id: "sse-fixture",
      name: "SSE Fixture",
      enabled: true,
      transport: { type: "sse", url: `http://127.0.0.1:${address.port}/sse` },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]);
  try {
    assert.deepEqual(
      (await listMcpTools("sse-fixture")).map((tool) => tool.name),
      ["echo"],
    );
    assert.equal(
      (await callMcpTool("sse-fixture", "echo", { text: "sse" })).output,
      "sse",
    );
    assert.deepEqual(methods, [
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
  } finally {
    closeMcpServers();
    eventStream?.end();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
