# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""API 层冒烟测试——编排域全链路经 HTTP 走一遍（验收最小路径）。"""

from django.contrib.auth import get_user_model
from django.test import Client, TestCase

from plane.db.models.workspace import Workspace, WorkspaceMember
from plane.db.models.project import Project
from plane.orchestration.models import WorkItemExecution
from plane.orchestration.execution import on_engine_started, on_human_handoff
from plane.db.models.issue import Issue

User = get_user_model()


class OrchestrationAPITest(TestCase):
    def setUp(self):
        self.client = Client()
        self.owner = User.objects.create_user(email="api-o@test.io", username="api-o")
        self.human = User.objects.create_user(email="api-h@test.io", username="api-h")
        self.ws = Workspace.objects.create(name="aws", slug="aws-orch", owner=self.owner)
        WorkspaceMember.objects.create(workspace=self.ws, member=self.owner, role=20)
        self.project = Project.objects.create(name="ap", identifier="APORCH2", workspace=self.ws, created_by=self.owner)
        self.client.force_login(self.owner)

    def test_full_journey_over_http(self):
        """建团队→加成员→上架→建流程→存版本→发布→绑定。"""
        r = self.client.post("/api/workspaces/aws-orch/orchestration/teams/", {"name": "HTTP 团队"}, content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)
        team_id = r.json()["id"]

        r = self.client.get(f"/api/workspaces/aws-orch/orchestration/teams/{team_id}/")
        self.assertEqual(r.status_code, 200)

        r = self.client.post(f"/api/workspaces/aws-orch/orchestration/teams/{team_id}/members/",
                             {"kind": "human", "userId": self.human.id, "role": "approver", "sequence": 1},
                             content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)

        r = self.client.post(f"/api/workspaces/aws-orch/orchestration/teams/{team_id}/activate/", content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], "active")

        r = self.client.post(f"/api/workspaces/aws-orch/projects/{self.project.id}/orchestration/workflows/",
                             {"name": "HTTP 流程"}, content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)
        wf_id = r.json()["id"]

        r = self.client.patch(f"/api/workspaces/aws-orch/projects/{self.project.id}/orchestration/workflows/{wf_id}/",
                              {"draft": {"nodes": [{"key": "analyze"}]}}, content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)

        r = self.client.post(f"/api/workspaces/aws-orch/projects/{self.project.id}/orchestration/workflows/{wf_id}/versions/",
                             content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)
        version_id = r.json()["id"]

        r = self.client.post(
            f"/api/workspaces/aws-orch/projects/{self.project.id}/orchestration/workflows/{wf_id}/versions/{version_id}/publish/",
            content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], "published")

        r = self.client.post(f"/api/workspaces/aws-orch/projects/{self.project.id}/orchestration/bindings/",
                             {"teamId": team_id, "workflowVersionId": version_id}, content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["status"], "active")

    def test_member_cannot_touch_others_team(self):
        self.client.post("/api/workspaces/aws-orch/orchestration/teams/", {"name": "归属"}, content_type="application/json")
        other_client = Client()
        WorkspaceMember.objects.create(workspace=self.ws, member=self.human, role=15)
        other_client.force_login(self.human)
        r = other_client.get("/api/workspaces/aws-orch/orchestration/teams/")
        self.assertEqual(r.status_code, 200)  # 列表可看
        r = other_client.post("/api/workspaces/aws-orch/orchestration/teams/", {"name": "我的也行"}, content_type="application/json")
        self.assertEqual(r.status_code, 201)  # 成员可自建

    def test_approval_answer_flow(self):
        """审批待办与作答（含执行状态联动）。"""
        from plane.orchestration import services
        from plane.orchestration.models import WorkflowDefinition, WorkflowVersion, ProjectTeamBinding, BusinessApproval
        team = services.create_team(workspace_id=self.ws.id, user_id=self.owner.id, is_admin=True, name="审批团队")
        member = services.add_member(team=team, user_id=self.owner.id, is_admin=True, kind="human", role="approver", user_ref=self.human.id)
        services.activate_team(team=team, user_id=self.owner.id, is_admin=True)
        wf = WorkflowDefinition.objects.create(project=self.project, name="审批流程", created_by=self.owner)
        version = WorkflowVersion.objects.create(workflow=wf, version=1, status=WorkflowVersion.Status.PUBLISHED)
        binding = services.bind_project(project=self.project, team=team, user_id=self.owner.id, is_admin=True, workflow_version=version)
        issue = Issue.objects.create(project=self.project, name="审批用工作项", created_by=self.owner)
        execution = WorkItemExecution.objects.create(issue=issue, binding=binding)
        on_engine_started(execution_id=execution.id, event_id="e0", engine_run_ref="r")
        on_human_handoff(execution_id=execution.id, event_id="e1", member=member)
        approval = BusinessApproval.objects.create(execution=execution, node_ref="n1:1", assignee=self.human, options=["approve", "reject"])

        human_client = Client()
        WorkspaceMember.objects.get_or_create(workspace=self.ws, member=self.human, defaults={"role": 15})
        human_client.force_login(self.human)
        r = human_client.get("/api/workspaces/aws-orch/orchestration/approvals/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()), 1)

        r = human_client.post(f"/api/workspaces/aws-orch/orchestration/approvals/{approval.id}/",
                              {"decision": "approved"}, content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        execution.refresh_from_db()
        self.assertEqual(execution.business_status, "running")  # 答复恢复执行
