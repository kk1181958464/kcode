/**
 * Local mock model server speaking the openai-chat SSE protocol. Scripts a
 * fixed two-round conversation so the CLI PoC can prove its full loop
 * (task → runAgent → HTTP → SSE parse → tool call → tool exec → render)
 * without a real provider/API key.
 *
 * Round 1: emit a write_file tool call.
 * Round 2 (after the tool result comes back): emit a final text answer.
 */
import http from "node:http";

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}");
    console.log(`[mock] ${req.method} ${req.url} bytes=${body.length}`);
    // Round 2 is detected by our own tool call id appearing in the history —
    // not the word "tool" (the system prompt is full of it).
    const hasToolResult = body.includes("call_1");
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    if (!hasToolResult) {
      // Round 1: stream a tool call to write hello.txt.
      sse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({
                      path: "hello.txt",
                      content: "hello from cli poc\n",
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
      sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      // Round 2: final natural-language answer.
      for (const piece of ["已创建 ", "hello.txt", "，任务完成。"]) {
        sse(res, { choices: [{ delta: { content: piece } }] });
      }
      sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

const port = Number(process.argv[2] || 8899);
server.listen(port, "127.0.0.1", () => {
  console.log(`mock model on http://127.0.0.1:${port}`);
});
