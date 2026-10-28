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
    require_transition(current, target)  # 非法转移 → InvalidTransition(400 语义)
    terminal = target in TERMINAL_STATUSES
    now = dj_tz.now()
    updated = WorkItemExecution.objects.filter(
        id=execution.id,
        transition_version=execution.transition_version,  # 乐观锁
        business_status=current,                          # 状态双条件
    ).update(
        business_status=target,
        current_member=(
            None if terminal
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
    return execution


def _load_active(execution_id: str) -> WorkItemExecution:
    try:
        return WorkItemExecution.objects.get(id=execution_id)
    except WorkItemExecution.DoesNotExist:
        raise TeamDomainError(404, "EXECUTION_NOT_FOUND", "Execution not found")


# ---------------------------------------------------------------- 事件类型（规格第 4 节七调用点）


def on_engine_started(*, execution_id: str, event_id: str, engine_run_ref: str) -> WorkItemExecution:
    """调用点 1/2：受控启动/恢复 → queued→running（附引擎运行引用）。"""
    ex = _load_active(execution_id)
    WorkItemExecution.objects.filter(id=ex.id).update(engine_run_ref=engine_run_ref)
    return transition_execution(execution=ex, target="running", event_id=event_id)


def on_human_handoff(*, execution_id: str, event_id: str, member) -> WorkItemExecution:
    """调用点 3：引擎人工节点 → running→waiting_human + 设人工成员。"""
    ex = _load_active(execution_id)
    return transition_execution(execution=ex, target="waiting_human", event_id=event_id, member=member)


def on_human_resume(*, execution_id: str, event_id: str) -> WorkItemExecution:
    """调用点 4：人工答复 → waiting_human→running + 清成员（等下个 agent 分派再设）。"""
    ex = _load_active(execution_id)
    if ex.business_status != "waiting_human":
        raise TeamDomainError(409, "EXECUTION_RESUME_CONFLICT", "Execution is not waiting for a human")
    return transition_execution(execution=ex, target="running", event_id=event_id, member=None)


def on_engine_terminal(*, execution_id: str, event_id: str, engine_status: str) -> WorkItemExecution:
    """调用点 5：引擎终态结算（success/failed/cancelled 映射）。"""
    target = ENGINE_TERMINAL_MAP.get(engine_status)
    if target is None:
        raise TeamDomainError(400, "ENGINE_STATUS_UNKNOWN", f"Unknown engine terminal status: {engine_status}")
    ex = _load_active(execution_id)
    return transition_execution(execution=ex, target=target, event_id=event_id)


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
