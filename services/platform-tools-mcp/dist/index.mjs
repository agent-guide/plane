// server.ts
import http from "node:http";

// tools/ask.ts
var PLANE_BASE = (process.env.PLANE_INTERNAL_BASE ?? "http://127.0.0.1:8001").replace(/\/$/, "");
var TOKEN = process.env.ORCHESTRATION_INTERNAL_TOKEN ?? "";
var ASK_WAIT_MAX_MS = Number(process.env.ASK_WAIT_MAX_MS ?? 55 * 6e4);
var POLL_INTERVAL_MS = 3e3;
var ask = {
  name: "request_human_input",
  description: "\u7F3A\u5C11\u5B8C\u6210\u4EFB\u52A1\u6240\u5FC5\u9700\u7684\u6570\u636E\uFF0C\u6216\u9047\u5230\u5FC5\u987B\u7528\u6237\u62CD\u677F\u7684\u77DB\u76FE\uFF08\u4E0D\u786E\u8BA4\u5C31\u4F1A\u505A\u9519\uFF09\u65F6\u8C03\u7528\u3002\u8C03\u7528\u540E\u4F1A\u7B49\u5F85\u7528\u6237\u7B54\u590D\uFF0C\u7B54\u590D\u5185\u5BB9\u5C06\u4F5C\u4E3A\u7ED3\u679C\u8FD4\u56DE\u2014\u2014\u62FF\u5230\u540E\u7EE7\u7EED\u5B8C\u6210\u4EFB\u52A1\u3002\u4E0D\u8981\u5BF9\u5DF2\u7ECF\u56DE\u7B54\u8FC7\u7684\u95EE\u9898\u91CD\u590D\u8C03\u7528\u3002",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "\u8981\u95EE\u7528\u6237\u7684\u95EE\u9898\uFF0C\u7528\u4E1A\u52A1\u8BED\u8A00\u8BF4\u6E05\u695A\u7F3A\u4EC0\u4E48/\u9700\u8981\u786E\u8BA4\u4EC0\u4E48" },
      options: { type: "array", items: { type: "string" }, description: "\u53EF\u9009\uFF1A\u5019\u9009\u7B54\u6848\uFF08\u7528\u6237\u70B9\u9009\u6216\u53C2\u8003\uFF09" },
      ticket: { type: "string", description: "\u4EFB\u52A1\u6307\u4EE4\u4E2D\u7ED9\u51FA\u7684\u5E73\u53F0\u7968\u636E" }
    },
    required: ["question", "ticket"]
  },
  async run(args) {
    const ticket = String(args.ticket ?? "").trim();
    const question = String(args.question ?? "").trim();
    if (!ticket) throw new Error("ticket required");
    if (!question) throw new Error("question required");
    const options = Array.isArray(args.options) ? args.options.map(String).filter(Boolean) : void 0;
    const reg = await fetch(`${PLANE_BASE}/api/internal/platform-tools/ask/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Orchestration-Token": TOKEN },
      body: JSON.stringify({ ticket, question, options })
    });
    if (reg.status === 403) throw new Error("\u7968\u636E\u65E0\u6548\u6216\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u6309\u4EFB\u52A1\u6307\u4EE4\u4E2D\u7684\u5F53\u524D\u7968\u636E\u8C03\u7528");
    if (reg.status === 401) throw new Error("\u5E73\u53F0\u5DE5\u5177\u670D\u52A1\u672A\u6388\u6743\uFF08\u8054\u7CFB\u7BA1\u7406\u5458\uFF09");
    if (!reg.ok) throw new Error(`\u6C42\u52A9\u767B\u8BB0\u5931\u8D25\uFF08${reg.status}\uFF09`);
    const deadline = Date.now() + ASK_WAIT_MAX_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const res = await fetch(`${PLANE_BASE}/api/internal/platform-tools/ask/${encodeURIComponent(ticket)}`, {
        headers: { "X-Orchestration-Token": TOKEN }
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.status === "answered") return { content: [{ type: "text", text: data.answer ?? "" }] };
      if (data.status === "none") throw new Error("\u6C42\u52A9\u8BB0\u5F55\u4E0D\u5B58\u5728\uFF08\u53EF\u80FD\u5DF2\u88AB\u7EC8\u6001\u6536\u53E3\uFF09\uFF0C\u8BF7\u6309 NEED_INPUT \u6587\u672C\u534F\u8BAE\u91CD\u95EE");
    }
    return {
      content: [{ type: "text", text: "\u5C1A\u672A\u6536\u5230\u7B54\u590D\uFF08\u7B49\u5F85\u4E0A\u9650\u5DF2\u5230\uFF09\u3002\u53EF\u518D\u6B21\u8C03\u7528\u672C\u5DE5\u5177\u7EE7\u7EED\u7B49\u5F85\uFF0C\u6216\u6309\u4EFB\u52A1\u60C5\u51B5\u6536\u53E3\u3002" }]
    };
  }
};

// tools/supplements.ts
var PLANE_BASE2 = (process.env.PLANE_INTERNAL_BASE ?? "http://127.0.0.1:8001").replace(/\/$/, "");
var TOKEN2 = process.env.ORCHESTRATION_INTERNAL_TOKEN ?? "";
var supplements = {
  name: "request_supplements",
  description: "\u67E5\u8BE2\u7528\u6237\u5728\u4EFB\u52A1\u6267\u884C\u671F\u95F4\u6709\u6CA1\u6709\u8865\u5145\u65B0\u4FE1\u606F\uFF08\u8BC4\u8BBA/\u9644\u4EF6\uFF09\u3002\u6BCF\u4E2A\u4E3B\u8981\u9636\u6BB5\u5B8C\u6210\u540E\u8C03\u7528\u4E00\u6B21\uFF1B\u8FD4\u56DE hasNew=false \u8BF4\u660E\u65E0\u65B0\u589E\uFF0C\u7ACB\u5373\u7EE7\u7EED\u65E2\u5B9A\u6D41\u7A0B\u3002\u4E0D\u8981\u8F6E\u8BE2\u7B49\u5F85\u3002",
  inputSchema: {
    type: "object",
    properties: {
      ticket: { type: "string", description: "\u4EFB\u52A1\u6307\u4EE4\u4E2D\u7ED9\u51FA\u7684\u5E73\u53F0\u7968\u636E" }
    },
    required: ["ticket"]
  },
  async run(args) {
    const ticket = String(args.ticket ?? "").trim();
    if (!ticket) throw new Error("ticket required");
    const res = await fetch(`${PLANE_BASE2}/api/internal/platform-tools/supplements/${encodeURIComponent(ticket)}`, {
      headers: { "X-Orchestration-Token": TOKEN2 }
    });
    if (res.status === 403) throw new Error("\u7968\u636E\u65E0\u6548\u6216\u5DF2\u8FC7\u671F");
    if (!res.ok) throw new Error(`\u8865\u6599\u67E5\u8BE2\u5931\u8D25\uFF08${res.status}\uFF09`);
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
};

// server.ts
var PORT = Number(process.env.PORT ?? 8626);
var PROTOCOL_VERSION = "2025-06-18";
var TOOLS = [ask, supplements];
var rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
var rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
async function handleMessage(msg) {
  const { id, method, params } = msg ?? {};
  if (method === void 0 || method.startsWith("notifications/")) return { status: 202, body: null };
  switch (method) {
    case "initialize":
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "platform-tools-mcp", version: "0.1.0" }
        })
      };
    case "ping":
      return { status: 200, body: rpcResult(id, {}) };
    case "tools/list":
      return {
        status: 200,
        body: rpcResult(id, {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
        })
      };
    case "tools/call": {
      const name = String(params?.name ?? "");
      const args = params?.arguments ?? {};
      const tool = TOOLS.find((t) => t.name === name);
      const started = Date.now();
      try {
        if (!tool) throw new Error(`\u672A\u77E5\u5DE5\u5177\uFF1A${name}`);
        const data = await tool.run(args);
        console.log(`[platform-tools-mcp] ${name}(${JSON.stringify(args)}) ok ${Date.now() - started}ms`);
        return {
          status: 200,
          body: rpcResult(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false })
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`[platform-tools-mcp] ${name}(${JSON.stringify(args)}) error: ${message}`);
        return { status: 200, body: rpcResult(id, { content: [{ type: "text", text: message }], isError: true }) };
      }
    }
    case "resources/list":
      return { status: 200, body: rpcResult(id, { resources: [] }) };
    case "prompts/list":
      return { status: 200, body: rpcResult(id, { prompts: [] }) };
    default:
      return { status: 200, body: rpcError(id, -32601, `method not found: ${String(method)}`) };
  }
}
var server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type,authorization,mcp-session-id,mcp-protocol-version",
      "access-control-allow-methods": "POST,GET,OPTIONS"
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "platform-tools-mcp", tools: TOOLS.map((t) => t.name) }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "null");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify(rpcError(null, -32700, "parse error")));
      return;
    }
    const messages = Array.isArray(payload) ? payload : [payload];
    void (async () => {
      const replies = [];
      let status = 200;
      for (const message of messages) {
        const outcome = await handleMessage(message);
        status = outcome.status;
        if (outcome.body) replies.push(outcome.body);
      }
      if (!replies.length) {
        res.writeHead(status, headers);
        res.end();
        return;
      }
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]));
    })();
  });
});
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[platform-tools-mcp] listening on :${PORT} (tools: ${TOOLS.map((t) => t.name).join(", ")})`);
});
