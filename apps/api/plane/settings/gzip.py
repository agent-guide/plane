# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""GZip 中间件的 SSE 豁免（2026-11-19 定案根因修复）。

Django GZipMiddleware 对 StreamingHttpResponse 会缓冲整个流（gzip 无法逐块
flush 给浏览器）→ SSE 帧全部攒到流结束一次性发出——会话流式/进度透传
（v2 协议 stage/delta）从上线起"看不到过程、干完一次性给结果"的真因。
业界标准做法：text/event-stream 响应跳过压缩（流式端点本就不该压）。
"""
from django.middleware.gzip import GZipMiddleware


class SSEBypassGZipMiddleware(GZipMiddleware):
    def process_response(self, request, response):
        content_type = response.get("Content-Type", "") if hasattr(response, "get") else ""
        if "text/event-stream" in (content_type or ""):
            return response
        return super().process_response(request, response)
