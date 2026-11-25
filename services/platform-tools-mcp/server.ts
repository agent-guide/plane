/**
 * platform-tools-mcp — 通用工具 MCP 服务（聚合形态：单进程多工具）。
 *
 * 架构（docs/v2/mcp-tools-architecture.md）：协议层（本文件，稳定不动）+
 * 工具模块（tools/*.ts，每工具一个，自带安全约束）。新增通用工具只加
 * 模块文件与注册表一行。读 Plane 内部数据的工具不走本服务——按
 * plane-supplements 模式做 http_api 连接器直指 Plane 内部端点（零进程）。
 *
 * 平台链：gateway 侧 stable id 按工具粒度（mcp:<connector>:<tool>），聚合
 * 不影响 offering/租户工具/员工绑定的独立粒度。
 *
 * 传输：streamable_http（POST 单条 JSON-RPC，与网关契约同 tsw-mcp）。
 * 唯一实现（TS，node ≥23 原生 type stripping 直跑：`node server.ts`，
 * 零依赖零构建；类型检查 npm run typecheck）。运行 PORT 默认 8626，
 * 显式绑 0.0.0.0（防反代 502）。
 */
import http from "node:http";
import type { McpTool } from "./tool.ts";
import { ask } from "./tools/ask.ts";
import { supplements } from "./tools/supplements.ts";

const PORT = Number(process.env.PORT ?? 8626);
const PROTOCOL_VERSION = "2025-06-18";

/** 工具注册表：新增工具在此登记（模块在 tools/ 下实现） */
const TOOLS: McpTool[] = [ask, supplements];

// ---------------------------------------------------------------- MCP 协议层（streamable_http 单端点）

type JsonRpcId = string | number | null;
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

interface RpcOutcome {
  status: number;
  body: unknown | null;
}

async function handleMessage(msg: any): Promise<RpcOutcome> {
  const { id, method, params } = msg ?? {};
  if (method === undefined || method.startsWith("notifications/")) return { status: 202, body: null };

  switch (method) {
    case "initialize":
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "platform-tools-mcp", version: "0.1.0" },
        }),
      };
    case "ping":
      return { status: 200, body: rpcResult(id, {}) };
    case "tools/list":
      return {
        status: 200,
        body: rpcResult(id, {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        }),
      };
    case "tools/call": {
      const name = String(params?.name ?? "");
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === name);
      const started = Date.now();
      try {
        if (!tool) throw new Error(`未知工具：${name}`);
        const data = await tool.run(args);
        console.log(`[platform-tools-mcp] ${name}(${JSON.stringify(args)}) ok ${Date.now() - started}ms`);
        return {
          status: 200,
          body: rpcResult(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false }),
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

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type,authorization,mcp-session-id,mcp-protocol-version",
      "access-control-allow-methods": "POST,GET,OPTIONS",
    } as Record<string, string>;
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
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "null");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify(rpcError(null, -32700, "parse error")));
      return;
    }
    const messages = Array.isArray(payload) ? payload : [payload];
    void (async () => {
      const replies: unknown[] = [];
      let status = 200;
      for (const message of messages) {
        // JSON-RPC 批量消息按序处理（顺序语义）
        // eslint-disable-next-line no-await-in-loop
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
