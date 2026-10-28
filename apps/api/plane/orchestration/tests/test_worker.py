# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""worker 测试：Airflow 客户端（重试/4xx 语义）+ outbox 消费（幂等/失败标记）。"""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from django.contrib.auth import get_user_model
from django.test import TestCase

from plane.db.models.workspace import Workspace
from plane.db.models.project import Project
from plane.db.models.issue import Issue
from plane.orchestration import services, workflows
from plane.orchestration.models import (
    OrchestrationOutbox, WorkflowDefinition, WorkflowVersion,
)
from plane.orchestration.execution import start_execution, on_engine_started
from plane.orchestration.worker import AirflowClient, AirflowError, process_outbox_once

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

    def test_4xx_not_retried(self):
        class Always400(FakeAirflow):
            def do_POST(self):
                self._respond(409, {"error": "conflict"})
        port = self.server.server_port
        self.server.RequestHandlerClass = Always400
        try:
            with self.assertRaises(AirflowError) as ctx:
                self.af_client.trigger_run("wf_x_v1", dag_run_id="r-2", conf={})
            self.assertEqual(ctx.exception.status, 409)
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
        services.activate_team(team=cls.team, user_id=cls.owner.id, is_admin=True)
        cls.wf = WorkflowDefinition.objects.create(project=cls.project, name="outbox 流程", created_by=cls.owner)
        workflows.update_draft(workflow=cls.wf, user_id=cls.owner.id, draft={"nodes": []})
        v = workflows.save_draft_version(workflow=cls.wf, user_id=cls.owner.id)
        pub = workflows.start_publish(workflow=cls.wf, user_id=cls.owner.id)
        cls.version = workflows.finish_publish(version=pub, engine_deploy_ref={})
        cls.binding = services.bind_project(
            project=cls.project, team=cls.team, user_id=cls.owner.id, is_admin=True, workflow_version=cls.version)
        cls.issue = Issue.objects.create(project=cls.project, name="outbox 工作项", created_by=cls.owner)

    def test_failed_engine_start_marks_failed_not_loop(self):
        """Airflow 未配置 → 命令标记 failed，不无限重试（等价性：取消/失败分开表示）。"""
        ex = start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
        on_engine_started(execution_id=ex.id, event_id="seed", engine_run_ref="af-run-ox")
        import os
        os.environ.pop("ORCHESTRATION_AIRFLOW_BASE_URL", None)
        stats = process_outbox_once(dag_root=None)
        self.assertEqual(stats["failed"], 1)
        cmd = OrchestrationOutbox.objects.get(idempotency_key=f"start:{ex.id}")
        self.assertEqual(cmd.state, OrchestrationOutbox.State.FAILED)
        self.assertEqual(cmd.attempts, 1)
        # 再消费不重复处理 failed
        stats2 = process_outbox_once(dag_root=None)
        self.assertEqual(stats2["processed"], 0)
