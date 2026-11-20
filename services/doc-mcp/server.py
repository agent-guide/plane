# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""doc-mcp — 文档解析 MCP 服务（设计 docs/v2/document-parsing-and-email-capability.md §二）。

parse_document(content_base64+filename | url) → {text, filename, mime_type, truncated}
定位：agent 主动解析的兜底能力——用户上传的文件走平台自动解析注入（四种场景），
本工具服务「agent 通过工具主动拿到、未被平台解析」的文件（邮件附件、未来
文件产物/知识库文档等）。解析实现来自 packages/document-parsing（单一权威源，
与 plane 编排域注入共用，防行为漂移）。

传输：streamable_http（POST JSON-RPC，与网关契约同 url-mcp/agents 同构）。
安全：url 输入走 SSRF 防护（IP 直连先查 + DNS 后拒私网）；base64 输入限 10MB；
解析超时 30s；文本截断 20k chars。不支持图片 OCR（vision 域，挂起）。
运行：python server.py（PORT 默认 8625；显式绑 0.0.0.0 防 nginx 反代 502）。
"""
from __future__ import annotations

import base64
import json

import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from document_parsing import parse_attachment_url
from ssrf import assert_public_host

PORT = int(__import__("os").environ.get("PORT", "8625"))
PROTOCOL_VERSION = "2025-06-18"
MAX_BYTES = 10 * 1024 * 1024
MAX_TEXT_CHARS = 20_000
PARSE_TIMEOUT_S = 30
DOWNLOAD_TIMEOUT_S = 15

MIME_BY_EXT = {
    "pdf": "application/pdf", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "html": "text/html", "htm": "text/html", "md": "text/markdown", "markdown": "text/markdown",
    "txt": "text/plain", "csv": "text/csv", "json": "application/json", "xml": "application/xml",
    "log": "text/plain", "yaml": "application/yaml", "yml": "application/yaml",
    # 旧版 Office 二进制格式：LibreOffice headless 优先、olefile 兜底（_parse.py）
    "doc": "application/msword", "ppt": "application/vnd.ms-powerpoint",
}
SUPPORTED_EXTS = set(MIME_BY_EXT) | {"xls"}


def _ext_of(filename_or_url: str) -> str:
    name = filename_or_url.rsplit("?", 1)[0].rsplit("/", 1)[-1]
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def _download(url: str) -> tuple[bytes, str, str]:
    """SSRF 防护 + 受限下载，返回 (字节, 文件名, content_type)。
    content_type 用于类型分发——URL 根路径无文件名时扩展名不可靠
    （https://example.com 曾被误判为扩展名 com，11-19 实证）。"""
    if not url.startswith(("http://", "https://")):
        raise ValueError(f"仅支持 http/https（收到 {url.split(':', 1)[0]}://）")
    assert_public_host(url.split("://", 1)[1].split("/", 1)[0].split(":", 1)[0].split("@")[-1])
    req = urllib.request.Request(url, headers={
        "user-agent": "Mozilla/5.0 (compatible; doc-mcp/0.1)",
        "accept": ", ".join(sorted(set(MIME_BY_EXT.values()))) + ", */*",
    })
    with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT_S) as resp:
        declared = int(resp.headers.get("content-length") or 0)
        if declared > MAX_BYTES:
            raise ValueError(f"响应声明 {declared} 字节，超过 {MAX_BYTES} 上限，拒绝读取")
        data = resp.read(MAX_BYTES + 1)
        content_type = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
    if len(data) > MAX_BYTES:
        raise ValueError(f"响应超过 {MAX_BYTES} 上限，拒绝读取")
    filename = url.rsplit("?", 1)[0].rsplit("/", 1)[-1] or "download"
    return data, filename, content_type


# 反查时跳过长扩展名别名（htm/markdown/yml），保留规范名——否则别名覆盖规范名
_MIME_ALIASES = {"htm", "markdown", "yml"}
MIME_TO_EXT = {mime: ext for ext, mime in
               sorted(((k, v) for k, v in MIME_BY_EXT.items() if k not in _MIME_ALIASES),
                      key=lambda kv: len(kv[0]), reverse=True)}


def _resolve_ext(filename: str, content_type: str = "") -> str:
    """类型分发：响应 Content-Type 优先，扩展名回退——URL 根路径
    （example.com）扩展名不可靠；base64 输入带明确 filename 时两者一致。"""
    ct = content_type.split(";")[0].strip().lower()
    if ct in MIME_TO_EXT:
        return MIME_TO_EXT[ct]
    return _ext_of(filename)


def _parse_with_timeout(filename: str, data: bytes) -> tuple[str, bool]:
    """带超时的解析（线程池 + result(timeout)——HTTP 服务工作线程里不能用
    signal.alarm（仅主线程），这是线程化服务的标准做法）。"""
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(parse_attachment_url, filename, data, max_chars=MAX_TEXT_CHARS)
        try:
            return future.result(timeout=PARSE_TIMEOUT_S)
        except concurrent.futures.TimeoutError:
            future.cancel()
            raise TimeoutError(f"解析超过 {PARSE_TIMEOUT_S}s") from None


