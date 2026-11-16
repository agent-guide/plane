# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""人工确认「驳回=重做」语义测试（v2 定案 2026-11-15）：
- 默认形态驳回 → 上游最近 AI 节点重派（humanAnswer 注入 + attempt 自增 +
  确认节点回 PENDING），不取消执行
- 画布自定义选项驳回 → 维持终止语义（取消执行）
- 通过 → 拍板备注/附件落节点 output（下游 prior_outputs 携带）+ 评论回写
- start 人工分支：上游在跑时不重建审批（防旧产出早建单）
"""

from django.contrib.auth import get_user_model
from django.test import TestCase

from plane.db.models.workspace import Workspace, WorkspaceMember
from plane.db.models.project import Project, ProjectMember
from plane.db.models.issue import Issue, IssueComment
from plane.orchestration import services, workflows
from plane.orchestration.models import (
    BusinessApproval, NodeRuntimeRecord, WorkflowDefinition,
)
from plane.orchestration.execution import start_execution, on_human_handoff

User = get_user_model()

# AI → 人工确认 两节点图（画布形态：type agent/human → 编译后 ai/human_approval）
CANVAS_CONFIRM = {
    "version": 1,
    "nodes": [
        {"id": "analyze", "type": "agent",
         "data": {"name": "analyze", "prompt": "do analysis", "expertId": "agent:t1:analyst"}},
        {"id": "confirm", "type": "human_confirm", "data": {"name": "confirm"}},
    ],
    "edges": [{"source": "analyze", "target": "confirm"}],
}


class HumanRedoTestBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user(email="hr-o@test.io", username="hr-o")
        cls.ws = Workspace.objects.create(name="hrws", slug="hrws-orch", owner=cls.owner)
        WorkspaceMember.objects.create(workspace=cls.ws, member=cls.owner, role=20)
        cls.project = Project.objects.create(name="hrp", identifier="HRORCH", workspace=cls.ws, created_by=cls.owner)
        ProjectMember.objects.create(workspace=cls.ws, project=cls.project, member=cls.owner, role=20, is_active=True)
        cls.team = services.create_team(workspace_id=cls.ws.id, user_id=cls.owner.id, is_admin=True, name="重做团队")
        services.add_member(team=cls.team, user_id=cls.owner.id, is_admin=True, kind="human", role="dev", user_ref=cls.owner.id)
        services.add_member(team=cls.team, user_id=cls.owner.id, is_admin=True, kind="agent", role="analyst", agent_definition_id="agent:t1:analyst")
        services.activate_team(team=cls.team, user_id=cls.owner.id, is_admin=True)
        cls.workflow = WorkflowDefinition.objects.create(project=cls.project, name="重做流程", created_by=cls.owner)
        workflows.update_draft(workflow=cls.workflow, user_id=cls.owner.id, draft=CANVAS_CONFIRM)
        v = workflows.save_draft_version(workflow=cls.workflow, user_id=cls.owner.id)
        cls.version = workflows.finish_publish(
            version=workflows.start_publish(workflow=cls.workflow, user_id=cls.owner.id),
            engine_deploy_ref={"dag": "x"})
        cls.issue = Issue.objects.create(project=cls.project, name="重做工作项", created_by=cls.owner)
        cls.binding = services.bind_project(
            project=cls.project, team=cls.team, user_id=cls.owner.id, is_admin=True, workflow_version=cls.version)

    def setUp(self):
        # SQL_ASCII 测试库：中文进 JSON 会炸——默认选项标签与重做前缀全程
        # patch 为 ASCII（作答/重做发生在测试方法体内，不能只包建单阶段）
        from unittest.mock import patch
        from plane.orchestration import execution as execution_mod
        p1 = patch.object(execution_mod, "DEFAULT_HUMAN_OPTIONS",
                          [{"label": "Approve", "value": "approve", "terminal": False},
                           {"label": "Reject", "value": "reject", "terminal": True}])
        p2 = patch.object(execution_mod, "REDO_FEEDBACK_PREFIX", "[REDO]")
        p1.start(); p2.start()
        self.addCleanup(p1.stop); self.addCleanup(p2.stop)

    def _waiting_confirm(self, *, custom_options=False):
        """构造：analyze 成功 + confirm 等待人工（含待审批）。"""
        return self._waiting_confirm_inner(custom_options=custom_options)

    def _waiting_confirm_inner(self, *, custom_options=False):
        ex = start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
        NodeRuntimeRecord.objects.create(
            execution=ex, node_key="analyze_0",
            status=NodeRuntimeRecord.Status.SUCCESS, attempt=1,
            result={"output": "draft v1"})
        NodeRuntimeRecord.objects.create(
            execution=ex, node_key="confirm_1",
            status=NodeRuntimeRecord.Status.RUNNING, attempt=1)
        ex.business_status = "waiting_human"
        ex.save(update_fields=["business_status"])
        on_human_handoff(execution_id=ex.id, event_id="handoff:t1", member=None, node_ref="confirm_1")
        approval = BusinessApproval.objects.get(execution=ex, node_ref="confirm_1", result=BusinessApproval.Result.PENDING)
        if custom_options:
            # 画布自定义选项（终止语义）：落在流程定义节点上（作答端点按定义判定制）
            import json as _json
            from plane.orchestration.models import WorkflowVersion
            d = _json.loads(_json.dumps(self.version.definition))
            for n in d["nodes"]:
                if n["key"] == "confirm_1":
                    n["options"] = [{"label": "Stop", "value": "stop", "terminal": True}]
            WorkflowVersion.objects.filter(id=self.version.id).update(definition=d)
            self.version.refresh_from_db()
            approval.options = [{"label": "Stop", "value": "stop", "terminal": True}]
            approval.save(update_fields=["options"])
        return ex, approval

    def _answer(self, approval, decision, reason=""):
        from django.test import Client
        client = Client()
        client.force_login(self.owner)
        return client.post(
            f"/api/workspaces/hrws-orch/agent-teams/approvals/{approval.id}/",
            {"decision": decision, "reason": reason}, content_type="application/json")


class HumanRedoTests(HumanRedoTestBase):
    def test_reject_redoes_upstream_and_requeues_confirm(self):
        ex, approval = self._waiting_confirm()
        r = self._answer(approval, "rejected", "gross weight should be 480")
        self.assertEqual(r.status_code, 200, r.content)
        ex.refresh_from_db()
        self.assertEqual(ex.business_status, "running")  # 未取消
        upstream = NodeRuntimeRecord.objects.get(execution=ex, node_key="analyze_0")
        self.assertEqual(upstream.status, NodeRuntimeRecord.Status.RUNNING)
        self.assertEqual(upstream.attempt, 2)
        self.assertEqual(upstream.failure_retries, 0)
        self.assertIn("480", upstream.human_answer)
        confirm = NodeRuntimeRecord.objects.get(execution=ex, node_key="confirm_1")
        self.assertEqual(confirm.status, NodeRuntimeRecord.Status.PENDING)
        from .conftest import DEFERRED
        entry = DEFERRED.get(f"agent_call:{ex.id}:analyze_0:2")
        self.assertIsNotNone(entry)
        self.assertEqual(entry[0], "orchestration.agent_invoke")
        # 用户回执：bot 评论说明驳回去向
        self.assertTrue(IssueComment.objects.filter(
            issue=ex.issue, comment_stripped__contains="重新处理").exists())

    def test_reject_custom_options_still_terminates(self):
        ex, approval = self._waiting_confirm(custom_options=True)
        r = self._answer(approval, "rejected", "stop it")
        self.assertEqual(r.status_code, 200, r.content)
        ex.refresh_from_db()
        self.assertEqual(ex.business_status, "cancelled")

    def test_approve_records_note_for_downstream(self):
        ex, approval = self._waiting_confirm()
        r = self._answer(approval, "approved", "confirm gross 480")
        self.assertEqual(r.status_code, 200, r.content)
        confirm = NodeRuntimeRecord.objects.get(execution=ex, node_key="confirm_1")
        self.assertIn("gross 480", (confirm.result or {}).get("output", ""))
        # 作答回写评论
        self.assertTrue(IssueComment.objects.filter(
            issue=ex.issue, actor=self.owner, comment_stripped__contains="gross 480").exists())

    def test_start_human_waits_while_upstream_running(self):
        """驳回重做期间 sensor 重打 start：上游在跑不重建审批，确认节点回 PENDING。"""
        ex, approval = self._waiting_confirm()
        # 驳回已答（redo 由作答端点触发，此处直调服务模拟）
        from django.utils import timezone as dj_tz
        approval.result = BusinessApproval.Result.REJECTED
        approval.answered_at = dj_tz.now()
        approval.save(update_fields=["result", "answered_at"])
        from plane.orchestration.execution import on_human_redo
        on_human_redo(execution_id=ex.id, node_ref="confirm_1",
                      feedback="fix gross weight", event_id="redo:t1")
        # 旧审批已答，重打 start（sensor 语义）
        from django.test import Client
        import os
        os.environ["ORCHESTRATION_INTERNAL_TOKEN"] = "hr-token"
        ex.engine_run_ref = str(ex.id)
        ex.save(update_fields=["engine_run_ref"])
        client = Client()
        r = client.post(
            f"/api/internal/workflow-runs/{ex.id}/nodes/confirm_1/start/",
            {"eventId": "start:2", "eventType": "node.started", "attempt": 2,
             "payload": {"nodeKey": "confirm_1"}},
            content_type="application/json", HTTP_X_ORCHESTRATION_TOKEN="hr-token")
        self.assertEqual(r.status_code, 200, r.content)
        confirm = NodeRuntimeRecord.objects.get(execution=ex, node_key="confirm_1")
        self.assertEqual(confirm.status, NodeRuntimeRecord.Status.PENDING)
        # 未新建审批（旧审批已答，无新 pending）
        self.assertFalse(BusinessApproval.objects.filter(
            execution=ex, node_ref="confirm_1", result=BusinessApproval.Result.PENDING).exists())
