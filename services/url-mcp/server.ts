/**
 * url-mcp — 把「读取网页内容」封装成 MCP 工具（任务③链接档，工具侧路线）
 *
 * 设计 docs/v2/link-and-file-artifacts-design.md §一。agent 在会话/工作流中
 * 自主调用 url_reader 读取用户给的链接内容。平台侧零改动（网关注册+挂员工）。
 * 传输：streamable_http（POST 单条 JSON-RPC，与网关契约同 tsw-mcp）。
 *
 * 唯一实现（TS，node ≥23 原生 type stripping 直跑：`node server.ts`，
 * 零依赖零构建；曾并存 bun 专用版 server.ts 与 node 手写版 server.mjs，
 * 双份漂移后收敛于此）。类型检查：npx tsc --noEmit server.ts。
 *
 * 安全（业界 MCP fetch server 标配，逐项对标）：
 * - 协议白名单 http/https（禁 file/ftp/data）
 * - SSRF：IP 直连先查私网；域名 DNS 解析后拒绝私网/环回/链路本地
 * - 响应大小上限 2MB + 文本截断 20k chars；硬超时 8s
 * - Content-Type 白名单（二进制返回「不可读」提示而非吞错）
 *
 * 运行：node server.ts（PORT 默认 8624；显式绑 0.0.0.0，防反代 502）
 */

import http from "node:http";
import dns from "node:dns/promises";

const PORT = Number(process.env.PORT ?? 8624);
const PROTOCOL_VERSION = "2025-06-18";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 20_000;
const TIMEOUT_MS = 8_000;
const ALLOWED_CT = ["text/html", "text/plain", "application/json", "text/markdown", "application/xml", "text/xml", "text/csv"];

// ---------------------------------------------------------------- SSRF 防护

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
];

function isPrivateIp(ip: string): boolean {
  if (PRIVATE_V4.some((re) => re.test(ip))) return true;
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("::ffff:")) return isPrivateIp(lower.slice(7));
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

async function assertPublicHost(hostname: string): Promise<void> {
  let addrs: string[] = [];
  if (IPV4_RE.test(hostname)) {
    addrs = [hostname]; // IP 直连：跳过 DNS，直接查（否则本机 hosts/解析差异可绕过）
  } else {
    try { addrs = await dns.resolve4(hostname); } catch { /* v6-only 域名走下一行 */ }
    try { addrs = [...addrs, ...(await dns.resolve6(hostname))]; } catch { /* 无 v6 记录 */ }
  }
  if (!addrs.length) throw new Error(`无法解析主机 ${hostname}`);
  for (const ip of addrs) {
    if (isPrivateIp(ip)) throw new Error(`目标地址 ${ip} 属于内网/保留地址，出于安全策略拒绝访问`);
  }
}

// ---------------------------------------------------------------- 抓取层

interface FetchResult {
  url: string;
  status: number;
  content_type: string;
  title: string | null;
  text: string;
  truncated: boolean;
}

function extractHtml(raw: string): { title: string | null; text: string } {
  const tm = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? tm[1].trim().slice(0, 200) : null;
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

async function readUrl(rawUrl: string): Promise<FetchResult> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error(`无效 URL：${rawUrl}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`仅支持 http/https（收到 ${url.protocol}）`);
  }
  await assertPublicHost(url.hostname);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; url-mcp/0.1)",
        "accept": "text/html,text/plain,application/json,text/markdown,*/*",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`请求失败（${TIMEOUT_MS / 1000}s 超时或网络不可达）：${msg}`);
  } finally {
    clearTimeout(timer);
  }

  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_CT.includes(contentType)) {
    return { url: url.href, status: res.status, content_type: contentType, title: null,
      text: `（内容类型 ${contentType || "未知"} 不在可读白名单内，无法提取文本）`, truncated: false };
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) {
    return { url: url.href, status: res.status, content_type: contentType, title: null,
      text: `（响应声明 ${declared} 字节，超过上限，拒绝读取）`, truncated: true };
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    return { url: url.href, status: res.status, content_type: contentType, title: null,
      text: `（响应 ${buf.byteLength} 字节，超过上限，拒绝读取）`, truncated: true };
  }
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);

  const { title, text } = contentType === "text/html" ? extractHtml(raw) : { title: null, text: raw };
  const truncated = text.length > MAX_TEXT_CHARS;
  return { url: url.href, status: res.status, content_type: contentType, title,
    text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, truncated };
}

// ---------------------------------------------------------------- 工具定义

const TOOLS = [{
  name: "url_reader",
  // 工具描述是 prompt 工程的一部分：改动需评估对 agent 行为的影响
  //（曾因未排除附件，agent 对 .html 网页保存件误调本工具）。
  description:
    "读取一个 http/https 网页的文本内容（HTML 会抽正文、去脚本样式）。仅当用户消息里明确给出了 http/https 链接地址时才调用；用户上传的附件（含 .html 网页保存件）内容已解析注入消息，直接使用，不要对附件调用本工具。内网地址会被安全策略拒绝。",
  inputSchema: {
    type: "object" as const,
    properties: { url: { type: "string", description: "要读取的完整 URL（http/https）" } },
    required: ["url"],
  },
}];

// ---------------------------------------------------------------- MCP 协议层（streamable_http 单端点）

type JsonRpcId = string | number | null;
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

interface RpcOutcome { status: number; body: unknown | null }

async function handleMessage(msg: any): Promise<RpcOutcome> {
  const { id, method, params } = msg ?? {};
  if (method === undefined || method.startsWith("notifications/")) return { status: 202, body: null };

  switch (method) {
    case "initialize":
      return { status: 200, body: rpcResult(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "url-mcp", version: "0.1.0" },
      }) };
    case "ping":
      return { status: 200, body: rpcResult(id, {}) };
    case "tools/list":
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    case "tools/call": {
      const name = String(params?.name ?? "");
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const started = Date.now();
      try {
        const data = name === "url_reader" ? await readUrl(String(args.url ?? "")) : (() => { throw new Error(`未知工具：${name}`); })();
        console.log(`[url-mcp] ${name}(${String(args.url ?? "")}) ok ${Date.now() - started}ms`);
        return { status: 200, body: rpcResult(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false }) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`[url-mcp] ${name}(${String(args.url ?? "")}) error: ${message}`);
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
    if (req.method === "OPTIONS") { res.writeHead(204, headers); res.end(); return; }
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "url-mcp", tools: TOOLS.map((t) => t.name) }));
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
        const outcome = await handleMessage(message);
        status = outcome.status;
        if (outcome.body) replies.push(outcome.body);
      }
      if (!replies.length) { res.writeHead(status, headers); res.end(); return; }
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]));
    })();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[url-mcp] listening on :${PORT}`);
});
