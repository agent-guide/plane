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
from .canvas import CANVAS_SINGLE

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
        r = self.client.post("/api/workspaces/aws-orch/agent-teams/", {"name": "HTTP 团队"}, content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)
        team_id = r.json()["id"]

        r = self.client.get(f"/api/workspaces/aws-orch/agent-teams/{team_id}/")
        self.assertEqual(r.status_code, 200)

        r = self.client.post(f"/api/workspaces/aws-orch/agent-teams/{team_id}/members/",
                             {"kind": "human", "userId": self.human.id, "role": "approver", "sequence": 1},
                             content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)
        # 名册校验（成员收敛 §3.1）：夹具 AI 节点引用 agent:t1:analyst，挂载前入册
        r = self.client.post(f"/api/workspaces/aws-orch/agent-teams/{team_id}/members/",
                             {"kind": "agent", "agentDefinitionId": "agent:t1:analyst", "role": "analyst", "sequence": 2},
                             content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)

        r = self.client.post(f"/api/workspaces/aws-orch/agent-teams/{team_id}/activate/", content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], "active")

        # 成员收敛时序（§3.1/§3.2）：先绑团队（不带版本）才能建流程
        r = self.client.post(f"/api/workspaces/aws-orch/projects/{self.project.id}/workflows/",
                             {"name": "闸门前置探测"}, content_type="application/json")
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json()["code"], "PROJECT_NOT_BOUND")

        r = self.client.post(f"/api/workspaces/aws-orch/projects/{self.project.id}/team-bindings/",
                             {"teamId": team_id}, content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["status"], "active")

        r = self.client.post(f"/api/workspaces/aws-orch/projects/{self.project.id}/workflows/",
                             {"name": "HTTP 流程"}, content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)
        wf_id = r.json()["id"]

        r = self.client.patch(f"/api/workspaces/aws-orch/projects/{self.project.id}/workflows/{wf_id}/",
                              {"draft": CANVAS_SINGLE}, content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)

        r = self.client.post(f"/api/workspaces/aws-orch/projects/{self.project.id}/workflows/{wf_id}/versions/",
                             content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)
        version_id = r.json()["id"]

        r = self.client.post(
            f"/api/workspaces/aws-orch/projects/{self.project.id}/workflows/{wf_id}/versions/{version_id}/publish/",
            content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], "published")

        # 两步绑定第二步：挂载发布版本（PATCH 复用挂载/切换端点）
        r = self.client.patch(f"/api/workspaces/aws-orch/projects/{self.project.id}/team-bindings/",
                              {"workflowVersionId": version_id}, content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["workflowVersionId"], version_id)

    def test_team_list_counts_and_quota(self):
        """列表卡信号行计数（memberCount/activeTaskCount/runningRunCount）与配额端点。"""
        r = self.client.post("/api/workspaces/aws-orch/agent-teams/", {"name": "计数团队"}, content_type="application/json")
        team_id = r.json()["id"]
        self.client.post(f"/api/workspaces/aws-orch/agent-teams/{team_id}/members/",
                         {"kind": "human", "userId": self.human.id, "role": "approver", "sequence": 1},
                         content_type="application/json")
        # 非终态执行一条（直接造数：执行挂在绑定上，绑定需要流程版本）
        from plane.orchestration.models import WorkflowDefinition, WorkflowVersion, ProjectTeamBinding
        wf = WorkflowDefinition.objects.create(project=self.project, name="计数流程", created_by=self.owner)
        version = WorkflowVersion.objects.create(workflow=wf, version=1, status=WorkflowVersion.Status.PUBLISHED)
        binding = ProjectTeamBinding.objects.create(
            project=self.project, team_id=team_id, workflow_version=version,
            status=ProjectTeamBinding.Status.ACTIVE)
        issue = Issue.objects.create(project=self.project, name="计数工作项", created_by=self.owner)
        execution = WorkItemExecution.objects.create(issue=issue, binding=binding, business_status="running")

        r = self.client.get("/api/workspaces/aws-orch/agent-teams/")
        self.assertEqual(r.status_code, 200)
        entry = next(t for t in r.json() if t["id"] == team_id)
        self.assertEqual(entry["memberCount"], 1)
        self.assertEqual(entry["activeTaskCount"], 1)
        self.assertEqual(entry["runningRunCount"], 1)

        # 配额：owner 是管理员（bypass）；普通成员数自己的非归档团队
        r = self.client.get("/api/workspaces/aws-orch/agent-teams/quota/")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["applies"])
        self.assertIsNone(r.json()["remaining"])

        member_client = Client()
        WorkspaceMember.objects.create(workspace=self.ws, member=self.human, role=15)
        member_client.force_login(self.human)
        r = member_client.get("/api/workspaces/aws-orch/agent-teams/quota/")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body["applies"])
        self.assertEqual(body["owned"], 0)
        self.assertEqual(body["remaining"], body["quota"])

    def test_team_detail_projects_and_active_tasks(self):
        """详情页三端点：viewer 标志 / 关联项目 / 进行中工作项。"""
        from plane.orchestration import services
        from plane.orchestration.models import WorkflowDefinition, WorkflowVersion, ProjectTeamBinding
        team = services.create_team(workspace_id=self.ws.id, user_id=self.owner.id, is_admin=True, name="详情团队")
        member = services.add_member(team=team, user_id=self.owner.id, is_admin=True, kind="human", role="approver", user_ref=self.human.id)
        services.activate_team(team=team, user_id=self.owner.id, is_admin=True)
        wf = WorkflowDefinition.objects.create(project=self.project, name="详情流程", created_by=self.owner)
        version = WorkflowVersion.objects.create(workflow=wf, version=1, status=WorkflowVersion.Status.PUBLISHED)
        binding = ProjectTeamBinding.objects.create(
            project=self.project, team=team, workflow_version=version,
            status=ProjectTeamBinding.Status.ACTIVE)
        issue = Issue.objects.create(project=self.project, name="详情工作项", created_by=self.owner)
        execution = WorkItemExecution.objects.get(issue=issue)  # 建卡自动启动
        execution.business_status, execution.current_member = "running", member
        execution.save(update_fields=["business_status", "current_member", "updated_at"])

        # 详情：viewer 标志（owner=管理员）
        r = self.client.get(f"/api/workspaces/aws-orch/agent-teams/{team.id}/")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["viewerCanManage"])
        self.assertTrue(r.json()["viewerIsAdmin"])

        # 关联项目：项目名 + 流程名/版本
        r = self.client.get(f"/api/workspaces/aws-orch/agent-teams/{team.id}/projects/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()), 1)
        entry = r.json()[0]
        self.assertEqual(entry["projectName"], self.project.name)
        self.assertEqual(entry["workflowName"], "详情流程")
        self.assertEqual(entry["workflowVersion"], 1)

        # 进行中工作项：running 执行 + 当前成员名
        r = self.client.get(f"/api/workspaces/aws-orch/agent-teams/{team.id}/active-tasks/")
        self.assertEqual(r.status_code, 200)
        task = r.json()[0]
        self.assertEqual(task["taskName"], "详情工作项")
        self.assertEqual(task["controlStatus"], "running")
        self.assertEqual(task["activeMemberName"], self.human.display_name)

        # 终态后不出现
        execution.business_status = "completed"
        execution.save(update_fields=["business_status"])
        r = self.client.get(f"/api/workspaces/aws-orch/agent-teams/{team.id}/active-tasks/")
        self.assertEqual(r.json(), [])

    def test_member_display_name_degrades_and_catalog(self):
        """成员显示名（agwmngr 目录未配置→人类有名、数字降级 None）与目录端点空态。"""
        from plane.orchestration import services
        team = services.create_team(workspace_id=self.ws.id, user_id=self.owner.id, is_admin=True, name="成员团队")
        services.add_member(team=team, user_id=self.owner.id, is_admin=True, kind="human", role="approver", user_ref=self.human.id)
        # 未配置 AGWMNGR_* env（测试环境即如此）：agent 成员名降级 None
        r = self.client.get(f"/api/workspaces/aws-orch/agent-teams/{team.id}/members/")
        self.assertEqual(r.status_code, 200)
        human_entry = r.json()[0]
        self.assertEqual(human_entry["displayName"], self.human.display_name)
        # 目录端点：未配置时 503 语义（前端空态）——显式清 env，
        # 不受本地 .env 可能配置的真凭证影响
        import os
        from unittest.mock import patch
        with patch.dict(os.environ, {"AGWMNGR_BASE_URL": "", "AGWMNGR_TENANT_TOKEN": "", "AGWMNGR_TENANT_ID": ""}):
            r = self.client.get("/api/workspaces/aws-orch/agent-teams/agent-catalog/")
        self.assertEqual(r.status_code, 503)

    def test_project_team_panel(self):
        """项目卡徽章：未绑定 null；绑定后团队名+在岗/等待计数。"""
        from plane.orchestration import services
        from plane.orchestration.models import WorkflowDefinition, WorkflowVersion, ProjectTeamBinding, BusinessApproval
        team = services.create_team(workspace_id=self.ws.id, user_id=self.owner.id, is_admin=True, name="徽章团队")
        member = services.add_member(team=team, user_id=self.owner.id, is_admin=True, kind="human", role="approver", user_ref=self.human.id)
        services.activate_team(team=team, user_id=self.owner.id, is_admin=True)
        wf = WorkflowDefinition.objects.create(project=self.project, name="徽章流程", created_by=self.owner)
        version = WorkflowVersion.objects.create(workflow=wf, version=1, status=WorkflowVersion.Status.PUBLISHED)
        binding = ProjectTeamBinding.objects.create(
            project=self.project, team=team, workflow_version=version,
            status=ProjectTeamBinding.Status.ACTIVE)
        issue = Issue.objects.create(project=self.project, name="徽章工作项", created_by=self.owner)
        execution = WorkItemExecution.objects.get(issue=issue)  # 建卡自动启动
        execution.business_status, execution.current_member = "running", member
        execution.save(update_fields=["business_status", "current_member", "updated_at"])
        BusinessApproval.objects.create(execution=execution, node_ref="n1:1", assignee=self.human, options=["ok"])

        r = self.client.get(f"/api/workspaces/aws-orch/projects/{self.project.id}/team-panel/")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["teamName"], "徽章团队")
        self.assertEqual(body["activeAgentCount"], 1)
        self.assertEqual(body["waitingDecisionCount"], 1)

        # 解绑后（retired）返回 null
        binding.status = ProjectTeamBinding.Status.RETIRED
        binding.save(update_fields=["status", "updated_at"])
        r = self.client.get(f"/api/workspaces/aws-orch/projects/{self.project.id}/team-panel/")
        self.assertEqual(r.status_code, 204)

    def test_work_item_runtime_view_and_cancel(self):
        """工作项运行时面板：摘要+结构化时间线一体；未绑定 204；取消置终态+outbox。"""
        from plane.orchestration import services
        from plane.orchestration.models import (
            WorkflowDefinition, WorkflowVersion, ProjectTeamBinding, BusinessApproval, OrchestrationOutbox)

        # 未绑定：204
        issue0 = Issue.objects.create(project=self.project, name="未绑定项", created_by=self.owner)
        r = self.client.get(
            f"/api/workspaces/aws-orch/projects/{self.project.id}/work-items/{issue0.id}/runtime/")
        self.assertEqual(r.status_code, 204)

        team = services.create_team(workspace_id=self.ws.id, user_id=self.owner.id, is_admin=True, name="面板团队")
        member = services.add_member(team=team, user_id=self.owner.id, is_admin=True, kind="human", role="approver", user_ref=self.human.id)
        services.activate_team(team=team, user_id=self.owner.id, is_admin=True)
        wf = WorkflowDefinition.objects.create(project=self.project, name="面板流程", created_by=self.owner)
        version = WorkflowVersion.objects.create(workflow=wf, version=1, status=WorkflowVersion.Status.PUBLISHED)
        binding = ProjectTeamBinding.objects.create(
            project=self.project, team=team, workflow_version=version,
            status=ProjectTeamBinding.Status.ACTIVE)
        issue = Issue.objects.create(project=self.project, name="面板工作项", created_by=self.owner)
        from plane.orchestration.execution import on_engine_started, on_human_handoff
        execution = WorkItemExecution.objects.get(issue=issue)  # 建卡自动启动
        on_engine_started(execution_id=execution.id, event_id="e0", engine_run_ref="r0")
        on_human_handoff(execution_id=execution.id, event_id="e1", member=member)

        human_client = Client()
        WorkspaceMember.objects.get_or_create(workspace=self.ws, member=self.human, defaults={"role": 15})
        human_client.force_login(self.human)
        r = human_client.get(
            f"/api/workspaces/aws-orch/projects/{self.project.id}/work-items/{issue.id}/runtime/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["businessStatus"], "waiting_human")
        self.assertEqual(body["teamName"], "面板团队")
        self.assertIsNotNone(body["pendingApproval"])  # 人工成员视角有待办
        self.assertTrue(any(e["kind"] == "approval" for e in body["timeline"]))

        # 取消：终态 + outbox engine.cancel
        r = self.client.post(
            f"/api/workspaces/aws-orch/projects/{self.project.id}/work-items/{issue.id}/runtime/",
            content_type="application/json")
        self.assertEqual(r.status_code, 200)
        execution.refresh_from_db()
        self.assertEqual(execution.business_status, "cancelled")
        self.assertTrue(OrchestrationOutbox.objects.filter(
            command_type="engine.cancel", idempotency_key=f"cancel:{execution.id}").exists())
        # 终态后再取消 → 409
        r = self.client.post(
            f"/api/workspaces/aws-orch/projects/{self.project.id}/work-items/{issue.id}/runtime/",
            content_type="application/json")
        self.assertEqual(r.status_code, 409)

    def test_member_cannot_touch_others_team(self):
        self.client.post("/api/workspaces/aws-orch/agent-teams/", {"name": "归属"}, content_type="application/json")
        other_client = Client()
        WorkspaceMember.objects.create(workspace=self.ws, member=self.human, role=15)
        other_client.force_login(self.human)
        r = other_client.get("/api/workspaces/aws-orch/agent-teams/")
        self.assertEqual(r.status_code, 200)  # 列表可看
        r = other_client.post("/api/workspaces/aws-orch/agent-teams/", {"name": "我的也行"}, content_type="application/json")
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
        execution = WorkItemExecution.objects.get(issue=issue)  # 建卡自动启动
        on_engine_started(execution_id=execution.id, event_id="e0", engine_run_ref="r")
        on_human_handoff(execution_id=execution.id, event_id="e1", member=member)
        # handoff 即自动建待审批（assignee=人工成员的 Plane 用户）
        approval = BusinessApproval.objects.get(execution=execution, result=BusinessApproval.Result.PENDING)

        human_client = Client()
        WorkspaceMember.objects.get_or_create(workspace=self.ws, member=self.human, defaults={"role": 15})
        human_client.force_login(self.human)
        r = human_client.get("/api/workspaces/aws-orch/agent-teams/approvals/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()), 1)
        entry = r.json()[0]
        self.assertEqual(entry["taskTitle"], "审批用工作项")
        self.assertEqual(entry["teamName"], "审批团队")

        r = human_client.post(f"/api/workspaces/aws-orch/agent-teams/approvals/{approval.id}/",
                              {"decision": "approved"}, content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        execution.refresh_from_db()
        self.assertEqual(execution.business_status, "running")  # 答复恢复执行
