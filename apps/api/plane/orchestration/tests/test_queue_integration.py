# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""真队列集成测试（2026-11-16 Procrastinate 迁移的核心验收）。

与单测的区别：不走 conftest 的 defer 桩——**真 schema、真 defer SQL、真
worker 消费**，覆盖四件事：

1. 真 defer：job 落 procrastinate_jobs（queueing_lock/lock 传参正确）；
   永久幂等（同键重投不产生第二行）；
2. 端到端：defer → worker(wait=False) → 任务真执行 → job succeeded；
3. 并发语义：同 lock 串行（时间区间不重叠）、不同 lock 并行；
4. 崩溃恢复：伪造心跳过期的 worker + doing job → retry_stalled 重回 todo。

为什么用 TransactionTestCase：worker 的任务跑在独立线程（另一条 Django
连接），TestCase 的未提交事务对它不可见——必须真提交。
"""

import time

import pytest
from django.db import connection
from django.test import TransactionTestCase

from procrastinate import schema as procrastinate_schema
from procrastinate.contrib.django import app

# ---------------------------------------------------------------- 探针任务
# 注册在全局 Django app 上（仅测试进程导入本模块时存在；worker 子进程不导
# 入，但本文件的 worker 用例全部进程内 run_worker，同一 app 对象可见）

_RUNS: list = []  # (key, start, end) 记录器


@app.task(name="orchestration.test_probe")
def probe_task(key: str, hold_seconds: float = 0.0) -> None:
    _start = time.monotonic()
    if hold_seconds:
        time.sleep(hold_seconds)
    _RUNS.append((key, _start, time.monotonic()))


def _jobs(lock: str | None = None, key: str | None = None):
    q = "SELECT id, status, lock, queueing_lock, args FROM procrastinate_jobs"
    cond, params = [], []
    if lock:
        cond.append("lock = %s"); params.append(lock)
    if key:
        cond.append("queueing_lock = %s"); params.append(key)
    if cond:
        q += " WHERE " + " AND ".join(cond)
    with connection.cursor() as cur:
        cur.execute(q + " ORDER BY id", params)
        return cur.fetchall()


def _run_worker_once(**overrides):
    """跑一轮 worker：处理完队列即退出（wait=False），不装信号处理器。

    必须复刻入口的 connector 换装（DjangoConnector 无 LISTEN/NOTIFY 且 jsonb
    读回为 str——与生产 procrastinate_worker.py 同源姿势）。
    """
    opts = {"wait": False, "concurrency": 2, "install_signal_handlers": False,
            "listen_notify": False}
    opts.update(overrides)
    with app.replace_connector(app.connector.get_worker_connector()):
        app.run_worker(**opts)


@pytest.mark.no_defer_stub
class RealQueueIntegrationTests(TransactionTestCase):
    """真 schema + 真 defer + 真 worker（每类一次 schema 落库 + 表清理）。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # apply_schema 非幂等（enum 重复创建报错）——--reuse-db 残留时跳过
        with connection.cursor() as cur:
            cur.execute("SELECT to_regclass('procrastinate_jobs')")
            if cur.fetchone()[0] is not None:
                return
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

    # ------------------------------------------------------------ 1. 真 defer
    def test_real_defer_persists_with_keys_and_permanent_dedupe(self):
        from plane.orchestration.tasks import defer_command
        ok = defer_command(idempotency_key="k:probe:1", task_name="orchestration.test_probe",
                           payload={"key": "p1"}, lock="exec:e1")
        self.assertTrue(ok)
        rows = _jobs(key="k:probe:1")
        self.assertEqual(len(rows), 1)
        _id, status, lock, qlock, args = rows[0]
        self.assertEqual(status, "todo")
        self.assertEqual(lock, "exec:e1")
        self.assertEqual(qlock, "k:probe:1")
        import json as _json
        self.assertEqual(_json.loads(args), {"key": "p1"})
        # 同键重投（完成后/任意时刻）被永久挡住
        again = defer_command(idempotency_key="k:probe:1", task_name="orchestration.test_probe",
                              payload={"key": "p1"}, lock="exec:e1")
        self.assertFalse(again)
        self.assertEqual(len(_jobs(key="k:probe:1")), 1)

    # ------------------------------------------------------------ 2. 端到端
    def test_worker_consumes_and_succeeds_end_to_end(self):
        from plane.orchestration.tasks import defer_command
        defer_command(idempotency_key="k:e2e:1", task_name="orchestration.test_probe",
                      payload={"key": "e2e"}, lock="exec:e2e")
        _run_worker_once()
        self.assertEqual([r[0] for r in _RUNS], ["e2e"])
        rows = _jobs(key="k:e2e:1")
        self.assertEqual(rows[0][1], "succeeded")

    def test_failed_task_marks_job_failed_without_retry(self):
        """handler 抛错 → job failed、不重试（重试权威归引擎线的等价语义）。"""

        @app.task(name="orchestration.test_boom")
        def boom():  # pragma: no cover - 故意失败
            raise RuntimeError("boom")

        from plane.orchestration.tasks import defer_command
        defer_command(idempotency_key="k:boom:1", task_name="orchestration.test_boom",
                      payload={}, lock="exec:e3")
        _run_worker_once()
        self.assertEqual(_jobs(key="k:boom:1")[0][1], "failed")

    # ------------------------------------------------------------ 3. 并发语义
    def test_same_lock_serializes_and_distinct_locks_parallelize(self):
        from plane.orchestration.tasks import defer_command
        # 同 lock 两个 0.5s 任务 + 不同 lock 两个 0.5s 任务，concurrency=2
        for key, lock in [("same-a", "exec:same"), ("same-b", "exec:same"),
                          ("par-a", "exec:pa"), ("par-b", "exec:pb")]:
            defer_command(idempotency_key=f"k:conc:{key}", task_name="orchestration.test_probe",
                          payload={"key": key, "hold_seconds": 0.5}, lock=lock)
        _run_worker_once(concurrency=2)
        self.assertEqual(sorted(r[0] for r in _RUNS), ["par-a", "par-b", "same-a", "same-b"])

        def overlaps(a, b):
            return a[1] < b[2] and b[1] < a[2]

        runs = {r[0]: (r[1], r[2]) for r in _RUNS}
        # 同执行（lock=exec:same）：两个任务时间区间不得重叠
        self.assertFalse(overlaps(("x", *runs["same-a"]), ("x", *runs["same-b"])),
                         "同 lock 任务发生了并发重叠——串行语义被破坏")
        # 跨执行：两组应有并行（同一时刻两个任务在跑）
        parallel_seen = any(
            overlaps(("x", *runs[a]), ("x", *runs[b]))
            for a in ("same-a", "same-b") for b in ("par-a", "par-b"))
        self.assertTrue(parallel_seen, "不同 lock 未并行——并发度未生效")

    # ------------------------------------------------------------ 4. 崩溃恢复
    def test_stalled_doing_job_is_retried(self):
        """kill -9 残留：worker 心跳过期 + job 卡 doing → retry_stalled 拉回 todo。"""
        import datetime as dt
        import types as _types
        from django.utils import timezone
        from plane.orchestration.tasks import retry_stalled_task
        stale = timezone.now() - dt.timedelta(minutes=30)
        with connection.cursor() as cur:
            cur.execute(
                "INSERT INTO procrastinate_workers (last_heartbeat) VALUES (%s) RETURNING id",
                [stale])
            worker_id = cur.fetchone()[0]
            cur.execute(
                """INSERT INTO procrastinate_jobs (queue_name, task_name, lock, queueing_lock,
                     args, status, attempts, worker_id)
                   VALUES ('default', 'orchestration.test_probe', 'exec:dead', 'k:dead:1',
                           '{"key": "dead"}'::jsonb, 'doing', 0, %s) RETURNING id""",
                [worker_id])
        # pass_context 真实形态是 JobContext 对象（取 .app）——SimpleNamespace 等价
        retry_stalled_task(context=_types.SimpleNamespace(app=app), timestamp=0)
        rows = _jobs(key="k:dead:1")
        self.assertEqual(rows[0][1], "todo", "stalled job 未被拉回 todo")
        # 拉回后可被正常消费
        _run_worker_once()
        self.assertEqual([r[0] for r in _RUNS], ["dead"])
