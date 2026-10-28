# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""团队域服务层（阶段 2′）——权限矩阵/配额/生命周期守卫。

语义来源（等价性清单 §1 + 校验链清单 §1 团队段，2026-10-19 全员自建设计 §1.2）：
- 成员可自建团队（配额内，draft 起步，created_by 落库）
- 创建者管理自己的团队；workspace 管理员全权且 bypass 配额
- 他人团队写操作拒绝；归档仅管理员；活跃团队至少一名启用成员
- 上架（active）前置：≥1 启用成员
"""

from django.core.exceptions import PermissionDenied
from django.db import IntegrityError, transaction
from django.db.models import Q

from .models import AgentTeam, AgentTeamMember

DEFAULT_TEAM_QUOTA = 5


class TeamDomainError(Exception):
    """团队域业务错误（码 + 语义 HTTP 状态，映射旧 ApiError 契约）。"""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _quota() -> int:
    from django.conf import settings
    return int(getattr(settings, "ORCHESTRATION_TEAM_QUOTA", DEFAULT_TEAM_QUOTA))


def _require_manage(team: AgentTeam, user_id, is_admin: bool) -> None:
    """权限谓词：管理员 or 创建者；否则 403（AGENT_TEAM_FORBIDDEN）。"""
    if is_admin:
        return
    if team.created_by_id != user_id:
        raise TeamDomainError(403, "AGENT_TEAM_FORBIDDEN", "Only the creator or an admin can manage this team")


def create_team(*, workspace_id: str, user_id, is_admin: bool, name: str, objective: str = "") -> AgentTeam:
    name = (name or "").strip()
    if not name:
        raise TeamDomainError(400, "AGENT_TEAM_NAME_REQUIRED", "Team name is required")
    if not is_admin:
        # 配额（管理员 bypass；只数自己创建的非归档团队）
        active = AgentTeam.objects.filter(
            workspace_id=workspace_id, created_by_id=user_id
        ).exclude(status=AgentTeam.Status.ARCHIVED).count()
        if active >= _quota():
            raise TeamDomainError(409, "AGENT_TEAM_QUOTA_EXCEEDED", f"Team quota ({_quota()}) reached")
    try:
        return AgentTeam.objects.create(
            workspace_id=workspace_id, created_by_id=user_id, name=name,
            objective=objective, status=AgentTeam.Status.DRAFT,
        )
    except IntegrityError:
        raise TeamDomainError(409, "AGENT_TEAM_NAME_CONFLICT", "Team name already exists in this workspace")


def update_team(*, team: AgentTeam, user_id, is_admin: bool, name: str | None = None, objective: str | None = None) -> AgentTeam:
    if team.status == AgentTeam.Status.ARCHIVED:
        raise TeamDomainError(409, "AGENT_TEAM_ARCHIVED_IMMUTABLE", "Archived teams are immutable")
    _require_manage(team, user_id, is_admin)
    if name is not None and name.strip() and name.strip() != team.name:
        team.name = name.strip()
    if objective is not None:
        team.objective = objective
    try:
        team.save()
    except IntegrityError:
        raise TeamDomainError(409, "AGENT_TEAM_NAME_CONFLICT", "Team name already exists in this workspace")
    return team


def activate_team(*, team: AgentTeam, user_id, is_admin: bool) -> AgentTeam:
    _require_manage(team, user_id, is_admin)
    if team.status == AgentTeam.Status.ARCHIVED:
        raise TeamDomainError(409, "AGENT_TEAM_ARCHIVED_IMMUTABLE", "Archived teams are immutable")
    if not team.members.filter(enabled=True).exists():
        raise TeamDomainError(409, "AGENT_TEAM_EMPTY", "An active team requires at least one enabled member")
    team.status = AgentTeam.Status.ACTIVE
    team.save(update_fields=["status", "updated_at"])
    return team


def archive_team(*, team: AgentTeam, is_admin: bool) -> AgentTeam:
    # 归档仅管理员（设计 §1.2）
    if not is_admin:
        raise TeamDomainError(403, "AGENT_TEAM_ARCHIVE_FORBIDDEN", "Only admins can archive teams")
    team.status = AgentTeam.Status.ARCHIVED
    team.save(update_fields=["status", "updated_at"])
    return team


def add_member(*, team: AgentTeam, user_id, is_admin: bool, kind: str, role: str,
               user_ref=None, agent_definition_id: str = "", capabilities=None, sequence: int = 1) -> AgentTeamMember:
    _require_manage(team, user_id, is_admin)
    if team.status == AgentTeam.Status.ARCHIVED:
        raise TeamDomainError(409, "AGENT_TEAM_ARCHIVED_IMMUTABLE", "Archived teams are immutable")
    if kind == AgentTeamMember.Kind.HUMAN and user_ref is None:
        raise TeamDomainError(400, "AGENT_TEAM_MEMBER_REF_REQUIRED", "Human member requires a user reference")
    if kind == AgentTeamMember.Kind.AGENT and not agent_definition_id:
        raise TeamDomainError(400, "AGENT_TEAM_MEMBER_REF_REQUIRED", "Agent member requires an agent definition reference")
    try:
        with transaction.atomic():
            return AgentTeamMember.objects.create(
                team=team, kind=kind, user_id=user_ref if kind == AgentTeamMember.Kind.HUMAN else None,
                agent_definition_id=agent_definition_id if kind == AgentTeamMember.Kind.AGENT else "",
                role=role, capabilities=capabilities or [], sequence=sequence, enabled=True,
            )
    except IntegrityError:
        raise TeamDomainError(409, "AGENT_TEAM_MEMBER_CONFLICT", "Member already exists in this team")


def update_member(*, team: AgentTeam, member: AgentTeamMember, user_id, is_admin: bool, **values) -> AgentTeamMember:
    _require_manage(team, user_id, is_admin)
    enabled = values.get("enabled", member.enabled)
    if (
        team.status == AgentTeam.Status.ACTIVE
        and member.enabled
        and enabled is False
        and team.members.filter(enabled=True).count() == 1
    ):
        # 末位启用成员防护（走查发现①：旧系统无测试，此处按等价性清单补）
        raise TeamDomainError(409, "AGENT_TEAM_EMPTY", "An active team requires at least one enabled member")
    for field in ("role", "capabilities", "sequence"):
        if field in values and values[field] is not None:
            setattr(member, field, values[field])
    member.enabled = enabled
    member.save()
    return member


def remove_member(*, team: AgentTeam, member: AgentTeamMember, user_id, is_admin: bool) -> None:
    _require_manage(team, user_id, is_admin)
    if team.status == AgentTeam.Status.ACTIVE and member.enabled and team.members.filter(enabled=True).count() == 1:
        raise TeamDomainError(409, "AGENT_TEAM_EMPTY", "An active team requires at least one enabled member")
    member.delete()


# ---------------------------------------------------------------- 绑定域

"""绑定校验链（校验链清单 §1，顺序即暴露顺序，不得调换）：

