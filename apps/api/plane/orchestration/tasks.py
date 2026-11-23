# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""编排域命令的消费任务（Procrastinate，2026-11-16 替换自研 outbox 轮询）。

架构（对齐事务性发件箱 + PG 队列业界标准）：
- 业务写入与任务投递**同一 Django 事务**（DjangoConnector 共享 default 连接，
  源码实证）——dual-write 漂移从机制上消除；
- `lock=exec:{executionId}`：同执行命令串行（等价旧单线程语义），跨执行并行
  （worker concurrency=4）——单卡长任务不再冻住全局（11-11 事故根治）；
- `queueing_lock`：排队期去重（库唯一部分索引）；**永久去重**由 defer_command
  的查表 + 事务级 advisory lock 兜住（等价旧 outbox 幂等键唯一约束）；
- worker 心跳 + stalled 回收（retry_stalled periodic）——kill -9 残留 job
  由库机制复活，不再依赖「只能起一个 worker」的人为约定（11-14 事故根治）。

旧 OrchestrationOutbox 表保留只读（回滚锚点），停写；切换清理由
drain_outbox_once()（worker.py）一次性收尾。
"""
from __future__ import annotations

import asyncio

from django.db import connection, transaction
from procrastinate.contrib.django import app

# 永久幂等查表/判存共用表名（库自有表，行完成后仍保留，可查）
_JOBS_TABLE = "procrastinate_jobs"


def _xact_advisory_lock(key: str) -> None:
    """同键并发 defer 串行化（事务级，提交即释放）——check-then-insert
    竞态窗口的唯一防线（双击重放/网关重试并发同键）。"""
    with connection.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s)::bigint)", [key])


def command_exists(idempotency_key: str) -> bool:
    """该幂等键的命令是否已投递过（任意状态）——等价旧 outbox
    `_key_exists`（DagNodeStartView 的 attempt 自增判据）。"""
    with connection.cursor() as cur:
        cur.execute(
            f"SELECT 1 FROM {_JOBS_TABLE} WHERE queueing_lock = %s LIMIT 1",
            [idempotency_key],
        )
        return cur.fetchone() is not None


def defer_command(*, idempotency_key: str, task_name: str, payload: dict,
                  lock: str | None = None) -> bool:
    """永久幂等投递：同键已投递过（任意状态）则跳过。

    等价旧 `OrchestrationOutbox.get_or_create(idempotency_key=...)`——库的
    queueing_lock 只在排队期（status='todo'）去重，完成后同键可再插，故由
    本函数补齐永久语义：事务内 advisory lock 串行 → 查表 → defer。
    必须在业务写入的同一事务内调用（嵌套 savepoint，随外层提交/回滚）。
    """
    with transaction.atomic():
        _xact_advisory_lock(idempotency_key)
        if command_exists(idempotency_key):
            return False
        app.configure_task(task_name, queueing_lock=idempotency_key,
                           lock=lock).defer(**payload)
        return True


def execution_lock(execution_id: str) -> str:
    """同执行串行锁键（跨执行并行）。"""
    return f"exec:{execution_id}"


# ---------------------------------------------------------------- 任务定义
# handler 逻辑在 worker.py（纯函数可直接单测，测试风格与旧 process_outbox_once
# 一致）；此处仅做注册与参数传递。任务一律不配置库级重试——重试权威唯一归
# Airflow RetryPolicy（2026-11-06 定案），agent.invoke 失败落节点记录由引擎
# 重试线接管。


@app.task(name="orchestration.engine_start")
def engine_start_task(executionId: str, workflowVersionId: str) -> None:
    from .worker import handle_engine_start
    try:
        handle_engine_start(execution_id=executionId, workflow_version_id=workflowVersionId)
    except Exception as exc:
        # 启动失败必须上浮（11-23 实证：此前失败只落 job 状态，执行永远
        # 「排队中」，用户无从得知）。终态化 + 失败原因回写卡片评论，
        # 面板/列表立即显示失败可重试；随后照常抛出保 job 可观测。
        from .execution import on_engine_terminal
        from .execution_context import comment_failure
        from .models import WorkItemExecution
        try:
            execution = WorkItemExecution.objects.filter(id=executionId).exclude(
                business_status__in=("failed", "completed", "cancelled")).first()
            if execution is not None:
                comment_failure(execution=execution, node_key="engine_start",
                                result={"error": f"启动失败：{exc}"})
                on_engine_terminal(execution_id=executionId,
                                   event_id=f"engine-start-fail:{executionId}",
                                   engine_status="failed")
        except Exception:
            pass  # 上浮路径自身失败不吞原始异常
        raise


@app.task(name="orchestration.agent_invoke")
def agent_invoke_task(executionId: str, nodeKey: str, attempt: int = 1,
                      humanAnswer: str | None = None) -> None:
    from .worker import handle_agent_invoke
    handle_agent_invoke(execution_id=executionId, node_key=nodeKey,
                        attempt=attempt, human_answer=humanAnswer)


@app.task(name="orchestration.engine_cancel")
def engine_cancel_task(executionId: str) -> None:
    from .worker import handle_engine_cancel
    handle_engine_cancel(execution_id=executionId)


@app.task(name="orchestration.human_resume")
def human_resume_task(executionId: str, approvalId: str | None = None) -> None:
    from .worker import handle_human_resume
    handle_human_resume(execution_id=executionId, approval_id=approvalId)


# ---------------------------------------------------------------- periodic
# 旧 worker_loop 三循环之二（对账）+ stalled 回收，粒度：库 periodic 走 cron
# 分钟级；对账均为兜底路径（事件链是主路径），publishing 面对的 DAG 扫描
# 本身 ~11 分钟级，分钟粒度无损。


@app.periodic(cron="* * * * *")
@app.task(name="orchestration.reconcile_publishing", pass_context=True)
def reconcile_publishing_task(context, timestamp: int) -> None:  # pragma: no cover - 线程侧
    from .worker import reconcile_publishing_once
    reconcile_publishing_once()


@app.periodic(cron="* * * * *")
@app.task(name="orchestration.reconcile_runs", pass_context=True)
def reconcile_runs_task(context, timestamp: int) -> None:  # pragma: no cover - 线程侧
    from .worker import reconcile_runs_once
    reconcile_runs_once()


@app.periodic(cron="*/10 * * * *")
@app.task(name="orchestration.retry_stalled", pass_context=True)
def retry_stalled_task(context, timestamp: int) -> None:
    """库文档标准姿势：捞心跳停止的 worker 遗留的 doing job 并重排队。

    kill -9/机器重启后 job 卡 doing——不配本任务等于换个地方复现「挂死
    永不恢复」。同步任务跑在 worker 线程里，这里用独立事件循环调异步 API
    （pass_context 传 JobContext 对象，取 .app）。
    """
    job_manager = context.app.job_manager

    async def _retry_stalled() -> int:
        stalled = await job_manager.get_stalled_jobs()
        for job in stalled:
            await job_manager.retry_job(job=job)
        return len(stalled)

    asyncio.run(_retry_stalled())
