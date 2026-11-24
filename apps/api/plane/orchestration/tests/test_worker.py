# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""worker 测试：Airflow 客户端（重试/4xx 语义）+ 命令 handler（幂等/失败语义）。

2026-11-16：自研 outbox 消费退役，测试从 process_outbox_once 批量轮询改为
直调 handler 纯函数（行为断言不变）；投递契约见 test_tasks.py。
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from django.contrib.auth import get_user_model
from django.test import TestCase

from plane.db.models.workspace import Workspace
from plane.db.models.project import Project
from plane.db.models.issue import Issue
from .canvas import CANVAS_SINGLE
from plane.orchestration import services, workflows
from plane.orchestration.models import (
    WorkflowDefinition,
)
from plane.orchestration.execution import start_execution, on_engine_started
from plane.orchestration.worker import (
    AgentTurnError, AirflowClient, AirflowError,
    handle_agent_invoke, handle_engine_start,
    _normalize_agent_error,
)

User = get_user_model()


class FakeAirflow(BaseHTTPRequestHandler):
    """内存假 Airflow：记录请求；trigger_run 二次 5xx 后成功（验证重试）。"""

    calls: list = []
    fail_once = True

    def _respond(self, code: int, body: dict):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_GET(self):
        FakeAirflow.calls.append(("GET", self.path))
        self._respond(200, {"tags": [{"name": "h64"}]})

    def do_PATCH(self):
        self._respond(200, {"is_paused": False})

    def do_POST(self):
        FakeAirflow.calls.append(("POST", self.path))
        if "dagRuns" in self.path and FakeAirflow.fail_once:
            FakeAirflow.fail_once = False
            self._respond(503, {"error": "temporarily unavailable"})
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeAirflow.calls.append(("POST-BODY", body))
        self._respond(200, {"dag_run_id": body["dag_run_id"]})

    def log_message(self, *args):
        pass


class AirflowClientTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeAirflow)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.af_client = AirflowClient(f"http://127.0.0.1:{cls.server.server_port}", "tok")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_health(self):
        result = self.af_client.health()  # 200 不抛即通过（fake 对 GET 返回 tags 结构）
        self.assertIsInstance(result, dict)

    def test_trigger_run_retries_5xx_then_succeeds(self):
        FakeAirflow.fail_once = True
        result = self.af_client.trigger_run("wf_x_v1", dag_run_id="r-1", conf={"backendRunId": "b1"})
        self.assertEqual(result["dag_run_id"], "r-1")
        bodies = [c for c in FakeAirflow.calls if c[0] == "POST-BODY"]
        self.assertEqual(bodies[-1][1]["conf"]["backendRunId"], "b1")

    def test_409_trigger_replay_is_idempotent_success(self):
        """同 dag_run_id 重放 409 → 幂等成功（10-29 真机实证语义）。"""

        class Always409(FakeAirflow):
            def do_POST(self):
                self._respond(409, {"detail": "unique constraint"})

        self.server.RequestHandlerClass = Always409
        try:
            result = self.af_client.trigger_run("wf_x_v1", dag_run_id="r-replay", conf={})
        finally:
            self.server.RequestHandlerClass = FakeAirflow
        self.assertEqual(result.get("note"), "idempotent replay")

    def test_4xx_not_retried(self):
        class Always400(FakeAirflow):
            def do_POST(self):
                self._respond(400, {"error": "bad request"})
        port = self.server.server_port
        self.server.RequestHandlerClass = Always400
        try:
            with self.assertRaises(AirflowError) as ctx:
                self.af_client.trigger_run("wf_x_v1", dag_run_id="r-2", conf={})
            self.assertEqual(ctx.exception.status, 400)
        finally:
            self.server.RequestHandlerClass = FakeAirflow


class OutboxConsumerTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user(email="wkc-o@test.io", username="wkc-o")
        cls.ws = Workspace.objects.create(name="owws", slug="owws-orch", owner=cls.owner)
        cls.project = Project.objects.create(name="owp", identifier="OWPORCH", workspace=cls.ws, created_by=cls.owner)
        cls.team = services.create_team(workspace_id=cls.ws.id, user_id=cls.owner.id, is_admin=True, name="outbox 团队")
        services.add_member(team=cls.team, user_id=cls.owner.id, is_admin=True, kind="human", role="dev", user_ref=cls.owner.id)
        # 名册校验（成员收敛 §3.1）：夹具 AI 节点引用 agent:t1:analyst，需在册
        services.add_member(team=cls.team, user_id=cls.owner.id, is_admin=True, kind="agent", role="analyst", agent_definition_id="agent:t1:analyst")
        services.activate_team(team=cls.team, user_id=cls.owner.id, is_admin=True)
        cls.wf = WorkflowDefinition.objects.create(project=cls.project, name="outbox 流程", created_by=cls.owner)
        workflows.update_draft(workflow=cls.wf, user_id=cls.owner.id, draft=CANVAS_SINGLE)
        v = workflows.save_draft_version(workflow=cls.wf, user_id=cls.owner.id)
        pub = workflows.start_publish(workflow=cls.wf, user_id=cls.owner.id)
        cls.version = workflows.finish_publish(version=pub, engine_deploy_ref={})
        cls.issue = Issue.objects.create(project=cls.project, name="outbox 工作项", created_by=cls.owner)
        cls.binding = services.bind_project(
            project=cls.project, team=cls.team, user_id=cls.owner.id, is_admin=True, workflow_version=cls.version)

    def test_failed_engine_start_raises_no_library_retry(self):
        """Airflow 未配置 → handler 抛错（job 落 failed），库不重试——
        恢复路径是对账/重发，不无限循环（等价旧「标记 failed 不循环」）。"""
        ex = start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
        on_engine_started(execution_id=ex.id, event_id="seed", engine_run_ref="af-run-ox")
        import os
        os.environ.pop("ORCHESTRATION_AIRFLOW_BASE_URL", None)
        with self.assertRaises(RuntimeError):
            handle_engine_start(execution_id=ex.id, workflow_version_id=str(self.version.id))


class NormalizeAgentErrorTests(TestCase):
    def test_rate_limit_from_http_error(self):
        # 11-19 口径：rate_limit 的 detail 只保留能提取到的上游人话 message；
        # 提取不到（非嵌套 JSON 的裸英文串）留空，前端回退 code 映射的通用限额文案
        err = _normalize_agent_error(AgentTurnError("rate_limit", "agent turn rejected: HTTP 429", detail={"error_type": "rate_limited", "message": "quota exhausted"}))
        self.assertEqual(err['code'], 'rate_limit')
        self.assertEqual(err['detail'], '')

    def test_timeout(self):
        err = _normalize_agent_error(AgentTurnError("timeout", "agent turn idle timeout: no SSE event for 240s"))
        self.assertEqual(err['code'], 'timeout')
        self.assertEqual(err['detail'], 'agent turn idle timeout: no SSE event for 240s')

    def test_empty_reply(self):
        err = _normalize_agent_error(AgentTurnError("empty_reply", "agent turn error: empty reply", detail={"error_type": "empty_reply", "message": "empty reply"}))
        self.assertEqual(err['code'], 'empty_reply')
        self.assertEqual(err['detail'], 'empty reply')

    def test_not_deployed(self):
        err = _normalize_agent_error(AgentTurnError("not_deployed", "no deployment for agent abc"))
        self.assertEqual(err['code'], 'not_deployed')
        self.assertEqual(err['detail'], 'no deployment for agent abc')

    def test_unknown_fallback(self):
        err = _normalize_agent_error(RuntimeError('gateway hiccup'))
        self.assertEqual(err['code'], 'agent_error')
        self.assertEqual(err['detail'], 'gateway hiccup')

    def test_unknown_structured_error_stays_agent_error(self):
        # 11-19 口径：agent_error 的 detail 只认 NodeRunError 类人话；网关
        # 归一化的英文笼统串（turn failed）留空，防漏到用户气泡
        err = _normalize_agent_error(AgentTurnError("turn_failed", "agent turn error", detail={"error_type": "turn_failed", "message": "turn failed"}))
        self.assertEqual(err['code'], 'agent_error')
        self.assertEqual(err['detail'], '')


