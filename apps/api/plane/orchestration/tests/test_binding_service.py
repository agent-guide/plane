# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""绑定域服务测试（黄金基准，校验链清单 §1 绑定段——每码至少一触发用例）。"""

from django.contrib.auth import get_user_model
from django.test import TestCase

from plane.db.models.workspace import Workspace
from plane.db.models.project import Project
from plane.orchestration import services
from plane.orchestration.models import AgentTeam, WorkflowDefinition, WorkflowVersion, ProjectTeamBinding
from plane.orchestration.services import TeamDomainError

User = get_user_model()


class BindingTestBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user(email="b-owner@test.io", username="b-owner")
        cls.ws = Workspace.objects.create(name="bws", slug="bws-orch", owner=cls.owner)
        cls.project = Project.objects.create(name="bp", identifier="BPORCH", workspace=cls.ws, created_by=cls.owner)
        # 活跃团队（带一名启用成员）
        cls.team = services.create_team(workspace_id=cls.ws.id, user_id=cls.owner.id, is_admin=True, name="绑定团队")
        services.add_member(team=cls.team, user_id=cls.owner.id, is_admin=True, kind="human", role="dev", user_ref=cls.owner.id)
        services.activate_team(team=cls.team, user_id=cls.owner.id, is_admin=True)
        # 流程 + 已发布版本
        cls.workflow = WorkflowDefinition.objects.create(project=cls.project, name="wf-b", created_by=cls.owner)
        cls.version = WorkflowVersion.objects.create(workflow=cls.workflow, version=1, status=WorkflowVersion.Status.PUBLISHED)

    def _bind(self, team=None, version=None):
        return services.bind_project(
            project=self.project, team=team or self.team, user_id=self.owner.id, is_admin=True,
            workflow_version=version or self.version,
        )


class ValidationChainTests(BindingTestBase):
    """校验链逐码触发（顺序即暴露顺序）。"""

    def test_team_not_in_workspace(self):
        other_ws = Workspace.objects.create(name="ows", slug="ows-orch", owner=self.owner)
        foreign = services.create_team(workspace_id=other_ws.id, user_id=self.owner.id, is_admin=True, name="外域团队")
        with self.assertRaises(TeamDomainError) as c:
            self._bind(team=foreign)
        self.assertEqual(c.exception.code, "AGENT_TEAM_NOT_FOUND")

    def test_team_inactive(self):
        draft = services.create_team(workspace_id=self.ws.id, user_id=self.owner.id, is_admin=True, name="草稿团队")
        with self.assertRaises(TeamDomainError) as c:
            self._bind(team=draft)
        self.assertEqual(c.exception.code, "AGENT_TEAM_INACTIVE")

    def test_conflict_second_active_binding(self):
        self._bind()
        with self.assertRaises(TeamDomainError) as c:
            self._bind()
        self.assertEqual(c.exception.code, "PROJECT_TEAM_BINDING_CONFLICT")

    def test_version_of_other_project(self):
        other_project = Project.objects.create(name="op", identifier="OPORCH", workspace=self.ws, created_by=self.owner)
        other_wf = WorkflowDefinition.objects.create(project=other_project, name="wf-o", created_by=self.owner)
        foreign_version = WorkflowVersion.objects.create(workflow=other_wf, version=1, status=WorkflowVersion.Status.PUBLISHED)
        with self.assertRaises(TeamDomainError) as c:
            self._bind(version=foreign_version)
        self.assertEqual(c.exception.code, "WORKFLOW_VERSION_NOT_FOUND")

    def test_version_not_published(self):
        draft_version = WorkflowVersion.objects.create(workflow=self.workflow, version=2, status=WorkflowVersion.Status.DRAFT)
        with self.assertRaises(TeamDomainError) as c:
            self._bind(version=draft_version)
        self.assertEqual(c.exception.code, "WORKFLOW_VERSION_NOT_PUBLISHED")

    def test_happy_path_binds_active(self):
        binding = self._bind()
        self.assertEqual(binding.status, ProjectTeamBinding.Status.ACTIVE)
        self.assertEqual(binding.workflow_version_id, self.version.id)


class TwoStepBindingTests(BindingTestBase):
    """两步绑定（成员收敛 §3.1/§3.2）：先绑团队（无版本）→ 建流程 → 挂载。"""

    def test_bind_team_only_leaves_version_null(self):
        binding = services.bind_project(
            project=self.project, team=self.team, user_id=self.owner.id, is_admin=True)
        self.assertEqual(binding.status, ProjectTeamBinding.Status.ACTIVE)
        self.assertIsNone(binding.workflow_version_id)

    def test_attach_version_completes_two_step(self):
        services.bind_project(project=self.project, team=self.team, user_id=self.owner.id, is_admin=True)
        binding = ProjectTeamBinding.objects.get(project=self.project, status=ProjectTeamBinding.Status.ACTIVE)
        services.upgrade_binding(binding=binding, user_id=self.owner.id, is_admin=True, workflow_version=self.version)
        binding.refresh_from_db()
        self.assertEqual(binding.workflow_version_id, self.version.id)

    def test_issue_create_gate_rejects_unattached_version(self):
        """建卡闸门（base.py PROJECT_NOT_BOUND）：已绑团队未挂版本 → 409。"""
        from django.test import Client
        from plane.db.models.workspace import WorkspaceMember
        from plane.db.models.project import ProjectMember
        from plane.db.models.issue import Issue
        WorkspaceMember.objects.create(workspace=self.ws, member=self.owner, role=20)
        ProjectMember.objects.create(project=self.project, member=self.owner, role=20)
        services.bind_project(project=self.project, team=self.team, user_id=self.owner.id, is_admin=True)
        client = Client()
        client.force_login(self.owner)
        r = client.post(f"/api/workspaces/{self.ws.slug}/projects/{self.project.id}/issues/",
                        {"title": "中间态建卡"}, content_type="application/json")
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json()["code"], "PROJECT_NOT_BOUND")
        self.assertFalse(Issue.objects.filter(project=self.project).exists())

    def test_auto_start_skips_unattached_version(self):
        """auto_start 信号：绑定未挂版本时建卡（绕闸门造数）不产生执行。"""
        from plane.db.models.issue import Issue
        from plane.orchestration.models import WorkItemExecution
        binding = services.bind_project(project=self.project, team=self.team, user_id=self.owner.id, is_admin=True)
        issue = Issue.objects.create(
            name="中间态卡", project=self.project, created_by=self.owner)
        self.assertFalse(
            WorkItemExecution.objects.filter(issue=issue).exists(),
            "未挂版本的绑定不应启动执行",
        )


