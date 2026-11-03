# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""执行域服务：inbox 事件消费驱动状态机（规格 docs/orchestration-state-machine-spec.md）。

语义逐条对应旧 runtime_execution_repository.transition_task_binding：
- 乐观锁（version+状态双条件 UPDATE，0 行即冲突）
- 终态副作用（清当前成员、记 completed_at）
- last_event_id 幂等锚；非法转移拒绝
七处调用点 → 事件类型映射见规格第 4 节。
"""

from datetime import timezone
from django.db import transaction
from django.db.models import F
from django.utils import timezone as dj_tz

from .models import OrchestrationInbox, OrchestrationOutbox, WorkItemExecution
from .services import TeamDomainError
from .state_machine import TERMINAL_STATUSES, require_transition

# 引擎终态 → 业务终态（规格第 4 节调用点 5）
ENGINE_TERMINAL_MAP = {"success": "completed", "failed": "failed", "cancelled": "cancelled"}

# 哨兵：区分「事件未携带成员」（保持现状）与「显式清空成员」（人工答复恢复）。
_UNSET = object()


def transition_execution(*, execution: WorkItemExecution, target: str, event_id: str,
                         member=_UNSET) -> WorkItemExecution:
    """核心转移：守卫 + 乐观锁 + 终态副作用。

    任何失败都不落库、不改内存对象（调用方按 TeamDomainError 处理）。
    """
    current = execution.business_status
    prev_member = execution.current_member  # 转移前执行成员（§7.3 换牌的「上一任」）
    require_transition(current, target)  # 非法转移 → InvalidTransition(400 语义)
    event_id = (event_id or "")[:64]  # last_event_id varchar(64)：幂等锚截断防 DataError
    terminal = target in TERMINAL_STATUSES
    now = dj_tz.now()
    updated = WorkItemExecution.objects.filter(
        id=execution.id,
        transition_version=execution.transition_version,  # 乐观锁
        business_status=current,                          # 状态双条件
    ).update(
        business_status=target,
        current_member=(
            None if terminal or member is None
            else execution.current_member if member is _UNSET
            else member
        ),
        transition_version=F("transition_version") + 1,
        last_event_id=event_id,
        completed_at=now if terminal else None,
        updated_at=now,
    )
    if updated != 1:
        raise TeamDomainError(409, "EXECUTION_TRANSITION_CONFLICT", "Execution state changed concurrently")
    execution.refresh_from_db()
    # §6 投影（同库直写，失败不回滚——投影面非事实源）：
    # ① 状态打标；② 换牌（§7.3：agent handoff 上 bot、等待人工人上牌摘 bot）
    try:
        from .issue_state_sync import sync_issue_state
        issue = execution.issue
        sync_issue_state(issue=issue, business_status=target)
        if member is not _UNSET or target in ("waiting_human",):
            from .bot_provisioning import sync_issue_assignee
            sync_issue_assignee(
                issue=issue, previous_member=prev_member,
                next_member=(None if target in TERMINAL_STATUSES else execution.current_member),
                workspace_id=str(issue.workspace_id))
    except Exception as exc:
        import logging
        logging.getLogger("plane.orchestration").exception("issue projection failed: %s", exc)
    return execution



def _load_active(execution_id: str) -> WorkItemExecution:
    try:
        return WorkItemExecution.objects.get(id=execution_id)
    except WorkItemExecution.DoesNotExist:
        raise TeamDomainError(404, "EXECUTION_NOT_FOUND", "Execution not found")


# ---------------------------------------------------------------- 事件类型（规格第 4 节七调用点）


def on_engine_started(*, execution_id: str, event_id: str, engine_run_ref: str) -> WorkItemExecution:
    """调用点 1/2：受控启动/恢复 → queued→running（附引擎运行引用）。

    幂等：已在 running（引擎重投 started）时只补 run_ref 不再转移。
    """
    ex = _load_active(execution_id)
    if engine_run_ref:
        WorkItemExecution.objects.filter(id=ex.id).update(engine_run_ref=engine_run_ref)
    if ex.business_status == "running":
        return ex
    return transition_execution(execution=ex, target="running", event_id=event_id)


def on_human_handoff(*, execution_id: str, event_id: str, member, node_ref: str = "human") -> WorkItemExecution:
    """调用点 3：引擎人工节点 → running→waiting_human + 设人工成员 + 建待审批。

    幂等：已在 waiting_human（事件重投/此前建单失败遗留）时跳过转移但仍
    保证待审批存在——审批建单失败不得静默丢待办。
    """
    ex = _load_active(execution_id)
    # 审批人解析（与审批单 assignee 同源，§7.3）：优先人工节点指定审批人
    node = next((n for n in ((ex.binding.workflow_version.definition or {}).get("nodes") or [])
                 if n.get("key") == node_ref), {})
    from .issue_state_sync import approver_user_id_of
    approver_id = approver_user_id_of(node)
    approver_member = None
    if member is None and approver_id:
        # current_member 是 AgentTeamMember FK——审批人在团队里才可入位；
        # 不在团队时 member 保持 None，审批人上牌走转移后显式指派（下方）
        from .models import AgentTeamMember
        approver_member = AgentTeamMember.objects.filter(
            team=ex.binding.team, kind="human", user_id=approver_id).first()
        member = approver_member
    if ex.business_status == "waiting_human":
        execution = ex
    else:
        execution = transition_execution(execution=ex, target="waiting_human", event_id=event_id, member=member)
    _ensure_pending_approval(execution, member, node_ref, default_assignee_id=approver_id)
    # 审批人不在团队成员时：上牌仍归指定审批人（IssueAssignee FK=User，语义正确）
    if approver_member is None and approver_id and execution.current_member_id is None:
        from plane.db.models.issue import IssueAssignee
        from plane.db.models.project import ProjectMember
        issue = execution.issue
        ProjectMember.objects.get_or_create(
            project_id=issue.project_id, member_id=approver_id, defaults={"role": 15, "is_active": True})
        IssueAssignee.objects.get_or_create(
            issue=issue, assignee_id=approver_id, defaults={"project_id": issue.project_id})
        # 等待人工：摘 agent bot（历史失败转移可能遗留 prev 成员缺失，兜底按 bot 清）
        IssueAssignee.objects.filter(issue=issue, assignee__is_bot=True).delete()
    return execution


def _ensure_pending_approval(execution, member, node_ref: str = "human", *, default_assignee_id=None) -> None:
    """到达人工节点时落待审批（幂等：同执行同节点已有 pending 不重复建）。

    问题/选项/自由文本来自发布版本 definition 的人工节点（快照语义——
    后续画布编辑不影响已发布执行的审批内容）。
    """
    from .models import BusinessApproval
    if BusinessApproval.objects.filter(
            execution=execution, node_ref=node_ref,
            result=BusinessApproval.Result.PENDING).exists():
        return
    node = None
    try:
        definition = execution.binding.workflow_version.definition or {}
        candidates = [n for n in (definition.get("nodes") or []) if n.get("type") == "human_approval"]
        node = next((n for n in candidates if n.get("key") == node_ref), candidates[0] if candidates else None)
    except Exception:
        node = None
    # 默认选项英文文案（本地测试库 SQL_ASCII 不收非 ASCII JSON；label 由
    # 画布 definition 提供，缺省时前端有 approve/reject 既有文案兜底）
    options = (node or {}).get("options") or [
        {"label": "Approve", "value": "approve", "terminal": False},
        {"label": "Reject", "value": "reject", "terminal": True},
    ]
    # 问题注入前置节点输出（用户友好：审批人直接看到 agent 产出而非一行指令）
    question = (node or {}).get("message") or ""
    try:
        from .node_runtime import NodeRuntimeRecord
        prior = [
            f"【{(execution.binding.workflow_version.definition or {}).get('nodes') and next((n.get('name') for n in (execution.binding.workflow_version.definition or {}).get('nodes') or [] if n.get('key') == r.node_key), r.node_key)} 的输出】\n{(r.result or {}).get('output', '')}"
            for r in NodeRuntimeRecord.objects.filter(
                execution=execution, status=NodeRuntimeRecord.Status.SUCCESS,
            ).exclude(node_key=node_ref).order_by("updated_at")
        ]
        if prior:
            question = (question + "\n\n" if question else "") + "\n\n".join(prior)
    except Exception:
        pass
    # assignee：人类成员 > definition 钉的审批人 > 不钉（全员可答）
    assignee_id = getattr(member, "user_id", None) or _as_uuid((node or {}).get("approverUserId")) or _as_uuid(default_assignee_id)
    BusinessApproval.objects.create(
        execution=execution, node_ref=node_ref, options=options,
        question=question,
        free_text=bool((node or {}).get("freeText")),
        assignee_id=assignee_id,
    )


def _as_uuid(value):
    if not value:
        return None
    try:
        from uuid import UUID
        return str(UUID(str(value)))
    except (ValueError, TypeError):
        return None


def on_human_resume(*, execution_id: str, event_id: str) -> WorkItemExecution:
    """调用点 4：人工答复 → waiting_human→running + 清成员 + 人工节点收口 success
    （引擎 sensor 轮询 observe 到 success 才放行后续节点）。"""
    ex = _load_active(execution_id)
    if ex.business_status != "waiting_human":
        raise TeamDomainError(409, "EXECUTION_RESUME_CONFLICT", "Execution is not waiting for a human")
    resumed = transition_execution(execution=ex, target="running", event_id=event_id, member=None)
    from .node_runtime import NodeRuntimeRecord
    definition = (ex.binding.workflow_version.definition or {})
    human_keys = {n.get("key") for n in (definition.get("nodes") or []) if n.get("type") == "human_approval"}
    NodeRuntimeRecord.objects.filter(
        execution=ex, node_key__in=human_keys, status=NodeRuntimeRecord.Status.RUNNING,
    ).update(status=NodeRuntimeRecord.Status.SUCCESS, result={"resumedBy": event_id})
    return resumed


def on_engine_terminal(*, execution_id: str, event_id: str, engine_status: str) -> WorkItemExecution:
    """调用点 5：引擎终态结算（success/failed/cancelled 映射）。

    终态统一作废该执行的全部 pending 审批——等价旧链
    cancel_pending_agent_human_requests_for_agent_run 在 5 处终态路径的守卫
    （执行终结 ⇔ 无 pending 审批，收件箱不残留）。
    """
    target = ENGINE_TERMINAL_MAP.get(engine_status)
    if target is None:
        raise TeamDomainError(400, "ENGINE_STATUS_UNKNOWN", f"Unknown engine terminal status: {engine_status}")
    ex = _load_active(execution_id)
    settled = transition_execution(execution=ex, target=target, event_id=event_id)
    from .models import BusinessApproval
    from django.utils import timezone as dj_tz
    BusinessApproval.objects.filter(
        execution=settled, result=BusinessApproval.Result.PENDING,
    ).update(result=BusinessApproval.Result.REJECTED, reason="执行已终结",
             answered_at=dj_tz.now())
    return settled


def on_reconcile_stale(*, execution_id: str, event_id: str) -> WorkItemExecution:
    """调用点 6/7：陈旧排队对账 → queued→failed（fail-closed 可定位）。"""
    ex = _load_active(execution_id)
    if ex.business_status != "queued":
        raise TeamDomainError(409, "EXECUTION_RECONCILE_SKIPPED", "Execution is not queued")
    return transition_execution(execution=ex, target="failed", event_id=event_id)


# ---------------------------------------------------------------- inbox 消费（幂等入口）


EVENT_HANDLERS = {
    "engine.started": lambda p: on_engine_started(**p),
    "engine.human_handoff": lambda p: on_human_handoff(**p),
    "engine.human_resume": lambda p: on_human_resume(**p),
    "engine.terminal": lambda p: on_engine_terminal(**p),
    "engine.reconcile_stale": lambda p: on_reconcile_stale(**p),
}


def process_event(*, external_event_id: str, event_type: str, payload: dict) -> dict:
    """幂等消费：external_event_id 已处理 → skipped；未知类型 → rejected。"""
    if event_type not in EVENT_HANDLERS:
        return {"status": "rejected", "reason": "unknown_event_type"}
    with transaction.atomic():
        _, created = OrchestrationInbox.objects.get_or_create(
            external_event_id=external_event_id, defaults={"event_type": event_type, "payload": payload}
        )
        if not created:
            return {"status": "skipped", "reason": "duplicate"}
        execution_id = payload.get("executionId") or payload.get("execution_id", "")
        event_id = external_event_id  # last_event_id 幂等锚 = 外部事件 id
        kwargs = {"execution_id": execution_id, "event_id": event_id}
        for k in ("engine_run_ref", "member", "engine_status"):
            if k in payload:
                kwargs[k] = payload[k]
        # 人工交接事件带节点 key（缺省 "human"）
        if "nodeKey" in payload:
            kwargs["node_ref"] = payload["nodeKey"]
        try:
            execution = EVENT_HANDLERS[event_type](kwargs)
        except Exception:
            raise  # inbox 行已在事务内，失败回滚 → 可重投
        OrchestrationInbox.objects.filter(external_event_id=external_event_id).update(processed_at=dj_tz.now())
        return {"status": "applied", "business_status": execution.business_status, "version": execution.transition_version}


# ---------------------------------------------------------------- 受控启动（校验链清单 §1 启动段）


def start_execution(*, issue, binding, user_id) -> WorkItemExecution:
    """受控启动：校验链 + 冻结上下文 + outbox 启动命令（worker 触发引擎）。

    校验（顺序即暴露顺序）：
    EXECUTION_CONFLICT（已有活跃）→ AGENT_TEAM_INACTIVE → AGENT_TEAM_EMPTY
    → WORKFLOW_VERSION_NOT_PUBLISHED
    """
    from .models import ProjectTeamBinding, WorkflowVersion
    if WorkItemExecution.objects.filter(
        issue=issue,
    ).exclude(business_status__in=list(TERMINAL_STATUSES)).exists():
        raise TeamDomainError(409, "EXECUTION_CONFLICT", "Issue already has an active execution")
    if binding.status != ProjectTeamBinding.Status.ACTIVE:
        raise TeamDomainError(409, "PROJECT_TEAM_BINDING_NOT_FOUND", "No active binding")
    team = binding.team
    if team.status != "active":
        raise TeamDomainError(409, "AGENT_TEAM_INACTIVE", "Team is not active")
    if not team.members.filter(enabled=True).exists():
        raise TeamDomainError(409, "AGENT_TEAM_EMPTY", "An active team requires at least one enabled member")
    version = binding.workflow_version
    if version is None:
        # 两步绑定中间态：已绑团队未挂版本（建卡已被 PROJECT_NOT_BOUND 拦，此处 API 兜底）
        raise TeamDomainError(409, "PROJECT_TEAM_BINDING_NOT_FOUND", "No active binding")
    if version.status != WorkflowVersion.Status.PUBLISHED:
        raise TeamDomainError(409, "WORKFLOW_VERSION_NOT_PUBLISHED", "Workflow version is not published")

    frozen = {
        "projectId": str(binding.project_id), "issueId": str(issue.id),
        "teamId": str(team.id), "workflowVersionId": str(version.id),
        "workflowVersionHash": version.content_hash,
        "members": [
            {"id": m.id, "kind": m.kind, "agentDefinitionId": m.agent_definition_id}
            for m in team.members.filter(enabled=True)
        ],
        "startedBy": str(user_id),
    }
    try:
        with transaction.atomic():
            execution = WorkItemExecution.objects.create(
                issue=issue, binding=binding, frozen_context=frozen,
            )
            import hashlib, json as _json
            OrchestrationOutbox.objects.create(
                idempotency_key=f"start:{execution.id}",
                command_type="engine.start",
                payload={"executionId": execution.id, "workflowVersionId": str(version.id)},
                payload_hash=hashlib.sha256(_json.dumps(frozen, sort_keys=True).encode()).hexdigest(),
            )
            return execution
    except Exception as e:
        if "uniq_nonterminal_execution" in str(e):
            raise TeamDomainError(409, "EXECUTION_CONFLICT", "Issue already has an active execution")
        raise
