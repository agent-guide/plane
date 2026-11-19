# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""doc-mcp 契约测试（协议 v2 设计 §九：契约双向锁定，防漂移）。

覆盖：parse_document 工具契约（各类型解析/超限/缺参/类型分发）、SSRF 防护、
MCP 协议形状（initialize/tools/list/tools/call isError）。纯单元级（不起服务）。
"""
import base64
import io
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


class TestParseDocumentContract:
    def test_txt_base64(self):
        r = server.call_parse_document({"content_base64": _b64("你好\nworld".encode()), "filename": "a.txt"})
        assert r["text"] == "你好\nworld"
        assert r["mime_type"] == "text/plain"
        assert r["truncated"] is False

    def test_xlsx_real_document(self):
        import openpyxl
        wb = openpyxl.Workbook(); ws = wb.active; ws.title = "数据"
        ws.append(["列A", "列B"]); ws.append([1, "x"])
        buf = io.BytesIO(); wb.save(buf)
        r = server.call_parse_document({"content_base64": _b64(buf.getvalue()), "filename": "d.xlsx"})
        assert "工作表：数据" in r["text"] and "列A | 列B" in r["text"]
        assert r["mime_type"].endswith("spreadsheetml.sheet")

    def test_docx_real_document(self):
        import docx
        d = docx.Document(); d.add_paragraph("草稿内容")
        buf = io.BytesIO(); d.save(buf)
        r = server.call_parse_document({"content_base64": _b64(buf.getvalue()), "filename": "d.docx"})
        assert "草稿内容" in r["text"]

    def test_html_extracts_body_not_source(self):
        html = "<html><head><link href='http://x/a.css'></head><body><p>正文内容</p></body></html>"
        r = server.call_parse_document({"content_base64": _b64(html.encode()), "filename": "a.html"})
        assert "正文内容" in r["text"] and "a.css" not in r["text"] and "<p>" not in r["text"]

    def test_content_type_overrides_unreliable_url_ext(self):
        """URL 根路径扩展名不可靠（example.com→com），content-type 优先判型。"""
        assert server._resolve_ext("example.com", "text/html") == "html"
        assert server._resolve_ext("download.pdf", "application/pdf") == "pdf"
        assert server._resolve_ext("file.docx", "") == "docx"  # 无 ct 回退扩展名

    def test_size_limit_rejects_oversize(self):
        with pytest.raises(ValueError, match="上限"):
            server.call_parse_document({"content_base64": _b64(b"x" * (server.MAX_BYTES + 1)), "filename": "a.txt"})

    def test_missing_filename_for_base64(self):
        with pytest.raises(ValueError, match="filename"):
            server.call_parse_document({"content_base64": _b64(b"hi")})

    def test_both_or_neither_input_rejected(self):
        with pytest.raises(ValueError, match="二选一"):
            server.call_parse_document({"content_base64": _b64(b"x"), "url": "https://e.com/a.txt",
                                        "filename": "a.txt"})
        with pytest.raises(ValueError, match="二选一"):
            server.call_parse_document({})

    def test_unsupported_type_message(self):
        with pytest.raises(ValueError, match="不支持"):
            server.call_parse_document({"content_base64": _b64(b"\x89PNG"), "filename": "x.png"})

    def test_truncation_flag(self):
        long_text = "字" * (server.MAX_TEXT_CHARS + 100)
        r = server.call_parse_document({"content_base64": _b64(long_text.encode()), "filename": "a.txt"})
        assert len(r["text"]) == server.MAX_TEXT_CHARS and r["truncated"] is True


class TestSSRF:
    def test_loopback_rejected(self):
        with pytest.raises(ValueError, match="内网"):
            server.assert_public_host("127.0.0.1")

    def test_private_rejected(self):
        with pytest.raises(ValueError, match="内网"):
            server.assert_public_host("192.168.1.1")

    def test_unresolvable_rejected(self):
        with pytest.raises(ValueError, match="无法解析"):
            server.assert_public_host("nonexistent.invalid.example")

    def test_url_input_loopback_rejected(self):
        with pytest.raises(ValueError, match="内网"):
            server.call_parse_document({"url": "http://10.0.0.5/doc.pdf"})


class TestMcpProtocol:
    def test_initialize_shape(self):
        status, resp = server.handle_message({"id": 1, "method": "initialize",
                                              "params": {"protocolVersion": "2025-06-18"}})
        assert status == 200
        result = resp["result"]
        assert result["serverInfo"]["name"] == "doc-mcp"
        assert result["capabilities"]["tools"]["listChanged"] is False

    def test_tools_list_contract(self):
        _, resp = server.handle_message({"id": 2, "method": "tools/list", "params": {}})
        tool = resp["result"]["tools"][0]
        assert tool["name"] == "parse_document"
        # 描述必须含「何时调/不调已注入附件」的 prompt 工程约束
        assert "主动" in tool["description"] and "已随消息自动注入" in tool["description"]
        assert tool["inputSchema"]["type"] == "object"

    def test_tools_call_error_is_isError_not_protocol_error(self):
        _, resp = server.handle_message({"id": 3, "method": "tools/call", "params": {
            "name": "parse_document", "arguments": {"content_base64": _b64(b"x"), "filename": "x.png"}}})
        assert resp["result"]["isError"] is True  # 工具错误走 isError（回传 agent），非 JSON-RPC error

    def test_unknown_tool(self):
        _, resp = server.handle_message({"id": 4, "method": "tools/call", "params": {
            "name": "nope", "arguments": {}}})
        assert resp["result"]["isError"] is True

    def test_notification_no_reply(self):
        status, resp = server.handle_message({"method": "notifications/initialized"})
        assert status == 202 and resp is None
