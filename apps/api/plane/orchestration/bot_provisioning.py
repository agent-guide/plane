# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""数字员工 Plane bot 账号供给（等价旧 ADR 0011 bot 供给语义，2026-10-30）。

agent（agwmngr 定义）→ Plane bot 用户幂等供给：
- 邮箱 `agent-<definition hash 12>@runtime.local` 为幂等锚点（GitLab 式服务账号惯例）
- display_name 取 agwmngr 目录 draft.name（读时聚合；目录不可达时回退 id 尾段）
- 同时 ensure 工作区成员（bot 需在册才可被指派）

上牌规则（等价旧 §7.3，09-12 摘牌边界勿回退）：
- handoff→agent：换牌（摘上一个执行成员，上 bot）
- waiting_human：人上牌 + 摘 agent bot（等待时数字员工不占牌）
- 其余转移不动牌
"""

import hashlib

from django.contrib.auth import get_user_model

from plane.db.models.workspace import Workspace, WorkspaceMember


def ensure_bot_for_agent(*, agent_definition_id: str, workspace_id: str, display_name: str | None = None):
    """幂等供给 agent 的 bot 用户；返回 User（供给失败降级返回 None——上牌非事实源）。"""
    User = get_user_model()
    digest = hashlib.sha256(agent_definition_id.encode()).hexdigest()[:12]
    email = f"agent-{digest}@runtime.local"
    user = User.objects.filter(email=email).first()
    if user is None:
        name = display_name or _directory_name(agent_definition_id) or agent_definition_id.rsplit(":", 1)[-1]
        user = User.objects.create(
            email=email, username=f"agent-{digest}", display_name=name,
            first_name=name[:30], last_name="", is_bot=True, is_active=True,
            is_password_autoset=True,
        )
    member = WorkspaceMember.objects.filter(workspace_id=workspace_id, member=user).first()
    if member is None:
        WorkspaceMember.objects.create(workspace_id=workspace_id, member=user, role=15)
    return user


def _directory_name(agent_definition_id: str) -> str | None:
    from .agent_directory import resolve_agent_names
    return resolve_agent_names([agent_definition_id]).get(agent_definition_id)


def sync_issue_assignee(*, issue, previous_member, next_member, workspace_id: str) -> None:
    """换牌：摘上一任（agent→bot / human→user），上新一任。"""
    from plane.db.models.issue import IssueAssignee
    from plane.db.models.project import ProjectMember
    remove_id = _plane_user_of(previous_member, workspace_id)
    add_user = (ensure_bot_for_agent(agent_definition_id=next_member.agent_definition_id,
                                     workspace_id=workspace_id) if next_member and next_member.kind == "agent"
                else next_member.user if next_member and next_member.kind == "human" else None)
    if add_user is not None:
        # 指派要求项目在册（Plane 校验）；bot ensure 项目成员，human 走成员身份天然在册
        ProjectMember.objects.get_or_create(
            project_id=issue.project_id, member=add_user, defaults={"role": 15, "is_active": True})
        IssueAssignee.objects.get_or_create(issue=issue, assignee=add_user, defaults={"project_id": issue.project_id})
    if remove_id is not None and (add_user is None or add_user.id != remove_id):
        IssueAssignee.objects.filter(issue=issue, assignee_id=remove_id).delete()


def _plane_user_of(member, workspace_id: str):
    if member is None:
        return None
    if getattr(member, "user_id", None):
        return member.user_id
    if getattr(member, "kind", "") == "agent" and getattr(member, "agent_definition_id", ""):
        bot = ensure_bot_for_agent(agent_definition_id=member.agent_definition_id, workspace_id=workspace_id)
        return bot.id if bot else None
    return None