class AgentInvokeFailureCallbackTests(OutboxConsumerTests):
    """agent.invoke 失败回投节点失败（失败可见性：不等 execution_timeout）。"""

    def test_invoke_failure_marks_node_record_failed_only(self):
        """新契约（2026-11-06 重试权威唯一归 Airflow + 11-24 RETRYING 定案）：
        worker 失败把节点记录置 RETRYING（额度未尽）+错误文本，零终局权、
        零内部回投——重试由引擎 RetryPolicy 重打 start 驱动，终局由 run 级
        对账收敛；额度耗尽才落 FAILED（终态失败）。"""
        from unittest.mock import patch
        from plane.orchestration.models import WorkItemExecution, NodeRuntimeRecord
        ex = start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
        on_engine_started(execution_id=ex.id, event_id="seed2", engine_run_ref=ex.id)
        WorkItemExecution.objects.filter(id=ex.id).update(business_status="running")
        NodeRuntimeRecord.objects.create(execution=ex, node_key="analyze_0", attempt=1)
        with patch("plane.orchestration.worker._internal_node_call") as pc:
            with patch("plane.orchestration.worker.invoke_agent_node",
                       side_effect=RuntimeError("gateway hiccup")):
                with self.assertRaises(RuntimeError):
                    handle_agent_invoke(execution_id=ex.id, node_key="analyze_0", attempt=1)
            pc.assert_not_called()  # 不回投、不判终局
        record = NodeRuntimeRecord.objects.get(execution=ex, node_key="analyze_0")
        # 夹具画布默认重试预算 >0 → RETRYING（用户面经 view() 映射为
        # failed 供引擎重试，时间线显示为执行中）
        self.assertEqual(record.status, NodeRuntimeRecord.Status.RETRYING)
        self.assertIn("gateway hiccup", str(record.result.get("error", "")))
        self.assertEqual(record.result.get("error_normalized", {}).get("code"), "agent_error")
        self.assertEqual(record.result.get("error_normalized", {}).get("detail"), "gateway hiccup")
        ex.refresh_from_db()
        self.assertEqual(ex.business_status, "running")  # 执行不因 worker 失败终局



class AgentInvokeSuccessAckTests(OutboxConsumerTests):
    """G1 消费回执集成：agent.invoke 成功收口后，有人的补充才以 bot 身份回评。"""

    def _run_success(self, ex, node_key):
        from unittest.mock import patch
        with patch("plane.orchestration.worker._internal_node_call"):
            with patch("plane.orchestration.worker.invoke_agent_node",
                       return_value="录入完成 单据 DEC2026【任务完成】"):
                handle_agent_invoke(execution_id=ex.id, node_key=node_key, attempt=1)

    def _seed_running_execution(self, node_key):
        from plane.orchestration.models import WorkItemExecution, NodeRuntimeRecord
        ex = start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
        on_engine_started(execution_id=ex.id, event_id="ack-seed", engine_run_ref=ex.id)
        WorkItemExecution.objects.filter(id=ex.id).update(business_status="running")
        NodeRuntimeRecord.objects.create(execution=ex, node_key=node_key, attempt=1)
        return ex

    def test_ack_posted_when_human_supplement_exists(self):
        from plane.db.models.issue import IssueComment
        ex = self._seed_running_execution("analyze_0")
        IssueComment.objects.create(
            project=self.project, workspace=self.ws, issue=self.issue, actor=self.owner,
            comment_html="<p>毛重 480</p>", created_by=self.owner)
        self._run_success(ex, "analyze_0")
        ack = IssueComment.objects.filter(issue=self.issue, actor__is_bot=True).first()
        self.assertIsNotNone(ack)
        self.assertIn("已用于本次执行", ack.comment_stripped)

    def test_no_ack_without_supplement(self):
        from plane.db.models.issue import IssueComment
        ex = self._seed_running_execution("analyze_0")
        self._run_success(ex, "analyze_0")
        self.assertFalse(IssueComment.objects.filter(issue=self.issue, actor__is_bot=True).exists())


