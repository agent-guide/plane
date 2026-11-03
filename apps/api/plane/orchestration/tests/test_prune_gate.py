# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""剪枝闸门测试：条件分支已选后，死分支节点的 start/observe 权威判 skipped。

竞态场景（2026-11-03 物流演示实测）：传感器先于 worker 的 PENDING→SKIPPED
剪枝把死分支人工节点拉起（running + 已建审批）——闸门需在 start/observe
复核可达性并作废审批，否则 join 依赖死锁。
"""

from django.contrib.auth import get_user_model
from django.test import Client, TestCase

from plane.db.models.workspace import Workspace, WorkspaceMember
from plane.db.models.project import Project
from plane.db.models.issue import Issue
from plane.orchestration import services, workflows
from plane.orchestration.models import (
    BusinessApproval, NodeRuntimeRecord, OrchestrationOutbox,
    ProjectTeamBinding, WorkflowDefinition,
)
from plane.orchestration.execution import start_execution

User = get_user_model()

# 条件 + 双分支：check 完整→declare；缺失→fill(人工)→declare
CANVAS_CONDITION = {
    "version": 1,
    "nodes": [
        {"id": "check", "type": "condition", "position": {"x": 100, "y": 200},
         "data": {"name": "check", "expertId": "agent:t1:analyst", "prompt": "judge"}},
        {"id": "fill", "type": "human_confirm", "position": {"x": 320, "y": 400},
         "data": {"name": "fill", "approverUserId": "", "prompt": "fill missing"}},
        {"id": "declare", "type": "agent", "position": {"x": 560, "y": 200},
         "data": {"name": "declare", "prompt": "declare", "expertId": "agent:t1:analyst"}},
    ],
    "edges": [
        {"source": "check", "target": "declare", "label": "ok"},
        {"source": "check", "target": "fill", "label": "missing"},
        {"source": "fill", "target": "declare"},
    ],
}


class PruneGateTestBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user(email="pg-o@test.io", username="pg-o")
        cls.ws = Workspace.objects.create(name="pgws", slug="pgws-orch", owner=cls.owner)
        WorkspaceMember.objects.create(workspace=cls.ws, member=cls.owner, role=20)
        cls.project = Project.objects.create(name="pgp", identifier="PGORCH", workspace=cls.ws, created_by=cls.owner)
        cls.team = services.create_team(workspace_id=cls.ws.id, user_id=cls.owner.id, is_admin=True, name="pg团队")
        services.add_member(team=cls.team, user_id=cls.owner.id, is_admin=True, kind="human", role="dev", user_ref=cls.owner.id)
        services.add_member(team=cls.team, user_id=cls.owner.id, is_admin=True, kind="agent", role="analyst", agent_definition_id="agent:t1:analyst")
        services.activate_team(team=cls.team, user_id=cls.owner.id, is_admin=True)
        cls.workflow = WorkflowDefinition.objects.create(project=cls.project, name="pg流程", created_by=cls.owner)
        workflows.update_draft(workflow=cls.workflow, user_id=cls.owner.id, draft=CANVAS_CONDITION)
        v = workflows.save_draft_version(workflow=cls.workflow, user_id=cls.owner.id)
        publishing = workflows.start_publish(workflow=cls.workflow, user_id=cls.owner.id)
        cls.version = workflows.finish_publish(version=publishing, engine_deploy_ref={"dag": "x"})
        cls.issue = Issue.objects.create(project=cls.project, name="pg工作项", created_by=cls.owner)
        cls.binding = services.bind_project(
            project=cls.project, team=cls.team, user_id=cls.owner.id, is_admin=True, workflow_version=cls.version)

    def setUp(self):
        import os
        os.environ["ORCHESTRATION_INTERNAL_TOKEN"] = "pg-token"
        self.client = Client()
        self.ex = start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
        self.ex.engine_run_ref = "pg-run-1"
        self.ex.save(update_fields=["engine_run_ref"])
        # 前置：check 节点已成功并选择 ok 分支
        self.check = NodeRuntimeRecord.objects.create(
            execution=self.ex, node_key="check_0", status=NodeRuntimeRecord.Status.SUCCESS,
            result={"chosenBranch": "ok"})
        # 竞态残留：fill 节点已被传感器拉起（running）且建了待审批
        self.fill = NodeRuntimeRecord.objects.create(
            execution=self.ex, node_key="fill_1", status=NodeRuntimeRecord.Status.RUNNING)
        self.approval = BusinessApproval.objects.create(
            execution=self.ex, node_ref="fill_1", question="fill missing")

    def _url(self, node_key, action=""):
        base = f"/api/internal/workflow-runs/pg-run-1/nodes/{node_key}/"
        return f"{base}{action}/" if action else base

    def test_observe_prunes_running_dead_branch_and_voids_approval(self):
        r = self.client.get(self._url("fill_1"), HTTP_X_ORCHESTRATION_TOKEN="pg-token")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], "skipped")
        self.fill.refresh_from_db()
        self.assertEqual(self.fill.status, NodeRuntimeRecord.Status.SKIPPED)
        self.approval.refresh_from_db()
        self.assertEqual(self.approval.result, BusinessApproval.Result.REJECTED)

    def test_start_gate_blocks_dead_branch_before_handoff(self):
        NodeRuntimeRecord.objects.filter(pk=self.fill.pk).update(status=NodeRuntimeRecord.Status.PENDING)
        r = self.client.post(self._url("fill_1", "start"),
                             {"eventId": "e1", "payload": {"nodeKey": "fill_1"}},
                             content_type="application/json", HTTP_X_ORCHESTRATION_TOKEN="pg-token")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], "skipped")
        self.fill.refresh_from_db()
        self.assertEqual(self.fill.status, NodeRuntimeRecord.Status.SKIPPED)
        # start 被闸门拦截：不产生 agent.invoke 命令
        self.assertFalse(OrchestrationOutbox.objects.filter(
            command_type="agent.invoke", payload__nodeKey="fill_1").exists())

    def test_live_branch_untouched(self):
        r = self.client.post(self._url("declare_2", "start"),
                             {"eventId": "e2", "payload": {"nodeKey": "declare_2"}},
                             content_type="application/json", HTTP_X_ORCHESTRATION_TOKEN="pg-token")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], "running")
