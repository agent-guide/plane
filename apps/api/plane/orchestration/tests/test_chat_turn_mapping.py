# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""stream_agent_turn 网关原始帧映射契约测试（协议 v2 §六）。

不 mock 生成器本身——以假 opener 喂真实网关 SSE 帧序列，验证：
- tool_call 两种形态（发起 {calls} / 结果 {name,output}）→ stage 事件
- delta 只取增量文本；done 收口（stop_reason 透传）
- error 事件嵌套信封 → AgentTurnError（code 取嵌套 error_type）
- 会话参数分叉（acp 用 thread_id / builtin 用 session_id）
"""

import json
from unittest.mock import patch

from django.test import TestCase

from plane.orchestration.chat import stream_agent_turn
from plane.orchestration.worker import AgentTurnError


def _sse(*frames):
    """frames: (event, data) → 网关原始 SSE 字节行列表。"""
    lines = []
    for event, data in frames:
        lines.append(f"event: {event}\n".encode())
        lines.append(f"data: {json.dumps(data)}\n\n".encode())
    return lines


class _FakeResponse:
    def __init__(self, chunks): self._chunks = list(chunks)
    def __iter__(self): return iter(self._chunks)
    def read(self): return b"".join(self._chunks)
    def __enter__(self): return self
    def __exit__(self, *a): return False


class _FakeOpener:
    """按调用序返回脚本化响应：JSON（部署/invocation）或 SSE（turn）。"""

    def __init__(self, responses): self.responses = list(responses)

    def open(self, req, timeout=None):
        item = self.responses.pop(0)
        if isinstance(item, list):  # SSE 帧行列表
            return _FakeResponse(item)
        return _FakeResponse([json.dumps(item).encode()])

    def __call__(self): return self


DEPLOYMENT = {"id": "deployment:t1:d1", "definitionId": "agent:t1:analyst",
              "lifecycleState": "active", "appliedReleaseNumber": 1}


def _setup(runtime_type="builtin"):
    """三段式脚本：GET deployments → GET releases（runtime 快照）→ POST invocation。"""
    return [
        {"items": [DEPLOYMENT]},
        {"items": [{"number": 1, "snapshot": {"runtime": {"type": runtime_type}}}]},
        {"id": "inv-1"},
    ]


class StreamAgentTurnMappingTests(TestCase):
    def setUp(self):
        # 清 runtime 类型进程级缓存：脚本化响应按调用序消费，缓存命中会错位
        from plane.orchestration import worker
        worker._RUNTIME_CACHE.clear()

    def _run(self, opener):
        events = []
        with patch("plane.orchestration.chat._local_opener", opener), \
             patch("plane.orchestration.chat._agwmngr_base", return_value="http://mgr"), \
             patch("plane.orchestration.chat._agwmngr_headers", return_value={}):
            for ev in stream_agent_turn(agent_definition_id="agent:t1:analyst",
                                        prompt="hi", session_hint="s1"):
                events.append(ev)
        return events

    def test_tool_call_and_delta_and_done_mapping(self):
        sse = _sse(
            ("session", {"session_id": "s1"}),
            ("tool_call", {"data": {"calls": [
                {"name": "parse_document", "arguments": "{}"}]}}),
            ("tool_call", {"data": {"name": "parse_document", "output": "{...}"}}),
            ("delta", {"text": "解析"}),
            ("delta", {"text": "完成"}),
            ("done", {"data": {"stop_reason": "end_turn"}}),
        )
        opener = _FakeOpener(_setup() + [sse])
        events = self._run(opener)
        self.assertEqual(events, [
            {"type": "stage", "phase": "tool", "label": "正在调用 parse_document…"},
            {"type": "stage", "phase": "tool", "label": "已完成 parse_document"},
            {"type": "delta", "text": "解析"},
            {"type": "delta", "text": "完成"},
            {"type": "done", "stopReason": "end_turn"},
        ])

    def test_error_envelope_nested_error_type(self):
        sse = _sse(("error", {"data": {"error_type": "rate_limit", "message": "限额"}}))
        opener = _FakeOpener(_setup() + [sse])
        with self.assertRaises(AgentTurnError) as ctx:
            list(self._run(opener))
        self.assertEqual(ctx.exception.code, "rate_limit")

    def test_multiple_tools_joined_in_label(self):
        sse = _sse(("tool_call", {"data": {"calls": [
            {"name": "url_reader"}, {"name": "parse_document"}]}}))
        opener = _FakeOpener(_setup() + [sse])
        events = self._run(opener)
        self.assertEqual(events[0]["label"], "正在调用 url_reader、parse_document…")

    def test_acp_sessionupdate_tool_call_mapping(self):
        """ACP（sessionUpdate 协议）tool_call 形态 → stage；title 剥网关服务前缀。"""
        long_cmd = "date '+%H:%M' && python3 -c \"\nfrom openpyxl import load_workbook\nprint(1)\""
        sse = _sse(
            ("tool_call", {"data": {"sessionUpdate": "tool_call", "toolCallId": "c1",
                                    "title": "agwmngr_service0_parse_document",
                                    "status": "pending"}}),
            ("tool_call", {"data": {"sessionUpdate": "tool_call_update", "toolCallId": "c1",
                                    "status": "in_progress",
                                    "title": "agwmngr_service0_parse_document"}}),
            ("tool_call", {"data": {"sessionUpdate": "tool_call_update", "toolCallId": "c1",
                                    "status": "completed", "content": "..."}}),
            # bash 工具：title=完整命令——截断成单行 24 字防脚本灌进气泡
            ("tool_call", {"data": {"sessionUpdate": "tool_call", "toolCallId": "c2",
                                    "title": long_cmd, "status": "pending"}}),
            ("delta", {"text": "结果"}),
            ("done", {"data": {}}),
        )
        opener = _FakeOpener([
            {"items": [dict(DEPLOYMENT, id="deployment:t1:d-su")]},
            {"items": [{"number": 1, "snapshot": {"runtime": {"type": "acp"}}}]},
            {"id": "inv-1"},
            sse,
        ])
        events = self._run(opener)
        self.assertEqual([e for e in events if e["type"] == "stage"], [
            {"type": "stage", "phase": "tool", "label": "正在调用 parse_document…"},
            {"type": "stage", "phase": "tool", "label": "正在调用 parse_document…"},
            # completed 帧无 title（真实 ACP 流实证），按 toolCallId 回查名字
            {"type": "stage", "phase": "tool", "label": "已完成 parse_document"},
            # bash 长命令：压成单行 + 截断
            {"type": "stage", "phase": "tool",
             "label": "正在调用 date '+%H:%M' && python3…"},
        ])

    def test_acp_runtime_uses_thread_id(self):
        """acp 型 runtime 的 turn 请求体带 thread_id 而非 session_id。

        独立 deployment id——_resolve_runtime_type 有进程级缓存，复用 id 会
        命中前一个用例的 builtin 结果。
        """
        seen = {}

        class _Capture(_FakeOpener):
            def open(self, req, timeout=None):
                if "turn" in req.full_url:
                    seen["acp_body"] = json.loads(req.data.decode())
                return super().open(req, timeout=timeout)

        acp_deployment = dict(DEPLOYMENT, id="deployment:t1:d-acp")
        cap = _Capture([
            {"items": [acp_deployment]},
            {"items": [{"number": 1, "snapshot": {"runtime": {"type": "acp"}}}]},
            {"id": "inv-1"},
            _sse(("done", {"data": {}})),
        ])
        self._run(cap)
        self.assertIn("thread_id", seen["acp_body"])
        self.assertNotIn("session_id", seen["acp_body"])
