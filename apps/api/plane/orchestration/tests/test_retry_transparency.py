# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""重试对用户透明（11-24 状态机定案）回归：

- 尝试失败但额度未尽 → 写侧落 RETRYING（不是 FAILED）
- 引擎面 view() 把 RETRYING 映射回 failed（已部署 DAG 传感器零感知）
- /start 重试梯把 RETRYING 与 FAILED 同等对待；耗尽判定不变
- 用户面时间线：RETRYING 显示为 running 且错误不透出；FAILED 照常显示
- 执行终态收口把 RETRYING 随 RUNNING 一并翻 CANCELLED（不留「执行中」残影）

背景（ENTRYCUS-3 实证）：失败→自动重试被用户感知为「先失败又复活」；
旧修复在读取层重算重试预算属打补丁，本批为状态机正解。
"""

import os
from unittest import mock

from django.test import Client, TestCase

from .canvas import CANVAS_SINGLE
from plane.orchestration.tests.test_worker_endpoints import StartExecutionTestBase
from plane.orchestration.models import NodeRuntimeRecord
from plane.orchestration.execution import start_execution
from plane.orchestration.worker import AgentTurnError, handle_agent_invoke

NODE_KEY = "agent_1_0"  # CANVAS_SINGLE 编译后的节点 key（同 DagNodeFail 测试）


class RetryWriteSideTests(StartExecutionTestBase):
    """写侧一次决策：额度未尽 RETRYING / 耗尽 FAILED。"""

    def _execution_with_record(self, *, failure_retries: int) -> NodeRuntimeRecord:
        ex = start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
        return NodeRuntimeRecord.objects.create(
            execution=ex, node_key=NODE_KEY, status=NodeRuntimeRecord.Status.RUNNING,
            attempt=1, failure_retries=failure_retries,
            result={"output": "partial"},
        )

    def _fail(self, record):
        with mock.patch("plane.orchestration.worker._agent_invoke_inner",
                        side_effect=AgentTurnError("agent_error", "boom")):
            with self.assertRaises(AgentTurnError):
                handle_agent_invoke(execution_id=record.execution_id,
                                    node_key=NODE_KEY, attempt=record.attempt)

    def test_failure_with_budget_left_writes_retrying(self):
        record = self._execution_with_record(failure_retries=0)  # 预算缺省 1，未尽
        self._fail(record)
        record.refresh_from_db()
        self.assertEqual(record.status, NodeRuntimeRecord.Status.RETRYING)
        self.assertIn("boom", record.result["error"])  # 过程错误留审计

    def test_failure_budget_exhausted_writes_failed(self):
        record = self._execution_with_record(failure_retries=1)  # 缺省预算 1 已用尽
        self._fail(record)
        record.refresh_from_db()
        self.assertEqual(record.status, NodeRuntimeRecord.Status.FAILED)

    def test_engine_view_maps_retrying_to_failed(self):
        record = self._execution_with_record(failure_retries=0)
        record.status = NodeRuntimeRecord.Status.RETRYING
        record.save(update_fields=["status"])
        # 引擎协议兼容：传感器只认 failed——映射后重试行为与旧版一致
        self.assertEqual(record.view()["status"], "failed")
        self.assertEqual(record.view()["nodeKey"], NODE_KEY)


class RetryLadderTests(StartExecutionTestBase):
    """/start 重试梯：RETRYING 与 FAILED 同权；耗尽判定不变。"""

    def setUp(self):
        self.internal = Client()

    def _start_with_run_ref(self, record):
        os.environ["ORCHESTRATION_INTERNAL_TOKEN"] = "test-internal-token"
        r = self.internal.post(
            "/api/internal/agent-teams/events/",
            {"externalEventId": f"retry-setup-{record.id}", "eventType": "engine.started",
             "payload": {"executionId": record.execution_id, "engine_run_ref": "af-run-retry"}},
            content_type="application/json", HTTP_X_ORCHESTRATION_TOKEN="test-internal-token")
        self.assertEqual(r.status_code, 200, r.content)
        return "af-run-retry"

    def test_start_redispatches_retrying_node(self):
        record = NodeRuntimeRecord.objects.create(
            execution=start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id),
            node_key=NODE_KEY, status=NodeRuntimeRecord.Status.RETRYING,
            attempt=1, failure_retries=0, result={"error": "boom"})
        run_ref = self._start_with_run_ref(record)
        r = self.internal.post(
            f"/api/internal/workflow-runs/{run_ref}/nodes/{NODE_KEY}/start/",
            {"eventId": f"{run_ref}:{NODE_KEY}:2:start", "eventType": "node.started",
             "attempt": 2, "payload": {"nodeKey": NODE_KEY}},
            content_type="application/json", HTTP_X_ORCHESTRATION_TOKEN="test-internal-token")
        self.assertEqual(r.status_code, 200, r.content)
        record.refresh_from_db()
        self.assertEqual(record.status, NodeRuntimeRecord.Status.RUNNING)
        self.assertEqual(record.attempt, 2)
        self.assertEqual(record.failure_retries, 1)  # 重派占用失败预算

    def test_start_rejects_when_budget_exhausted(self):
        record = NodeRuntimeRecord.objects.create(
            execution=start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id),
            node_key=NODE_KEY, status=NodeRuntimeRecord.Status.FAILED,
            attempt=2, failure_retries=1, result={"error": "boom"})
        run_ref = self._start_with_run_ref(record)
        r = self.internal.post(
            f"/api/internal/workflow-runs/{run_ref}/nodes/{NODE_KEY}/start/",
            {"eventId": f"{run_ref}:{NODE_KEY}:3:start", "eventType": "node.started",
             "attempt": 3, "payload": {"nodeKey": NODE_KEY}},
            content_type="application/json", HTTP_X_ORCHESTRATION_TOKEN="test-internal-token")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["error"], "retries exhausted")
        record.refresh_from_db()
        self.assertEqual(record.status, NodeRuntimeRecord.Status.FAILED)


class RetryPresentationTests(StartExecutionTestBase):
    """用户面：RETRYING 显示执行中且错误不透出；FAILED 照常；终态收口无残影。"""

    def setUp(self):
        self.client = Client()
        self.client.force_login(self.owner)

    def _execution(self):
        return start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)

    def _runtime_get(self, execution):
        return self.client.get(
            f"/api/workspaces/{self.ws.slug}/projects/{self.project.id}/"
            f"work-items/{execution.issue_id}/runtime/")

    def test_timeline_shows_retrying_as_running_without_error(self):
        ex = self._execution()
        NodeRuntimeRecord.objects.create(
            execution=ex, node_key=NODE_KEY, status=NodeRuntimeRecord.Status.RETRYING,
            attempt=1, failure_retries=0,
            result={"error": "boom", "error_normalized": {"code": "agent_error", "detail": "boom"}})
        r = self._runtime_get(ex)
        self.assertEqual(r.status_code, 200, r.content)
        node_events = [e for e in r.json()["timeline"] if e["kind"] == "node"]
        self.assertEqual(len(node_events), 1)
        self.assertEqual(node_events[0]["status"], "running")   # 统一显示执行中
        self.assertIsNone(node_events[0]["errorCode"])           # 错误不透出
        self.assertIsNone(node_events[0]["output"])

    def test_timeline_shows_terminal_failed_with_error(self):
        ex = self._execution()
        NodeRuntimeRecord.objects.create(
            execution=ex, node_key=NODE_KEY, status=NodeRuntimeRecord.Status.FAILED,
            attempt=2, failure_retries=1,
            result={"error": "final boom", "error_normalized": {"code": "agent_error", "detail": "boom"}})
        r = self._runtime_get(ex)
        node_events = [e for e in r.json()["timeline"] if e["kind"] == "node"]
        self.assertEqual(node_events[0]["status"], "failed")    # 终态失败照常显示
        self.assertEqual(node_events[0]["errorCode"], "agent_error")

    def test_cancel_settles_retrying_record(self):
        ex = self._execution()
        NodeRuntimeRecord.objects.create(
            execution=ex, node_key=NODE_KEY, status=NodeRuntimeRecord.Status.RETRYING,
            attempt=1, failure_retries=0, result={"error": "boom"})
        r = self.client.post(
            f"/api/workspaces/{self.ws.slug}/projects/{self.project.id}/"
            f"work-items/{ex.issue_id}/runtime/", content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        ex.refresh_from_db()
        self.assertEqual(ex.business_status, "cancelled")
        record = NodeRuntimeRecord.objects.get(execution=ex, node_key=NODE_KEY)
        self.assertEqual(record.status, NodeRuntimeRecord.Status.CANCELLED)  # 无「执行中」残影
