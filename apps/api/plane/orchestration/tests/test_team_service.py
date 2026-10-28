# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""团队域服务测试（黄金基准，语义移植自 test_runtime_teams_api 等旧用例）。

覆盖：全员自建权限矩阵 / 配额 / 名称冲突 / 生命周期守卫（上架前置、归档仅管理员、
归档不可变）/ 成员守卫（末位防护——走查发现①补测试、重复成员冲突）。
"""

from django.contrib.auth import get_user_model
from django.test import TestCase

from plane.db.models.workspace import Workspace
from plane.orchestration import services
from plane.orchestration.models import AgentTeam, AgentTeamMember
from plane.orchestration.services import TeamDomainError

User = get_user_model()


class TeamServiceTestBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.admin = User.objects.create_user(email="admin@test.io", username="admin-orch")
        cls.member = User.objects.create_user(email="member@test.io", username="member-orch")
        cls.other = User.objects.create_user(email="other@test.io", username="other-orch")
        cls.workspace = Workspace.objects.create(name="ws", slug="ws-orch", owner=cls.admin)


class PermissionMatrixTests(TeamServiceTestBase):
    """设计 2026-10-19 §1.2：成员自建 / 创建者管理 / 他人 403 / 归档仅管理员。"""

    def test_member_can_create_own_team_draft_with_creator(self):
        team = services.create_team(workspace_id=self.workspace.id, user_id=self.member.id, is_admin=False, name="我的团队")
        self.assertEqual(team.status, AgentTeam.Status.DRAFT)
        self.assertEqual(team.created_by_id, self.member.id)

    def test_others_team_write_forbidden(self):
        team = services.create_team(workspace_id=self.workspace.id, user_id=self.admin.id, is_admin=True, name="管理员团队")
        with self.assertRaises(TeamDomainError) as ctx:
            services.update_team(team=team, user_id=self.member.id, is_admin=False, name="改名")
        self.assertEqual(ctx.exception.code, "AGENT_TEAM_FORBIDDEN")
        with self.assertRaises(TeamDomainError):
            services.add_member(team=team, user_id=self.member.id, is_admin=False, kind="human", role="dev", user_ref=self.member)

    def test_creator_can_manage_own_team(self):
        team = services.create_team(workspace_id=self.workspace.id, user_id=self.member.id, is_admin=False, name="自管团队")
        updated = services.update_team(team=team, user_id=self.member.id, is_admin=False, objective="目标")
        self.assertEqual(updated.objective, "目标")

    def test_archive_admin_only(self):
        team = services.create_team(workspace_id=self.workspace.id, user_id=self.member.id, is_admin=False, name="待归档")
        with self.assertRaises(TeamDomainError) as ctx:
            services.archive_team(team=team, is_admin=False)
        self.assertEqual(ctx.exception.code, "AGENT_TEAM_ARCHIVE_FORBIDDEN")
        archived = services.archive_team(team=team, is_admin=True)
        self.assertEqual(archived.status, AgentTeam.Status.ARCHIVED)


class QuotaTests(TeamServiceTestBase):
    def test_member_quota_enforced_at_five(self):
        with self.settings(ORCHESTRATION_TEAM_QUOTA=2):
            services.create_team(workspace_id=self.workspace.id, user_id=self.member.id, is_admin=False, name="t1")
            services.create_team(workspace_id=self.workspace.id, user_id=self.member.id, is_admin=False, name="t2")
            with self.assertRaises(TeamDomainError) as ctx:
                services.create_team(workspace_id=self.workspace.id, user_id=self.member.id, is_admin=False, name="t3")
            self.assertEqual(ctx.exception.code, "AGENT_TEAM_QUOTA_EXCEEDED")

    def test_quota_counts_non_archived_only(self):
        with self.settings(ORCHESTRATION_TEAM_QUOTA=1):
            t1 = services.create_team(workspace_id=self.workspace.id, user_id=self.member.id, is_admin=False, name="t1")
            services.archive_team(team=t1, is_admin=True)
            services.create_team(workspace_id=self.workspace.id, user_id=self.member.id, is_admin=False, name="t2")  # 归档不占额

    def test_admin_bypasses_quota(self):
        with self.settings(ORCHESTRATION_TEAM_QUOTA=1):
            services.create_team(workspace_id=self.workspace.id, user_id=self.admin.id, is_admin=True, name="a1")
            services.create_team(workspace_id=self.workspace.id, user_id=self.admin.id, is_admin=True, name="a2")

    def test_name_conflict_within_workspace(self):
        services.create_team(workspace_id=self.workspace.id, user_id=self.member.id, is_admin=False, name="重名")
        with self.assertRaises(TeamDomainError) as ctx:
            services.create_team(workspace_id=self.workspace.id, user_id=self.admin.id, is_admin=True, name="重名")
        self.assertEqual(ctx.exception.code, "AGENT_TEAM_NAME_CONFLICT")


class LifecycleGuardTests(TeamServiceTestBase):
    def test_activate_requires_enabled_member(self):
        team = services.create_team(workspace_id=self.workspace.id, user_id=self.member.id, is_admin=False, name="空团队")
        with self.assertRaises(TeamDomainError) as ctx:
            services.activate_team(team=team, user_id=self.member.id, is_admin=False)
        self.assertEqual(ctx.exception.code, "AGENT_TEAM_EMPTY")

    def test_archived_team_immutable(self):
        team = services.create_team(workspace_id=self.workspace.id, user_id=self.member.id, is_admin=False, name="已归档")
        services.archive_team(team=team, is_admin=True)
        for call in (
            lambda: services.update_team(team=team, user_id=self.admin.id, is_admin=True, name="x"),
            lambda: services.activate_team(team=team, user_id=self.admin.id, is_admin=True),
            lambda: services.add_member(team=team, user_id=self.admin.id, is_admin=True, kind="human", role="r", user_ref=self.member),
        ):
            with self.assertRaises(TeamDomainError):
                call()


class MemberGuardTests(TeamServiceTestBase):
    def _active_team_with_member(self):
        team = services.create_team(workspace_id=self.workspace.id, user_id=self.member.id, is_admin=False, name="成员团队")
        services.add_member(team=team, user_id=self.member.id, is_admin=False, kind="human", role="dev", user_ref=self.other.id)
        services.activate_team(team=team, user_id=self.member.id, is_admin=False)
        return team

    def test_last_enabled_member_cannot_be_disabled(self):
        """走查发现①：旧系统此防护无测试——按等价性清单补齐。"""
        team = self._active_team_with_member()
        only = team.members.get()
        with self.assertRaises(TeamDomainError) as ctx:
            services.update_member(team=team, member=only, user_id=self.member.id, is_admin=False, enabled=False)
        self.assertEqual(ctx.exception.code, "AGENT_TEAM_EMPTY")

    def test_last_enabled_member_cannot_be_removed(self):
        team = self._active_team_with_member()
        only = team.members.get()
        with self.assertRaises(TeamDomainError):
            services.remove_member(team=team, member=only, user_id=self.member.id, is_admin=False)

    def test_can_disable_when_another_enabled_exists(self):
        team = self._active_team_with_member()
        services.add_member(team=team, user_id=self.member.id, is_admin=False, kind="human", role="qa", user_ref=self.admin.id)
        first = team.members.filter(user_id=self.other.id).get()
        services.update_member(team=team, member=first, user_id=self.member.id, is_admin=False, enabled=False)  # 不抛即过

    def test_duplicate_member_rejected(self):
        team = self._active_team_with_member()
        with self.assertRaises(TeamDomainError) as ctx:
            services.add_member(team=team, user_id=self.member.id, is_admin=False, kind="human", role="dev2", user_ref=self.other.id)
        self.assertEqual(ctx.exception.code, "AGENT_TEAM_MEMBER_CONFLICT")

    def test_agent_member_requires_definition_ref(self):
        team = services.create_team(workspace_id=self.workspace.id, user_id=self.member.id, is_admin=False, name="agent 团队")
        with self.assertRaises(TeamDomainError):
            services.add_member(team=team, user_id=self.member.id, is_admin=False, kind="agent", role="dev")
        m = services.add_member(team=team, user_id=self.member.id, is_admin=False, kind="agent", role="dev",
                                agent_definition_id="agent:tenant-demo:demo-assistant")
        self.assertEqual(m.kind, AgentTeamMember.Kind.AGENT)
        self.assertEqual(m.agent_definition_id, "agent:tenant-demo:demo-assistant")