PROJECT_INACTIVE → AGENT_TEAM_NOT_FOUND → AGENT_TEAM_INACTIVE
→ PROJECT_TEAM_BINDING_CONFLICT → WORKFLOW_VERSION_NOT_FOUND
→ WORKFLOW_VERSION_NOT_PUBLISHED → WORKFLOW_ENGINE_CONNECTION_INACTIVE(env 承载)
"""

from .models import ProjectTeamBinding, WorkflowVersion


def bind_project(*, project, team: AgentTeam, user_id, is_admin: bool,
                 workflow_version: WorkflowVersion) -> ProjectTeamBinding:
    _require_manage(team, user_id, is_admin)
    if team.workspace_id != project.workspace_id:
        raise TeamDomainError(404, "AGENT_TEAM_NOT_FOUND", "Team not found in this workspace")
    if team.status != AgentTeam.Status.ACTIVE:
        raise TeamDomainError(409, "AGENT_TEAM_INACTIVE", "Team is not active")
    if ProjectTeamBinding.objects.filter(project=project, status=ProjectTeamBinding.Status.ACTIVE).exists():
        raise TeamDomainError(409, "PROJECT_TEAM_BINDING_CONFLICT", "Project already has an active team binding")
    if workflow_version.workflow.project_id != project.id:
        raise TeamDomainError(404, "WORKFLOW_VERSION_NOT_FOUND", "Workflow version not found for this project")
    if workflow_version.status != WorkflowVersion.Status.PUBLISHED:
        raise TeamDomainError(409, "WORKFLOW_VERSION_NOT_PUBLISHED", "Workflow version is not published")
    try:
        with transaction.atomic():
            return ProjectTeamBinding.objects.create(
                project=project, team=team, workflow_version=workflow_version,
                status=ProjectTeamBinding.Status.ACTIVE,
            )
    except IntegrityError:
        # partial unique 兜底：并发下另一条活跃绑定先落库
        raise TeamDomainError(409, "PROJECT_TEAM_BINDING_CONFLICT", "Project already has an active team binding")


def upgrade_binding(*, binding: ProjectTeamBinding, user_id, is_admin: bool,
                    workflow_version: WorkflowVersion) -> ProjectTeamBinding:
    """显式升级到新发布版本（不自动跟随，沿用既有语义）。"""
    _require_manage(binding.team, user_id, is_admin)
    if binding.status != ProjectTeamBinding.Status.ACTIVE:
        raise TeamDomainError(404, "PROJECT_TEAM_BINDING_NOT_FOUND", "No active binding")
    if workflow_version.workflow.project_id != binding.project_id:
        raise TeamDomainError(404, "WORKFLOW_VERSION_NOT_FOUND", "Workflow version not found for this project")
    if workflow_version.status != WorkflowVersion.Status.PUBLISHED:
        raise TeamDomainError(409, "WORKFLOW_VERSION_NOT_PUBLISHED", "Workflow version is not published")
    binding.workflow_version = workflow_version
    binding.save(update_fields=["workflow_version", "updated_at"])
    return binding
