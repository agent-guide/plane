# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""错误可见性回归（11-25 用户盲盒实证，出口报关单-邮箱）：

- 重试耗尽时传感器上报的 "retries exhausted" 不再整份覆盖节点结果——
  保留 worker 先前写入的 error_normalized（真因），终局文案人话化
- 上游断流/超时（context deadline exceeded / Client.Timeout / stream chunk）
  归一化为 timeout 码 + 固定人话 detail——用户可自行判断稍后重试
"""

from django.test import Client, TestCase

from plane.orchestration.tests.test_worker_endpoints import StartExecutionTestBase
from plane.orchestration.models import NodeRuntimeRecord
from plane.orchestration.execution import start_execution
from plane.orchestration.worker import AgentTurnError, _normalize_agent_error

NODE_KEY = "agent_1_0"


class UpstreamTimeoutNormalizationTests(TestCase):
    """上游断流/超时 → timeout 码 + 人话 detail。"""

    def _turn_exc(self, message: str) -> AgentTurnError:
        payload = {"error_type": "turn_failed", "message": message}
        return AgentTurnError("turn_failed", f"agent turn error: {payload}", detail=payload)

    def test_stream_chunk_timeout_maps_to_timeout_with_human_detail(self):
        exc = self._turn_exc(
            "receive stream chunk: failed to receive stream chunk: "
            "context deadline exceeded (Client.Timeout or context cancellation while reading body)")
        normalized = _normalize_agent_error(exc)
        self.assertEqual(normalized["code"], "timeout")
        self.assertIn("模型服务响应中断", normalized["detail"])

    def test_awaiting_headers_timeout_maps_to_timeout(self):
        exc = self._turn_exc(
            'Post "https://api.example.com/v1/chat/completions": '
            "context deadline exceeded (Client.Timeout exceeded while awaiting headers)")
        self.assertEqual(_normalize_agent_error(exc)["code"], "timeout")

    def test_plain_turn_error_stays_agent_error(self):
        exc = self._turn_exc("something unrelated went wrong")
        normalized = _normalize_agent_error(exc)
        self.assertEqual(normalized["code"], "agent_error")


class RetryExhaustedMergeTests(StartExecutionTestBase):
    """/fail 登记合并不覆盖：保留 error_normalized + retries exhausted 人话化。"""

    def setUp(self):
        self.internal = Client()

    def _start_with_run_ref(self, execution) -> str:
        import os
        os.environ["ORCHESTRATION_INTERNAL_TOKEN"] = "test-internal-token"
        r = self.internal.post(
            "/api/internal/agent-teams/events/",
            {"externalEventId": f"errvis-{execution.id}", "eventType": "engine.started",
             "payload": {"executionId": execution.id, "engine_run_ref": "af-run-errvis"}},
            content_type="application/json", HTTP_X_ORCHESTRATION_TOKEN="test-internal-token")
        self.assertEqual(r.status_code, 200, r.content)
        return "af-run-errvis"

    def test_fail_preserves_error_normalized_and_humanizes_exhausted(self):
        ex = start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
        record = NodeRuntimeRecord.objects.create(
            execution=ex, node_key=NODE_KEY, status=NodeRuntimeRecord.Status.RETRYING,
            attempt=2, failure_retries=1,
            result={"error": "agent turn error: ...upstream...",
                    "error_normalized": {"code": "timeout",
                                          "detail": "模型服务响应中断（上游不稳定），稍后重试通常可恢复"}})
        run_ref = self._start_with_run_ref(ex)
        # 传感器上报：/start 拒绝（retries exhausted）→ raise → 回调 POST fail
        r = self.internal.post(
            f"/api/internal/workflow-runs/{run_ref}/nodes/{NODE_KEY}/fail/",
            {"eventId": f"sensor-fail:{run_ref}:{NODE_KEY}",
             "result": {"error": f"节点 {NODE_KEY} 运行失败：retries exhausted", "timeout": False}},
            content_type="application/json", HTTP_X_ORCHESTRATION_TOKEN="test-internal-token")
        self.assertEqual(r.status_code, 200, r.content)
        record.refresh_from_db()
        self.assertEqual(record.status, NodeRuntimeRecord.Status.FAILED)
        # error_normalized 保留（不被 "retries exhausted" 文案顶掉）
        self.assertEqual(record.result["error_normalized"]["code"], "timeout")
        # 终局错误人话化：带原始原因，不再只有 "retries exhausted"
        self.assertIn("已自动重试仍失败", record.result["error"])
        self.assertIn("模型服务响应中断", record.result["error"])
