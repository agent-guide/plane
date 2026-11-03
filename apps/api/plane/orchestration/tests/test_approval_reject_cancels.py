# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""审批驳回/终止语义测试：rejected 答复取消执行（等价旧链 reject terminal），
不再恢复流程；approved 仍走恢复。"""

from django.contrib.auth import get_user_model
from django.test import TestCase

from plane.db.models.workspace import Workspace, WorkspaceMember
from plane.db.models.project import Project
from plane.db.models.issue import Issue
from .canvas import CANVAS_SINGLE
from plane.orchestration import services, workflows
from plane.orchestration.models import (
    BusinessApproval, OrchestrationOutbox, ProjectTeamBinding, WorkflowDefinition,
)
from plane.orchestration.execution import start_execution, on_human_handoff

User = get_user_model()


class ApprovalRejectCancelsTestBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user(email="ar-o@test.io", username="ar-o")
        cls.ws = Workspace.objects.create(name="arws", slug="arws-orch", owner=cls.owner)
        WorkspaceMember.objects.create(workspace=cls.ws, member=cls.owner, role=20)
        cls.project = Project.objects.create(name="arp", identifier="ARORCH", workspace=cls.ws, created_by=cls.owner)
        cls.team = services.create_team(workspace_id=cls.ws.id, user_id=cls.owner.id, is_admin=True, name="审批语义团队")
        services.add_member(team=cls.team, user_id=cls.owner.id, is_admin=True, kind="human", role="dev", user_ref=cls.owner.id)
        # 名册校验：夹具 AI 节点引用 agent:t1:analyst，需在册
        services.add_member(team=cls.team, user_id=cls.owner.id, is_admin=True, kind="agent", role="analyst", agent_definition_id="agent:t1:analyst")
        services.activate_team(team=cls.team, user_id=cls.owner.id, is_admin=True)
        cls.workflow = WorkflowDefinition.objects.create(project=cls.project, name="审批语义流程", created_by=cls.owner)
        workflows.update_draft(workflow=cls.workflow, user_id=cls.owner.id, draft=CANVAS_SINGLE)
        v = workflows.save_draft_version(workflow=cls.workflow, user_id=cls.owner.id)
        publishing = workflows.start_publish(workflow=cls.workflow, user_id=cls.owner.id)
        cls.version = workflows.finish_publish(version=publishing, engine_deploy_ref={"dag": "x"})
        cls.issue = Issue.objects.create(project=cls.project, name="审批语义工作项", created_by=cls.owner)
        cls.binding = services.bind_project(
            project=cls.project, team=cls.team, user_id=cls.owner.id, is_admin=True, workflow_version=cls.version)

    def _waiting_human_with_approval(self):
        ex = start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
        ex.business_status = "waiting_human"
        ex.save(update_fields=["business_status"])
        approval = BusinessApproval.objects.create(
            execution=ex, node_ref="analyze_0", assignee=self.owner,
            options=[{"label": "Approve", "value": "approve", "terminal": False},
                     {"label": "Reject", "value": "reject", "terminal": True}])
        return ex, approval


class CancelExecutionTests(ApprovalRejectCancelsTestBase):
    def test_cancel_execution_voids_pending_and_enqueues_engine_cancel(self):
        from plane.orchestration.execution import cancel_execution
        ex, approval = self._waiting_human_with_approval()
        ex2 = BusinessApproval.objects.get(pk=approval.pk).execution
        cancelled = cancel_execution(execution=ex2)
        self.assertEqual(cancelled.business_status, "cancelled")
        approval.refresh_from_db()
        self.assertEqual(approval.result, BusinessApproval.Result.REJECTED)
        self.assertTrue(OrchestrationOutbox.objects.filter(
            idempotency_key=f"cancel:{ex.id}", command_type="engine.cancel").exists())

    def test_cancel_rejects_terminal_execution(self):
        from plane.orchestration.execution import cancel_execution
        from plane.orchestration.services import TeamDomainError
        ex, _ = self._waiting_human_with_approval()
        ex.business_status = "completed"
        ex.save(update_fields=["business_status"])
        with self.assertRaises(TeamDomainError) as c:
            cancel_execution(execution=ex)
        self.assertEqual(c.exception.code, "EXECUTION_ALREADY_TERMINAL")


class TimelineNodeNameSnapshotTests(ApprovalRejectCancelsTestBase):
    """时间线节点名按执行冻结版本解析（版本切换后旧执行不回退机器 key）。"""

    def test_timeline_uses_frozen_version_names(self):
        from django.test import Client
        from plane.orchestration.models import NodeRuntimeRecord
        ex = start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
        NodeRuntimeRecord.objects.create(
            execution=ex, node_key="analyze_0", status=NodeRuntimeRecord.Status.SUCCESS)
        # 绑定切换到新版本（节点 key 变了，旧 key 在新版本对不上）
        graph = dict(self.workflow.draft)
        graph["nodes"] = [dict(n, id=n["id"] + "x") for n in graph["nodes"]]
        graph["edges"] = [dict(e, source=e["source"] + "x", target=e["target"] + "x") for e in graph["edges"]]
        workflows.update_draft(workflow=self.workflow, user_id=self.owner.id, draft=graph)
        v2 = workflows.save_draft_version(workflow=self.workflow, user_id=self.owner.id)
        v2 = workflows.finish_publish(
            version=workflows.start_publish(workflow=self.workflow, user_id=self.owner.id),
            engine_deploy_ref={"dag": "y"})
        from plane.orchestration import services
        services.upgrade_binding(binding=self.binding, user_id=self.owner.id, is_admin=True, workflow_version=v2)
        self.binding.refresh_from_db()
        self.assertNotEqual(self.binding.workflow_version_id, self.version.id)
        # 运行时面板时间线仍按冻结版本给出节点名（无机器 key）
        client = Client()
        client.force_login(self.owner)
        r = client.get(f"/api/workspaces/arws-orch/projects/{self.project.id}/work-items/{self.issue.id}/runtime/")
        self.assertEqual(r.status_code, 200, r.content)
        names = [e.get("nodeName") for e in r.json()["timeline"] if e.get("kind") == "node"]
        self.assertIn("analyze", names)
        self.assertFalse(any(n and n.startswith("analyze_") for n in names))
