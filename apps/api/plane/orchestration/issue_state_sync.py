# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""控制状态 → 工作项状态打标（等价清单 §6「优化」形态：同库直写）。

寻址按 State.external_id 标签（= 控制状态码，项目模板 DEFAULT_STATES 自带，
用户改名不影响）；**不建任何状态**——状态归用户管理。带标签态被删时回退
组默认，仍无则跳过（状态打标是投影面，失败不阻塞执行）。

负责人规则（§7.3）：等待人工时上牌取人工节点指定审批人（与审批单同源），
缺失回退团队人类成员；agent 上牌见 bot_provisioning（AI 节点 start）。
"""

from plane.db.models.state import State


def _target_state(project_id: str, business_status: str) -> State | None:
    tagged = State.objects.filter(project_id=project_id, external_id=business_status).first()
    if tagged is not None:
        return tagged
    # 边界回退：用户删除了带标签态 → 组默认（模板组语义）
    group = {
        "queued": "backlog", "running": "started", "waiting_human": "started",
        "completed": "completed", "failed": "cancelled", "cancelled": "cancelled",
    }.get(business_status)
    if group is None:
        return None
    return State.objects.filter(project_id=project_id, group=group, default=True).first() or \
        State.objects.filter(project_id=project_id, group=group).order_by("sequence").first()


def sync_issue_state(*, issue, business_status: str) -> None:
    """执行状态直写工作项状态；无可用目标态时静默跳过。"""
    state = _target_state(str(issue.project_id), business_status)
    if state is not None and issue.state_id != state.id:
        issue.state = state
        issue.save(update_fields=["state", "updated_at"])


def approver_user_id_of(node: dict) -> str | None:
    """人工节点指定审批人（definition 快照的 approverUserId）。"""
    value = str(node.get("approverUserId") or "").strip()
    return value or None