class RuntimeTypeResolutionTests(TestCase):
    """A1（2026-11-15）：运行时类型按 applied release 快照显式解析，
    替代旧「先 builtin 后按报错文案换 ACP」的试探。"""

    def _call(self, releases_payload):
        def call(method, path, payload=None, timeout=30):
            self.assertEqual((method, path), ("GET", "/agents/agent:x/releases"))
            return releases_payload
        return call

    def test_builtin_snapshot(self):
        from plane.orchestration.worker import _resolve_runtime_type, _RUNTIME_CACHE
        _RUNTIME_CACHE.clear()
        dep = {"id": "dep:1", "appliedReleaseId": "rel:1"}
        rt = _resolve_runtime_type(
            self._call({"items": [{"id": "rel:1", "snapshot": {"runtime": {"type": "builtin"}}}]}),
            "agent:x", dep)
        self.assertEqual(rt, "builtin")

    def test_acp_snapshot(self):
        from plane.orchestration.worker import _resolve_runtime_type, _RUNTIME_CACHE
        _RUNTIME_CACHE.clear()
        dep = {"id": "dep:2", "appliedReleaseId": "rel:2"}
        rt = _resolve_runtime_type(
            self._call({"items": [{"id": "rel:2", "snapshot": {"runtime": {"type": "acp"}}}]}),
            "agent:x", dep)
        self.assertEqual(rt, "acp")

    def test_release_not_found_fails_loud(self):
        from plane.orchestration.worker import _resolve_runtime_type, _RUNTIME_CACHE
        _RUNTIME_CACHE.clear()
        with self.assertRaises(RuntimeError):
            _resolve_runtime_type(self._call({"items": []}), "agent:x",
                                  {"id": "dep:3", "appliedReleaseId": "rel:gone"})

    def test_unknown_type_fails_loud(self):
        from plane.orchestration.worker import _resolve_runtime_type, _RUNTIME_CACHE
        _RUNTIME_CACHE.clear()
        with self.assertRaises(RuntimeError):
            _resolve_runtime_type(
                self._call({"items": [{"id": "rel:4", "snapshot": {"runtime": {"type": "k8s"}}}]}),
                "agent:x", {"id": "dep:4", "appliedReleaseId": "rel:4"})

    def test_cached_by_deployment_and_release(self):
        from plane.orchestration.worker import _resolve_runtime_type, _RUNTIME_CACHE
        _RUNTIME_CACHE.clear()
        dep = {"id": "dep:5", "appliedReleaseId": "rel:5"}
        calls = {"n": 0}

        def counting_call(method, path, payload=None, timeout=30):
            calls["n"] += 1
            return {"items": [{"id": "rel:5", "snapshot": {"runtime": {"type": "builtin"}}}]}
        self.assertEqual(_resolve_runtime_type(counting_call, "agent:x", dep), "builtin")
        self.assertEqual(_resolve_runtime_type(counting_call, "agent:x", dep), "builtin")
        self.assertEqual(calls["n"], 1)  # 第二次命中缓存，不重复查


class DeploymentSelectionTests(TestCase):
    """invoke 部署解析：多 active 部署按 appliedReleaseNumber 取最大（2026-11-17）。"""

    def test_picks_max_release_number(self):
        from plane.orchestration.worker import _select_deployment
        items = [
            {"id": "dep:old", "definitionId": "agent:x", "lifecycleState": "active", "appliedReleaseNumber": 3},
            {"id": "dep:new", "definitionId": "agent:x", "lifecycleState": "active", "appliedReleaseNumber": 7},
            {"id": "dep:deleting", "definitionId": "agent:x", "lifecycleState": "deleting", "appliedReleaseNumber": 9},
            {"id": "dep:other", "definitionId": "agent:y", "lifecycleState": "active", "appliedReleaseNumber": 99},
        ]
        self.assertEqual(_select_deployment(items, "agent:x")["id"], "dep:new")  # 7 > 3；deleting/other 被过滤

    def test_not_deployed_when_no_active(self):
        from plane.orchestration.worker import _select_deployment, AgentTurnError
        items = [{"id": "dep:del", "definitionId": "agent:x", "lifecycleState": "deleting", "appliedReleaseNumber": 5}]
        with self.assertRaises(AgentTurnError):
            _select_deployment(items, "agent:x")

    def test_fallback_when_no_numeric_field(self):
        from plane.orchestration.worker import _select_deployment
        items = [
            {"id": "dep:a", "definitionId": "agent:x", "lifecycleState": "active"},
            {"id": "dep:b", "definitionId": "agent:x", "lifecycleState": "active"},
        ]
        self.assertIn(_select_deployment(items, "agent:x")["id"], {"dep:a", "dep:b"})