def call_parse_document(args: dict) -> dict:
    content_b64 = args.get("content_base64")
    url = args.get("url")
    filename = args.get("filename")
    if bool(content_b64) == bool(url):
        raise ValueError("content_base64 与 url 必须二选一（且只提供一个）")
    if content_b64 is not None:
        if not filename or "." not in filename:
            raise ValueError("content_base64 输入必须携带含扩展名的 filename（用于类型分发）")
        data = base64.b64decode(content_b64, validate=False)
        if len(data) > MAX_BYTES:
            raise ValueError(f"文件超过 {MAX_BYTES} 上限，拒绝解析")
        content_type = ""
    else:
        data, filename, content_type = _download(str(url))
    ext = _resolve_ext(filename, content_type)
    if ext not in SUPPORTED_EXTS:
        raise ValueError(
            f"不支持的文档类型 {ext or '(无扩展名)'}；支持：{'/'.join(sorted(SUPPORTED_EXTS))}；"
            "图片 OCR 暂不支持")
    # 类型分发后的规范文件名（content-type 判型时以类型为准确保解析正确）
    if content_type and ext != _ext_of(filename):
        filename = f"{filename.rsplit('.', 1)[0] if '.' in filename else filename}.{ext}"
    text, truncated = _parse_with_timeout(filename, data)
    return {"text": text, "filename": filename,
            "mime_type": MIME_BY_EXT.get(ext, "application/octet-stream"),
            "truncated": truncated}


TOOLS = [{
    "name": "parse_document",
    # 工具描述是 prompt 工程的一部分：明确「何时调/何时不调」，防误用
    #（曾因 url_reader 描述未排除附件导致 agent 误调，11-19 教训）。
    "description": (
        "把文档内容解析成纯文本（支持 pdf/docx/xlsx/pptx/html/md/txt/csv/json/xml/log/doc/ppt）。"
        "仅当「通过工具主动拿到了文档内容、且它没有被解析成文本」时调用——例如邮件附件"
        "（base64 或下载链接）、其他工具返回的文件内容。用户上传的附件内容已随消息自动"
        "注入，不需要调用本工具。不支持图片 OCR。内网地址会被安全策略拒绝。"
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "content_base64": {"type": "string", "description": "文档字节的 base64（须同时给 filename）"},
            "filename": {"type": "string", "description": "文件名（含扩展名，base64 输入必填；url 输入可省略自动推断）"},
            "url": {"type": "string", "description": "文档的 http/https 下载地址（与 content_base64 二选一）"},
        },
        "required": [],
    },
}]


def handle_message(msg):
    id_, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if method is None or method.startswith("notifications/"):
        return 202, None
    if method == "initialize":
        return 200, {"jsonrpc": "2.0", "id": id_, "result": {
            "protocolVersion": params.get("protocolVersion") or PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "doc-mcp", "version": "0.1.0"}}}
    if method == "ping":
        return 200, {"jsonrpc": "2.0", "id": id_, "result": {}}
    if method == "tools/list":
        return 200, {"jsonrpc": "2.0", "id": id_, "result": {"tools": TOOLS}}
    if method == "tools/call":
        name = str(params.get("name") or "")
        args = params.get("arguments") or {}
        try:
            if name != "parse_document":
                raise ValueError(f"未知工具：{name}")
            data = call_parse_document(args)
            import time
            print(f"[doc-mcp] parse_document(filename={data['filename']}) ok", flush=True)
            return 200, {"jsonrpc": "2.0", "id": id_, "result": {
                "content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}],
                "isError": False}}
        except Exception as exc:  # noqa: BLE001 —— 工具错误回传给 agent（人话 message）
            message = str(exc)
            print(f"[doc-mcp] parse_document({args.get('filename') or args.get('url') or ''}) error: {message}",
                  flush=True)
            return 200, {"jsonrpc": "2.0", "id": id_, "result": {
                "content": [{"type": "text", "text": message}], "isError": True}}
    if method == "resources/list":
        return 200, {"jsonrpc": "2.0", "id": id_, "result": {"resources": []}}
    if method == "prompts/list":
        return 200, {"jsonrpc": "2.0", "id": id_, "result": {"prompts": []}}
    return 200, {"jsonrpc": "2.0", "id": id_, "error": {"code": -32601, "message": f"method not found: {method}"}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_OPTIONS(self):
        """MCP streamable_http 预检（网关连接器握手会发 OPTIONS——不实现则
        BaseHTTPRequestHandler 默认 501，网关侧 tools 拉取失败，11-19 实证；
        与 url-mcp 的 CORS 应答同构）。"""
        self.send_response(204)
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers",
                         "content-type,authorization,mcp-session-id,mcp-protocol-version")
        self.send_header("access-control-allow-methods", "POST,GET,OPTIONS")
        self.send_header("content-length", "0")
        self.end_headers()

    def _json(self, status: int, body) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path in ("/health", "/"):
            self._json(200, {"ok": True, "service": "doc-mcp",
                             "tools": [t["name"] for t in TOOLS]})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        # 网关 streamable_http 契约：POST 发往 connector URL 原样路径（注册的
        # URL 无 /mcp 后缀 → 请求打到 /）——与 url-mcp 同构：不判路径，一律按
        # JSON-RPC 处理（曾只认 /mcp 致网关拉工具 404，11-19 实证）
        try:
            length = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(length) or b"null")
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"jsonrpc": "2.0", "id": None,
                             "error": {"code": -32700, "message": "parse error"}})
            return
        messages = body if isinstance(body, list) else [body]
        replies = []
        status = 200
        for message in messages:
            try:
                status, resp = handle_message(message)
            except Exception as exc:  # noqa: BLE001 —— 兜底：handler 崩溃→500 空响应
                resp = {"jsonrpc": "2.0", "id": message.get("id"),
                        "error": {"code": -32603, "message": f"internal error: {exc}"}}
            if resp is not None:
                replies.append(resp)
        if not replies:
            self.send_response(status)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        self._json(200, replies if isinstance(body, list) else replies[0])

    def log_message(self, *args):  # 静默访问日志（工具级日志走 print）
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[doc-mcp] listening on :{PORT} (tools: {', '.join(t['name'] for t in TOOLS)})", flush=True)
    server.serve_forever()
