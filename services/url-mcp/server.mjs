/**
 * url-mcp（Node 版）——读取网页内容 MCP 工具。逻辑与 server.ts 同构：
 * SSRF 防护（DNS 后拒绝私网）/ 大小+超时限制 / Content-Type 白名单。
 */
import http from "node:http";
import dns from "node:dns/promises";
import { URL } from "node:url";

const PORT = Number(process.env.PORT ?? 8624);
const PROTOCOL_VERSION = "2025-06-18";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 20_000;
const TIMEOUT_MS = 8_000;
const ALLOWED_CT = ["text/html", "text/plain", "application/json", "text/markdown", "application/xml", "text/xml", "text/csv"];

const PRIVATE_V4 = [
  /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];
function isPrivateIp(ip) {
  if (PRIVATE_V4.some((re) => re.test(ip))) return true;
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("::ffff:")) return isPrivateIp(lower.slice(7));
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
async function assertPublicHost(hostname) {
  let addrs = [];
  if (IPV4_RE.test(hostname)) {
    addrs = [hostname]; // IP 直连：跳过 DNS，直接检查
  } else {
    try { addrs = await dns.resolve4(hostname); } catch {}
    try { addrs = [...addrs, ...(await dns.resolve6(hostname))]; } catch {}
  }
  if (!addrs.length) throw new Error(`无法解析主机 ${hostname}`);
  for (const ip of addrs) {
    if (isPrivateIp(ip)) throw new Error(`目标地址 ${ip} 属于内网/保留地址，出于安全策略拒绝访问`);
  }
}

function extractHtml(raw) {
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

async function readUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error(`无效 URL：${rawUrl}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`仅支持 http/https（收到 ${url.protocol}）`);
  await assertPublicHost(url.hostname);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal, redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; url-mcp/0.1)", accept: "text/html,text/plain,application/json,*/*" },
    });
  } catch (err) {
    throw new Error(`请求失败（${TIMEOUT_MS / 1000}s 超时或网络不可达）：${err.message ?? err}`);
  } finally { clearTimeout(timer); }

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
  let raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  let title = null, text = raw;
  if (contentType === "text/html") { const r = extractHtml(raw); title = r.title; text = r.text; }
  const truncated = text.length > MAX_TEXT_CHARS;
  return { url: url.href, status: res.status, content_type: contentType, title,
    text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, truncated };
}

const TOOLS = [{
  name: "url_reader",
  description: "读取一个 http/https 网页的文本内容（HTML 会抽正文、去脚本样式）。仅当用户消息里明确给出了 http/https 链接地址时才调用；用户上传的附件（含 .html 网页保存件）内容已解析注入消息，直接使用，不要对附件调用本工具。内网地址会被安全策略拒绝。",
  inputSchema: { type: "object", properties: { url: { type: "string", description: "要读取的完整 URL（http/https）" } }, required: ["url"] },
}];

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleMessage(msg) {
  const { id, method, params } = msg ?? {};
  if (method === undefined || String(method).startsWith("notifications/")) return { status: 202, body: null };
  switch (method) {
    case "initialize":
      return { status: 200, body: rpcResult(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: "url-mcp", version: "0.1.0" } }) };
    case "ping": return { status: 200, body: rpcResult(id, {}) };
    case "tools/list": return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    case "tools/call": {
      const name = String(params?.name ?? "");
      const args = params?.arguments ?? {};
      try {
        const data = name === "url_reader" ? await readUrl(String(args.url ?? "")) : (() => { throw new Error(`未知工具：${name}`); })();
        console.log(`[url-mcp] ${name}(${String(args.url ?? "")}) ok`);
        return { status: 200, body: rpcResult(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false }) };
      } catch (err) {
        const message = err.message ?? String(err);
        console.log(`[url-mcp] ${name}(${String(args.url ?? "")}) error: ${message}`);
        return { status: 200, body: rpcResult(id, { content: [{ type: "text", text: message }], isError: true }) };
      }
    }
    case "resources/list": return { status: 200, body: rpcResult(id, { resources: [] }) };
    case "prompts/list": return { status: 200, body: rpcResult(id, { prompts: [] }) };
    default: return { status: 200, body: rpcError(id, -32601, `method not found: ${method}`) };
  }
}

const json = (data, status = 200) => JSON.stringify(data);

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(json({ ok: true, service: "url-mcp", tools: TOOLS.map((t) => t.name) }));
  }
  if (req.method !== "POST") { res.writeHead(405); return res.end(); }
  let body = "";
  for await (const chunk of req) body += chunk;
  let payload;
  try { payload = JSON.parse(body); } catch { res.writeHead(400, { "content-type": "application/json" }); return res.end(json(rpcError(null, -32700, "parse error"))); }
  const messages = Array.isArray(payload) ? payload : [payload];
  const replies = [];
  let status = 200;
  for (const m of messages) {
    const out = await handleMessage(m);
    status = out.status;
    if (out.body) replies.push(out.body);
  }
  if (!replies.length) { res.writeHead(202); return res.end(); }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json(Array.isArray(payload) ? replies : replies[0]));
});
server.listen(PORT, "0.0.0.0", () => console.log(`[url-mcp] listening on :${PORT}`));
