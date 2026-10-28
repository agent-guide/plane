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
