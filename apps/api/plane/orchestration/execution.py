# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""执行域服务：inbox 事件消费驱动状态机（规格 docs/orchestration-state-machine-spec.md）。

语义逐条对应旧 runtime_execution_repository.transition_task_binding：
- 乐观锁（version+状态双条件 UPDATE，0 行即冲突）
- 终态副作用（清当前成员、记 completed_at）
- last_event_id 幂等锚；非法转移拒绝
七处调用点 → 事件类型映射见规格第 4 节。
"""

from django.db import transaction
from django.db.models import F
from django.utils import timezone as dj_tz

from .models import OrchestrationInbox, WorkItemExecution
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


# 人工确认默认动作（v2 定案 2026-11-15）：通过 / 驳回——驳回=退回上游
# 重做（非终止；终止走卡片面板「取消执行」）。标签保持 ASCII 语义值，
# 用户文案由前端按 value 用 i18n 映射（DB 内中文标签在 SQL_ASCII 环境
# 会 UntranslatableCharacter）。
DEFAULT_HUMAN_OPTIONS = [
    {"label": "Approve", "value": "approve", "terminal": False},
    {"label": "Reject", "value": "reject", "terminal": True},
]

# 驳回重做反馈前缀：worker 注入端据此识别重做语境（追加「直接输出修订后
# 终稿」纪律）。模块级常量便于测试替换（SQL_ASCII 测试库不接受中文进 JSON）。
REDO_FEEDBACK_PREFIX = "【驳回修改要求】"


def on_human_handoff(*, execution_id: str, event_id: str, member, node_ref: str = "human") -> WorkItemExecution:
    """调用点 3：引擎人工节点 → running→waiting_human + 设人工成员 + 建待审批。

    幂等：已在 waiting_human（事件重投/此前建单失败遗留）时跳过转移但仍
    保证待审批存在——审批建单失败不得静默丢待办。
    """
    ex = _load_active(execution_id)
    # 审批人解析（与审批单 assignee 同源，§7.3）：优先人工节点指定审批人
    from .execution_context import frozen_definition
    node = next((n for n in (frozen_definition(ex).get("nodes") or [])
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
        from .execution_context import frozen_definition
        definition = frozen_definition(execution)
        candidates = [n for n in (definition.get("nodes") or []) if n.get("type") == "human_approval"]
        node = next((n for n in candidates if n.get("key") == node_ref), candidates[0] if candidates else None)
    except Exception:
        node = None
    # 默认选项英文文案（本地测试库 SQL_ASCII 不收非 ASCII JSON；label 由
    # 画布 definition 提供，缺省时前端有 approve/reject 既有文案兜底）
    options = (node or {}).get("options") or DEFAULT_HUMAN_OPTIONS
    # 键名规范化（2026-11-05）：画布序列化历史写 terminate、审批消费端读
    # terminal——键名分叉使所有选项终止性丢失（点「终止」也会继续执行）。
    # 双键兼容读取，落库一律 terminal。
    options = [{
        "label": o.get("label", ""),
        "value": o.get("value"),
        "terminal": bool(o.get("terminal", o.get("terminate", False))),
    } for o in options if isinstance(o, dict) and o.get("label")]
    # 问句 = 画布配置文案 + 需要拍板的内容本身（直接前序步骤的产出，
    # agent 归纳的 markdown 原文）。不逐节点罗列、不加【xx 的输出】
    # 工程化包装——审批人看的是待确认内容，不是执行日志回放
    question = (node or {}).get("message") or ""
    try:
        from .node_runtime import NodeRuntimeRecord
        prior = NodeRuntimeRecord.objects.filter(
            execution=execution, status=NodeRuntimeRecord.Status.SUCCESS,
        ).exclude(node_key=node_ref).order_by("-updated_at").first()
        content = (((prior.result or {}).get("output")) or "").strip() if prior else ""
        if content:
            question = (question + "\n\n" if question else "") + content
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
    from .execution_context import frozen_definition
    definition = frozen_definition(ex)
    human_keys = {n.get("key") for n in (definition.get("nodes") or []) if n.get("type") == "human_approval"}
    # 保留已有 result（通过路径先落的拍板备注/附件 output——下游 prior_outputs
    # 携带），resumedBy 仅补充不覆盖
    for rec in NodeRuntimeRecord.objects.filter(
            execution=ex, node_key__in=human_keys, status=NodeRuntimeRecord.Status.RUNNING):
        rec.status = NodeRuntimeRecord.Status.SUCCESS
        rec.result = {**(rec.result or {}), "resumedBy": event_id}
        rec.save(update_fields=["status", "result"])
    return resumed


def on_human_redo(*, execution_id: str, node_ref: str, feedback: str, event_id: str) -> tuple:
    """人工确认「驳回=重做」（v2 定案 2026-11-15）：修改要求注入上游最近
    AI/条件节点重跑，跑完经 sensor start 重入确认节点（新一轮审批）。

    - 反馈文本（驳回理由 + 附件内容块）落上游节点 human_answer，随
      agent.invoke 幂等命令重派（attempt 单调自增，B1 预算不占）。
      文本带【驳回修改要求】前缀：worker 注入端据此追加「直接输出修订后
      终稿、不复述修改过程」纪律（确认人看到的就是干净新版）。
    - 确认节点记录回 PENDING：sensor 观察到后 POST start 重建审批；
      start 侧有「上游在跑不 handoff」守卫，确保新审批带的是改后产出。
    - 上游无 AI/条件节点（纯人工流程）不可重做——调用方按此先验隐藏按钮。
    - 返回 (execution, target_node_def)：target 供调用方按上游节点 expertId
      解析真正负责重做的员工（回执署名）。
    """
    from .models import NodeRuntimeRecord
    ex = _load_active(execution_id)
    from .execution_context import frozen_definition
    definition = frozen_definition(ex)
    nodes = definition.get("nodes") or []
    edges = definition.get("edges") or []
    # node_ref 的全部上游（传递闭包，edges 方向 source→target）
    ancestors, frontier = set(), {node_ref}
    while frontier:
        frontier = {e.get("source") for e in edges if e.get("target") in frontier}
        ancestors |= frontier
    # 定义序中最近的 AI/条件上游
    target_def = next((n for n in reversed(nodes)
                       if n.get("key") in ancestors and n.get("type") in ("ai", "condition")), None)
    if target_def is None:
        raise TeamDomainError(409, "REDO_NO_UPSTREAM", "No upstream AI node to redo from")
    target = target_def["key"]
    if not feedback.startswith(REDO_FEEDBACK_PREFIX):
        feedback = f"{REDO_FEEDBACK_PREFIX}{feedback}"
    upstream, _ = NodeRuntimeRecord.objects.get_or_create(execution=ex, node_key=target)
    attempt = (upstream.attempt or 0) + 1
    NodeRuntimeRecord.objects.filter(id=upstream.id).update(
        status=NodeRuntimeRecord.Status.RUNNING, attempt=attempt,
        failure_retries=0, human_answer=feedback,
        result={})  # 清旧产出：重跑前 prior 查询不得读到旧版
    # 确认节点回 PENDING（sensor 下一 poke 重建审批）
    NodeRuntimeRecord.objects.filter(execution=ex, node_key=node_ref).exclude(
        status=NodeRuntimeRecord.Status.PENDING
    ).update(status=NodeRuntimeRecord.Status.PENDING)
    payload = {
        "executionId": ex.id, "nodeKey": target,
        "attempt": attempt,
        "humanAnswer": feedback,
    }
    from .tasks import defer_command, execution_lock
    defer_command(
        idempotency_key=f"agent_call:{ex.id}:{target}:{attempt}",
        task_name="orchestration.agent_invoke",
        payload=payload, lock=execution_lock(ex.id))
    # 执行回 running（waiting_human → running；已 running 幂等跳过）
    if ex.business_status == "waiting_human":
        transition_execution(execution=ex, target="running", event_id=event_id)
    else:
        ex.refresh_from_db()
    return ex, target_def


def on_agent_ask(*, execution_id: str, event_id: str, node_ref: str, question: str,
                 options: list | None = None, free_text: bool = True) -> WorkItemExecution:
    """agent 能力化求助（2026-11-05 定案）：AI 节点执行中发现缺数据/有矛盾 →
    running→waiting_human + 建审批单（问题=agent 提问）。

    与 human_handoff 的区别：节点不结束（保持 RUNNING），答复后同节点
    重跑（attempt+1，prompt 注入人工补充）——图上无人工节点、无分支，
    人工介入完全由 agent 运行时发起。幂等同 handoff：已等待时仅保证
    待审批存在。

    options/free_text 为结构化求助（2026-11-13）：模型可给出「通过/驳回」或
    选项按钮（confirm/choice），缺省仍是自由文本（text）。
    """
    ex = _load_active(execution_id)
    if ex.business_status == "waiting_human":
        execution = ex
    else:
        # member 不传（哨兵 _UNSET）：求助等待期间仍是该 agent 在执行，
        # 牌不换（曾传 None 被 §7.3 投影摘掉 bot——卡片负责人凭空消失）
        execution = transition_execution(execution=ex, target="waiting_human", event_id=event_id)
    from .models import BusinessApproval
    if not BusinessApproval.objects.filter(
            execution=execution, node_ref=node_ref,
            result=BusinessApproval.Result.PENDING).exists():
        # 键名规范化与 human_handoff 同：落库一律 terminal；非法项剔除
        opts = [{
            "label": o.get("label", ""),
            "value": o.get("value"),
            "terminal": bool(o.get("terminal", False)),
        } for o in (options or []) if isinstance(o, dict) and o.get("label")]
        BusinessApproval.objects.create(
            execution=execution, node_ref=node_ref,
            question=question[:2000] or "请补充资料",
            options=opts, free_text=bool(free_text), assignee_id=None,
        )
    # 节点级状态同步（2026-11-14）：agent 求助 → 节点置 waiting_human，使
    # Airflow 观察循环把「暂停等人工」与「卡死 running」区分开，避免被
    # execution_timeout 误判重试（WB-4005 双线竞态实证）。
    from .node_runtime import NodeRuntimeRecord
    NodeRuntimeRecord.objects.filter(
        execution=execution, node_key=node_ref,
    ).update(status=NodeRuntimeRecord.Status.WAITING_HUMAN)
    return execution


def on_ask_answered(*, execution_id: str, event_id: str) -> WorkItemExecution:
    """agent 求助已答复：waiting_human→running（节点保持 RUNNING，区别于
    human_resume 的「人工节点收口 success」）。节点重跑由作答端点发
    agent.invoke（attempt+1，payload 带答复）驱动，不在此处。"""
    ex = _load_active(execution_id)
    if ex.business_status != "waiting_human":
        raise TeamDomainError(409, "EXECUTION_RESUME_CONFLICT", "Execution is not waiting for a human")
    # member 不传：agent 求助答复后原 agent 继续执行，牌不换
    return transition_execution(execution=ex, target="running", event_id=event_id)


def cancel_execution(*, execution: WorkItemExecution, event_id: str = "") -> WorkItemExecution:
    """取消执行（非终态）：置 cancelled + 作废待审批 + outbox engine.cancel。

    调用方：手动取消端点、审批驳回/终止选项（等价旧链 reject terminal 语义——
    答复不是恢复执行而是终止它）。
    """
    from .models import BusinessApproval
    if execution.business_status in TERMINAL_STATUSES:
        raise TeamDomainError(409, "EXECUTION_ALREADY_TERMINAL", "Execution already terminal")
    execution.business_status = "cancelled"
    execution.completed_at = dj_tz.now()
    execution.transition_version += 1
    execution.save(update_fields=["business_status", "completed_at", "transition_version", "updated_at"])
    # 状态投影（2026-11-05 修）：取消也要打标——漏掉会让卡停在取消前的状态
    # （如 Waiting Confirmation），看板上成为可自由拖动的「假活跃」脏卡
    from .issue_state_sync import sync_issue_state
    sync_issue_state(issue=execution.issue, business_status="cancelled")
    # 收口在跑节点记录（running→cancelled）：否则叙事流把残留 running
    # 当「当前步」显示呼吸灯（WB-4003 终止后主管批准仍在"执行中"实证）
    from .node_runtime import NodeRuntimeRecord
    execution.node_records.filter(
        status=NodeRuntimeRecord.Status.RUNNING,
    ).update(status=NodeRuntimeRecord.Status.CANCELLED)
    # 作废待审批（收件箱不残留已取消执行的待办）+ 回收未认领挂载附件（C7）
    for stale in execution.approvals.filter(result=BusinessApproval.Result.PENDING):
        stale.result = BusinessApproval.Result.REJECTED
        stale.reason = "执行已取消"
        stale.answered_at = dj_tz.now()
        stale.save(update_fields=["result", "reason", "answered_at"])
        from .execution_context import reclaim_approval_assets
        reclaim_approval_assets(stale)
    payload = {"executionId": execution.id}
    from .tasks import defer_command, execution_lock
    defer_command(
        idempotency_key=f"cancel:{execution.id}",
        task_name="orchestration.engine_cancel",
        payload=payload, lock=execution_lock(execution.id))
    return execution


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
    # 终局统一收口在跑节点记录（running→cancelled）：Airflow sensor 不会立即
    # 感知执行已终局，残留 running 会让叙事流显示"执行中"呼吸灯
    from .node_runtime import NodeRuntimeRecord
    settled.node_records.filter(
        status=NodeRuntimeRecord.Status.RUNNING,
    ).update(status=NodeRuntimeRecord.Status.CANCELLED)
    # C5 补口（2026-11-17）：agent 失败耗尽后由对账收终态的路径不经过
    # DagNodeFailView——失败原因上卡片改在终态收口统一触发（按最近
    # FAILED 节点的 error 文本，幂等标记防重）
    if target == "failed":
        try:
            from .execution_context import comment_failure
            node = settled.node_records.filter(
                status=NodeRuntimeRecord.Status.FAILED).order_by("-updated_at").first()
            if node is not None:
                comment_failure(execution=settled, node_key=node.node_key,
                                result=node.result)
        except Exception:
            pass  # 投影非事实源：静默降级
    from .models import BusinessApproval
    from django.utils import timezone as dj_tz
    # 作废待审批 + 回收其未认领挂载附件（C7：执行终结 ⇔ 无 pending 审批 ⇔ 无残留附件）
    for stale in BusinessApproval.objects.filter(
            execution=settled, result=BusinessApproval.Result.PENDING):
        stale.result = BusinessApproval.Result.REJECTED
        stale.reason = "执行已终结"
        stale.answered_at = dj_tz.now()
        stale.save(update_fields=["result", "reason", "answered_at"])
        from .execution_context import reclaim_approval_assets
        reclaim_approval_assets(stale)
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
    "engine.agent_ask": lambda p: on_agent_ask(**p),
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
        for k in ("engine_run_ref", "member", "engine_status", "question", "options", "freeText"):
            if k in payload:
                kwargs["free_text" if k == "freeText" else k] = payload[k]
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


def start_execution(*, issue, binding, user_id, workflow_version_id: str = "") -> WorkItemExecution:
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
    # 单卡流程覆盖（11-23 确认卡升级）：确认卡选了非绑定流程时按选择执行，
    # 绑定管默认、单卡选择管覆盖；需同项目且已发布（与绑定版本同校验口径）
    if workflow_version_id:
        override = WorkflowVersion.objects.filter(
            id=workflow_version_id,
            workflow__project=binding.project,
            status=WorkflowVersion.Status.PUBLISHED,
        ).first()
        if override is None:
            raise TeamDomainError(400, "WORKFLOW_VERSION_INVALID",
                                  "Selected workflow version not found in project or not published")
        version = override
    if version is None:
        # 两步绑定中间态：已绑团队未挂版本（建卡已被 PROJECT_NOT_BOUND 拦，此处 API 兜底）
        raise TeamDomainError(409, "PROJECT_TEAM_BINDING_NOT_FOUND", "No active binding")
    if version.status != WorkflowVersion.Status.PUBLISHED:
        raise TeamDomainError(409, "WORKFLOW_VERSION_NOT_PUBLISHED", "Workflow version is not published")
    # 成员收敛 §3.2 fail-closed 兜底：名册在绑定后可能漂移（禁用/移除），启动按当前名册复核
    from .services import _validate_version_roster
    _validate_version_roster(version, team)

    frozen = {
        "projectId": str(binding.project_id), "issueId": str(issue.id),
        "teamId": str(team.id), "workflowVersionId": str(version.id),
        "workflowVersionHash": version.content_hash,
        "members": [
            # userId：审批可见性按冻结名册判「团队真人成员」（§3.3）；
            # 存量执行快照缺该字段 → 判定回退当前名册
            {"id": m.id, "kind": m.kind, "agentDefinitionId": m.agent_definition_id,
             "userId": str(m.user_id) if m.user_id else None}
            for m in team.members.filter(enabled=True)
        ],
        "startedBy": str(user_id),
    }
    try:
        with transaction.atomic():
            execution = WorkItemExecution.objects.create(
                issue=issue, binding=binding, frozen_context=frozen,
            )
            # 同事务投递（Procrastinate DjangoConnector 共享 Django 连接）——
            # 执行行与启动命令原子提交，等价旧 outbox 同事务写入语义
            from .tasks import defer_command, execution_lock
            defer_command(
                idempotency_key=f"start:{execution.id}",
                task_name="orchestration.engine_start",
                payload={"executionId": execution.id, "workflowVersionId": str(version.id)},
                lock=execution_lock(execution.id))
            return execution
    except Exception as e:
        if "uniq_nonterminal_execution" in str(e):
            raise TeamDomainError(409, "EXECUTION_CONFLICT", "Issue already has an active execution")
        raise
