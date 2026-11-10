# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""invoke_agent_node 会话字段自适应（builtin vs ACP）单元测试。

2026-11-10 ACP 员工接入实证的两种 turn 契约：
- builtin：session_id 可带，thread_id 禁带（agwmngr 400 "thread_id is supported
  only by ACP invocation"）
- ACP：thread_id 必带（400 "thread_id is required for ACP invocation"），且
  客户端不能自造 session_id（404 session not found）

worker 策略：先按 builtin 历史形状发；收到 ACP 必带错误后换 thread_id 形状重试。
"""

import io
import json
from unittest import mock

import pytest

from plane.orchestration import worker


def _sse_response(events: list[tuple[str, dict]]) -> io.BytesIO:
    """Build an SSE byte stream from (event_type, payload) pairs."""
    lines = []
    for event_type, payload in events:
        lines.append(f"event: {event_type}")
        lines.append(f"data: {json.dumps(payload)}")
    lines.append("data: [DONE]")
    return io.BytesIO("\n".join(lines).encode())


class _FakeResponse:
    def __init__(self, stream: io.BytesIO):
        self._stream = stream

    def __iter__(self):
        return iter(self._stream.readlines())

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _FakeHTTPError(worker.urllib.error.HTTPError):
    """Stands in for urllib.error.HTTPError with a readable body."""

    def __init__(self, body: str):
        super().__init__("http://turn", 400, "Bad Request", None, io.BytesIO(body.encode()))


def _setup_deployments(urlopen_mock):
    """Fresh JSON body per call: ① deployments listing ② invocation context."""
    deployments = json.dumps({"items": [{
        "id": "deployment:demo:1",
        "definitionId": "agent:demo:reviewer",
        "lifecycleState": "active",
    }]}).encode()
    context = json.dumps({"id": "invocation-demo-1"}).encode()

    def serve(request, timeout=None):
        path = request.full_url
        return io.BytesIO(context if "/invocations" in path else deployments)

    urlopen_mock.side_effect = serve


@pytest.mark.django_db
def test_builtin_shape_sent_first_and_succeeds():
    """builtin 员工：历史形状（session_id）一次成功，不重试。"""
    with mock.patch.object(worker.urllib.request, "urlopen") as urlopen_mock:
        _setup_deployments(urlopen_mock)
        with mock.patch.object(
            worker, "_local_opener"
        ) as opener_mock:
            opener_mock.open.return_value = _FakeResponse(
                _sse_response([("delta", {"text": "结论：通过"})])
            )
            reply = worker.invoke_agent_node(
                agent_definition_id="agent:demo:reviewer",
                prompt="审单",
                session_hint="exec-1:node-a",
            )

    assert reply == "结论：通过"
    # 第二次 HTTP 调用（① 部署列表、② 上下文）之后，turn 只发起一次
    payload = json.loads(opener_mock.open.call_args[0][0].data)
    assert payload == {"input": "审单", "session_id": "exec-1:node-a"}
    assert opener_mock.open.call_count == 1


@pytest.mark.django_db
def test_acp_retries_with_thread_id():
    """ACP 员工：首弹 400「thread_id is required」后换 thread_id 形状重试成功。"""
    with mock.patch.object(worker.urllib.request, "urlopen") as urlopen_mock:
        _setup_deployments(urlopen_mock)
        with mock.patch.object(
            worker, "_local_opener"
        ) as opener_mock:
            opener_mock.open.side_effect = [
                _FakeHTTPError('{"error":"thread_id is required for ACP invocation","code":"invalid_input"}'),
                _FakeResponse(_sse_response([("delta", {"text": "已暂存 DEC2026"}), ("delta", {"text": "123"})])),
            ]
            reply = worker.invoke_agent_node(
                agent_definition_id="agent:demo:reviewer",
                prompt="录入",
                session_hint="exec-2:node-b",
            )

    assert reply == "已暂存 DEC2026123"
    first = json.loads(opener_mock.open.call_args_list[0][0][0].data)
    second = json.loads(opener_mock.open.call_args_list[1][0][0].data)
    assert first == {"input": "录入", "session_id": "exec-2:node-b"}
    # ACP 形状：thread_id 必带、session_id 不带（ACP session 由网关分配）
    assert second == {"input": "录入", "thread_id": "exec-2:node-b"}


@pytest.mark.django_db
def test_other_400s_propagate_without_retry():
    """无关的 400 不触发自适应重试，原样抛出。"""
    with mock.patch.object(worker.urllib.request, "urlopen") as urlopen_mock:
        _setup_deployments(urlopen_mock)
        with mock.patch.object(
            worker, "_local_opener"
        ) as opener_mock:
            opener_mock.open.side_effect = _FakeHTTPError('{"error":"other problem"}')
            with pytest.raises(_FakeHTTPError):
                worker.invoke_agent_node(
                    agent_definition_id="agent:demo:reviewer",
                    prompt="x",
                    session_hint="exec-3:node-c",
                )

    assert opener_mock.open.call_count == 1