class RosterValidationTests(BindingTestBase):
    """名册校验（成员收敛 §3.1/§3.2）：节点引用 ⊆ 团队 enabled 成员。"""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        from .canvas import CANVAS_SINGLE
        from plane.orchestration import workflows
        cls.team.members.all().delete()  # 重建名册：夹具 agent 不在册
        services.add_member(team=cls.team, user_id=cls.owner.id, is_admin=True, kind="human", role="dev", user_ref=cls.owner.id)
        workflows.update_draft(workflow=cls.workflow, user_id=cls.owner.id, draft=CANVAS_SINGLE)
        v = workflows.save_draft_version(workflow=cls.workflow, user_id=cls.owner.id)
        cls.version = workflows.finish_publish(
            version=workflows.start_publish(workflow=cls.workflow, user_id=cls.owner.id),
            engine_deploy_ref={"dag": "x"})

    def _bind_and_attach(self):
        binding = services.bind_project(project=self.project, team=self.team, user_id=self.owner.id, is_admin=True)
        services.upgrade_binding(binding=binding, user_id=self.owner.id, is_admin=True, workflow_version=self.version)
        return binding

    def test_upgrade_blocks_agent_outside_roster(self):
        binding = services.bind_project(project=self.project, team=self.team, user_id=self.owner.id, is_admin=True)
        with self.assertRaises(TeamDomainError) as c:
            services.upgrade_binding(binding=binding, user_id=self.owner.id, is_admin=True, workflow_version=self.version)
        self.assertEqual(c.exception.code, "WORKFLOW_AGENT_NOT_IN_TEAM")

    def test_upgrade_passes_once_agent_in_roster(self):
        services.add_member(team=self.team, user_id=self.owner.id, is_admin=True,
                            kind="agent", role="analyst", agent_definition_id="agent:t1:analyst")
        binding = self._bind_and_attach()
        self.assertEqual(binding.workflow_version_id, self.version.id)

    def test_start_blocks_after_member_disabled(self):
        """绑定后名册漂移：禁用 agent 成员 → 启动复核拦截（fail-closed）。"""
        from plane.db.models.issue import Issue
        from plane.orchestration import execution as execution_svc
        member = services.add_member(team=self.team, user_id=self.owner.id, is_admin=True,
                                     kind="agent", role="analyst", agent_definition_id="agent:t1:analyst")
        binding = self._bind_and_attach()
        services.update_member(team=self.team, member=member, user_id=self.owner.id, is_admin=True, enabled=False)
        issue = Issue.objects.create(project=self.project, name="漂移后建卡", created_by=self.owner)
        with self.assertRaises(TeamDomainError) as c:
            execution_svc.start_execution(issue=issue, binding=binding, user_id=self.owner.id)
        self.assertEqual(c.exception.code, "WORKFLOW_AGENT_NOT_IN_TEAM")

    def test_publish_requires_agent_on_ai_node(self):
        """通用 Agent 取缔：AI 节点空 expertId 发布被拒。"""
        from plane.orchestration import workflows
        from .canvas import CANVAS_SINGLE
        import copy
        draft = copy.deepcopy(CANVAS_SINGLE)
        draft["nodes"][0]["data"]["expertId"] = ""
        workflows.update_draft(workflow=self.workflow, user_id=self.owner.id, draft=draft)
        workflows.save_draft_version(workflow=self.workflow, user_id=self.owner.id)
        with self.assertRaises(TeamDomainError) as c:
            workflows.start_publish(workflow=self.workflow, user_id=self.owner.id)
        self.assertEqual(c.exception.code, "WORKFLOW_AGENT_REQUIRED")


class UpgradeTests(BindingTestBase):
    def test_explicit_upgrade_follows_new_release(self):
        self._bind()
        v2 = WorkflowVersion.objects.create(workflow=self.workflow, version=2, status=WorkflowVersion.Status.PUBLISHED)
        binding = ProjectTeamBinding.objects.get(project=self.project, status=ProjectTeamBinding.Status.ACTIVE)
        services.upgrade_binding(binding=binding, user_id=self.owner.id, is_admin=True, workflow_version=v2)
        binding.refresh_from_db()
        self.assertEqual(binding.workflow_version_id, v2.id)

    def test_upgrade_rejects_unpublished(self):
        self._bind()
        draft = WorkflowVersion.objects.create(workflow=self.workflow, version=2, status=WorkflowVersion.Status.DRAFT)
        binding = ProjectTeamBinding.objects.get(project=self.project)
        with self.assertRaises(TeamDomainError) as c:
            services.upgrade_binding(binding=binding, user_id=self.owner.id, is_admin=True, workflow_version=draft)
        self.assertEqual(c.exception.code, "WORKFLOW_VERSION_NOT_PUBLISHED")
