// server.ts
import http from "node:http";

// tools/url-reader.ts
import dns from "node:dns/promises";
var MAX_BYTES = 2 * 1024 * 1024;
var MAX_TEXT_CHARS = 2e4;
var TIMEOUT_MS = 8e3;
var ALLOWED_CT = ["text/html", "text/plain", "application/json", "text/markdown", "application/xml", "text/xml", "text/csv"];
var PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
  // CGNAT
];
function isPrivateIp(ip) {
  if (PRIVATE_V4.some((re) => re.test(ip))) return true;
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("::ffff:")) return isPrivateIp(lower.slice(7));
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}
var IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
async function assertPublicHost(hostname) {
  let addrs = [];
  if (IPV4_RE.test(hostname)) {
    addrs = [hostname];
  } else {
    try {
      addrs = await dns.resolve4(hostname);
    } catch {
    }
    try {
      addrs = [...addrs, ...await dns.resolve6(hostname)];
    } catch {
    }
  }
  if (!addrs.length) throw new Error(`\u65E0\u6CD5\u89E3\u6790\u4E3B\u673A ${hostname}`);
  for (const ip of addrs) {
    if (isPrivateIp(ip)) throw new Error(`\u76EE\u6807\u5730\u5740 ${ip} \u5C5E\u4E8E\u5185\u7F51/\u4FDD\u7559\u5730\u5740\uFF0C\u51FA\u4E8E\u5B89\u5168\u7B56\u7565\u62D2\u7EDD\u8BBF\u95EE`);
  }
}
function extractHtml(raw) {
  const tm = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? tm[1].trim().slice(0, 200) : null;
  const text = raw.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text };
}
async function readUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`\u65E0\u6548 URL\uFF1A${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`\u4EC5\u652F\u6301 http/https\uFF08\u6536\u5230 ${url.protocol}\uFF09`);
  }
  await assertPublicHost(url.hostname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; url-mcp/0.1)",
        "accept": "text/html,text/plain,application/json,text/markdown,*/*"
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`\u8BF7\u6C42\u5931\u8D25\uFF08${TIMEOUT_MS / 1e3}s \u8D85\u65F6\u6216\u7F51\u7EDC\u4E0D\u53EF\u8FBE\uFF09\uFF1A${msg}`);
  } finally {
    clearTimeout(timer);
  }
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_CT.includes(contentType)) {
    return {
      url: url.href,
      status: res.status,
      content_type: contentType,
      title: null,
      text: `\uFF08\u5185\u5BB9\u7C7B\u578B ${contentType || "\u672A\u77E5"} \u4E0D\u5728\u53EF\u8BFB\u767D\u540D\u5355\u5185\uFF0C\u65E0\u6CD5\u63D0\u53D6\u6587\u672C\uFF09`,
      truncated: false
    };
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) {
    return {
      url: url.href,
      status: res.status,
      content_type: contentType,
      title: null,
      text: `\uFF08\u54CD\u5E94\u58F0\u660E ${declared} \u5B57\u8282\uFF0C\u8D85\u8FC7\u4E0A\u9650\uFF0C\u62D2\u7EDD\u8BFB\u53D6\uFF09`,
      truncated: true
    };
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    return {
      url: url.href,
      status: res.status,
      content_type: contentType,
      title: null,
      text: `\uFF08\u54CD\u5E94 ${buf.byteLength} \u5B57\u8282\uFF0C\u8D85\u8FC7\u4E0A\u9650\uFF0C\u62D2\u7EDD\u8BFB\u53D6\uFF09`,
      truncated: true
    };
  }
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const { title, text } = contentType === "text/html" ? extractHtml(raw) : { title: null, text: raw };
  const truncated = text.length > MAX_TEXT_CHARS;
  return {
    url: url.href,
    status: res.status,
    content_type: contentType,
    title,
    text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text,
    truncated
  };
}
var urlReader = {
  name: "url_reader",
  // 工具描述是 prompt 工程的一部分，改动需评估 agent 行为影响
  //（曾因未排除附件，agent 对 .html 网页保存件误调本工具）。
  description: "\u8BFB\u53D6\u4E00\u4E2A http/https \u7F51\u9875\u7684\u6587\u672C\u5185\u5BB9\uFF08HTML \u4F1A\u62BD\u6B63\u6587\u3001\u53BB\u811A\u672C\u6837\u5F0F\uFF09\u3002\u4EC5\u5F53\u7528\u6237\u6D88\u606F\u91CC\u660E\u786E\u7ED9\u51FA\u4E86 http/https \u94FE\u63A5\u5730\u5740\u65F6\u624D\u8C03\u7528\uFF1B\u7528\u6237\u4E0A\u4F20\u7684\u9644\u4EF6\uFF08\u542B .html \u7F51\u9875\u4FDD\u5B58\u4EF6\uFF09\u5185\u5BB9\u5DF2\u89E3\u6790\u6CE8\u5165\u6D88\u606F\uFF0C\u76F4\u63A5\u4F7F\u7528\uFF0C\u4E0D\u8981\u5BF9\u9644\u4EF6\u8C03\u7528\u672C\u5DE5\u5177\u3002\u5185\u7F51\u5730\u5740\u4F1A\u88AB\u5B89\u5168\u7B56\u7565\u62D2\u7EDD\u3002",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "\u8981\u8BFB\u53D6\u7684\u5B8C\u6574 URL\uFF08http/https\uFF09" } },
    required: ["url"]
  },
  async run(args) {
    return readUrl(String(args.url ?? ""));
  }
};

// server.ts
var PORT = Number(process.env.PORT ?? 8624);
var PROTOCOL_VERSION = "2025-06-18";
var TOOLS = [urlReader];
var rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
var rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
async function handleMessage(msg) {
  const { id, method, params } = msg ?? {};
  if (method === void 0 || method.startsWith("notifications/")) return { status: 202, body: null };
  switch (method) {
    case "initialize":
      return { status: 200, body: rpcResult(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "url-mcp", version: "0.1.0" }
      }) };
    case "ping":
      return { status: 200, body: rpcResult(id, {}) };
    case "tools/list":
      return { status: 200, body: rpcResult(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      }) };
    case "tools/call": {
      const name = String(params?.name ?? "");
      const args = params?.arguments ?? {};
      const tool = TOOLS.find((t) => t.name === name);
      const started = Date.now();
      try {
        if (!tool) throw new Error(`\u672A\u77E5\u5DE5\u5177\uFF1A${name}`);
        const data = await tool.run(args);
        console.log(`[url-mcp] ${name}(${JSON.stringify(args)}) ok ${Date.now() - started}ms`);
        return { status: 200, body: rpcResult(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false }) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`[url-mcp] ${name}(${JSON.stringify(args)}) error: ${message}`);
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
      res.end(JSON.stringify({ ok: true, service: "url-mcp", tools: TOOLS.map((t) => t.name) }));
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
  console.log(`[url-mcp] listening on :${PORT} (tools: ${TOOLS.map((t) => t.name).join(", ")})`);
});
