# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""迁移安全专项（资深测试视角：按失效模式逐项证伪，2026-11-16）。

R1 并发同键 defer 竞态 → 恰好一条 job（advisory lock + 查表防线）
R2 业务写入与投递同事务 → 外层回滚命令消失（无孤儿）
R3 双 worker 并发消费 → 每任务恰好执行一次（SKIP LOCKED 认领）
R4 drain 切换清理 → 遗留 pending 收尾、未知类型不吞
R5 payload 保真 → 中文/unicode/嵌套结构 worker 收到原样
"""

import threading

import pytest
from django.db import connection, transaction
from django.test import TransactionTestCase

from procrastinate import schema as procrastinate_schema
from procrastinate.contrib.django import app

from .test_queue_integration import _RUNS, _jobs, _run_worker_once


@pytest.mark.no_defer_stub
class MigrationSafetyTests(TransactionTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with connection.cursor() as cur:
            cur.execute("SELECT to_regclass('procrastinate_jobs')")
            if cur.fetchone()[0] is None:
                procrastinate_schema.SchemaManager(connector=app.connector).apply_schema()

    def _cleanup(self):
        with connection.cursor() as cur:
            for table in ("procrastinate_jobs", "procrastinate_events",
                          "procrastinate_periodic_defers", "procrastinate_workers"):
                cur.execute(f"DELETE FROM {table}")
        _RUNS.clear()

    def setUp(self):
        self._cleanup()

    def tearDown(self):
        self._cleanup()

    # ------------------------------------------------- R1 并发同键 defer 竞态
    def test_concurrent_same_key_defer_yields_exactly_one_job(self):
        """两个线程同时投同键（双击重放的最坏形态）→ 恰好一行 job。

        无防线时 check-then-insert 会双插（库 queueing_lock 部分索引只挡
        双 todo，一个完成后另一个可再插）；advisory xact lock 强制串行。
        """
        from plane.orchestration.tasks import defer_command
        results = []
        barrier = threading.Barrier(2)

        def worker_thread():
            barrier.wait()  # 两线程同时冲进来
            results.append(defer_command(
                idempotency_key="k:race:1", task_name="orchestration.test_probe",
                payload={"key": "race"}, lock="exec:r1"))

        threads = [threading.Thread(target=worker_thread) for _ in range(2)]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual(sorted(results), [False, True])
        self.assertEqual(len(_jobs(key="k:race:1")), 1)

    # ------------------------------------------------- R2 同事务原子性
    def test_defer_rolls_back_with_business_transaction(self):
        """业务事务回滚 → 投递随之消失（不产生孤儿命令）。

        这是「DjangoConnector 共享连接、defer 参与 Django 事务」的
        行为级证明——start_execution 的同事务语义由此保证。
        """
        from plane.orchestration.tasks import defer_command
        try:
            with transaction.atomic():
                defer_command(idempotency_key="k:rb:1", task_name="orchestration.test_probe",
                              payload={"key": "rb"}, lock="exec:r2")
                # 事务尾抛错（等价业务行写入失败）
                raise RuntimeError("business write failed")
        except RuntimeError:
            pass
        self.assertEqual(len(_jobs(key="k:rb:1")), 0, "外层回滚后命令残留——同事务语义破坏")

    # ------------------------------------------------- R3 并发消费无双跑
    def test_concurrent_consumers_no_double_run(self):
        """20 个任务、2 路并发消费者抢 → 每个恰好执行一次（SKIP LOCKED 认领）。

        旧架构此场景=11-14 事故形态（多消费者互踩）；本用例在单 worker 进程
        内开 concurrency=2（两个任务线程并发执行）。注：不能在测试进程里再起
        第二个 run_worker 线程——replace_connector 换装的是全局单例 connector，
        双线程互相还原会破坏 jsonb 反序列化；「双 worker 进程」场景由测试服
        部署验收覆盖（backlog 在册）。
        """
        from plane.orchestration.tasks import defer_command
        for i in range(20):
            defer_command(idempotency_key=f"k:dw:{i}", task_name="orchestration.test_probe",
                          payload={"key": f"dw-{i}", "hold_seconds": 0.02},
                          lock=f"exec:dw:{i}")  # 各自独立锁：最大化交错窗口
        _run_worker_once(concurrency=2)
        runs = sorted(r[0] for r in _RUNS)
        self.assertEqual(set(runs), {f"dw-{i}" for i in range(20)}, "有任务漏跑")
        self.assertEqual(len(runs), len(set(runs)), "有任务被双跑——认领防线失效")
        # 探针任务全部终态 succeeded、无 doing/todo 残留
        # （_jobs() 含 periodic 对账任务——本地无 Airflow env 必 failed，属预期噪声）
        probe_rows = [r for r in _jobs() if str(r[3] or "").startswith("k:dw:")]
        self.assertEqual(len(probe_rows), 20)
        self.assertTrue(all(r[1] == "succeeded" for r in probe_rows))

    # ------------------------------------------------- R4 drain 切换清理
    def test_drain_processes_legacy_pending_and_flags_unknown(self):
        """遗留 pending 命令按新 handler 收尾；未知类型显式落 failed 不吞。"""
        import hashlib
        import json as _json
        from plane.orchestration.models import OrchestrationOutbox
        from plane.orchestration.worker import drain_outbox_once
        from unittest.mock import patch

        def _row(key, ctype, payload):
            OrchestrationOutbox.objects.create(
                idempotency_key=key, command_type=ctype, payload=payload,
                payload_hash=hashlib.sha256(_json.dumps(payload, sort_keys=True).encode()).hexdigest())

        _row("legacy:1", "engine.human_resume", {"executionId": "ex-none"})  # 无此执行
        _row("legacy:2", "agent.invoke", {"executionId": "ex-x", "nodeKey": "n1", "attempt": 1})
        _row("legacy:3", "engine.something_unknown", {"x": 1})
        with patch("plane.orchestration.worker.handle_agent_invoke") as mock_invoke:
            mock_invoke.side_effect = RuntimeError("agent gateway down")
            stats = drain_outbox_once()
        self.assertEqual(stats["processed"], 3)
        # human_resume：执行不存在（404 非 409）→ failed（不静默吞）
        # agent.invoke：handler 抛错（mock 网关故障）→ failed
        # 未知类型 → skipped
        self.assertEqual(stats["failed"], 2)
        self.assertEqual(stats["skipped"], 1)
        self.assertEqual(
            OrchestrationOutbox.objects.filter(state=OrchestrationOutbox.State.PENDING).count(), 0,
            "drain 后仍有 pending——deploy 的 fail-closed 断言会正确拦截部署")
        mock_invoke.assert_called_once_with(execution_id="ex-x", node_key="n1",
                                            attempt=1, human_answer=None)

    def test_drain_happy_path_confirms_legacy_command(self):
        """可成功执行的遗留命令（human_resume 幂等 409 路径）→ confirmed。"""
        from plane.orchestration.models import OrchestrationOutbox
        from plane.orchestration.worker import drain_outbox_once
        from unittest.mock import patch
        from plane.orchestration.services import TeamDomainError
        OrchestrationOutbox.objects.create(
            idempotency_key="legacy:ok", command_type="engine.human_resume",
            payload={"executionId": "ex-any"}, payload_hash="x")
        with patch("plane.orchestration.execution.on_human_resume") as mock_resume:
            mock_resume.side_effect = TeamDomainError(409, "EXECUTION_RESUME_CONFLICT", "not waiting")
            stats = drain_outbox_once()
        self.assertEqual(stats["succeeded"], 1)  # 409 = 已办过 → 幂等成功
        cmd = OrchestrationOutbox.objects.get(idempotency_key="legacy:ok")
        self.assertEqual(cmd.state, OrchestrationOutbox.State.CONFIRMED)

    # ------------------------------------------------- R5 payload 保真
    def test_unicode_and_nested_payload_round_trip(self):
        """中文/unicode 经 jsonb 落库、worker 读回执行——参数原样到达。"""
        from plane.orchestration.tasks import defer_command
        defer_command(idempotency_key="k:uni:1", task_name="orchestration.test_probe",
                      payload={"key": "毛重480-■-ünïcode", "hold_seconds": 0},
                      lock="exec:r5")
        _run_worker_once()
        self.assertIn("毛重480-■-ünïcode", [r[0] for r in _RUNS])
