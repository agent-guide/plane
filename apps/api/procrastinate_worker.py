# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""编排域常驻 worker 入口（v2 部署 systemd plane-v2-worker 的 ExecStart）。

2026-11-16：自研 worker_loop（10s 轮询三循环）退役，改为 Procrastinate
PG 队列消费——命令事件驱动（defer 即 LISTEN/NOTIFY 唤醒，无轮询延迟），
对账走 periodic（分钟级，均为兜底路径），stalled job 由库心跳机制回收。

并发：PROCRASTINATE_WORKER_DEFAULTS（settings），同执行命令经
lock=exec:{id} 串行（等价旧单线程语义），跨执行并行。

看门狗（喂狗=真实进展证明，2026-11-17 修正语义）：
- 事件循环内 liveness 任务每 10s 刷新时间戳——**主循环挂死则时间戳停更**
- 心跳线程只在时间戳新鲜（<60s）时向 systemd 报平安
  → 循环挂死 = 停止喂狗 = systemd WatchdogSec=300 强杀重启（11-11 事故
    的自愈语义保留；此前版本线程无条件喂狗，挂死不自愈——已修）
- 任务线程级挂死由 invoke_agent_node 双超时（240s 空闲/节点预算）兜底，
  不依赖本看门狗
"""
import asyncio
import os
import threading
import time

import django

# 与 manage.py 同默认（production）：服务器 venv 无 debug_toolbar，不能指 local
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "plane.settings.production")
django.setup()

from procrastinate.contrib.django import app  # noqa: E402

from plane.orchestration.sdnotify import sd_notify  # noqa: E402

HEARTBEAT_SECONDS = 20
LOOP_LIVENESS_INTERVAL = 10
LOOP_LIVENESS_MAX_AGE = 60

_loop_alive_at = time.monotonic()
# 持有 liveness 任务引用（asyncio 最佳实践：裸 create_task 可能被 GC）
_liveness_task: asyncio.Task | None = None


async def _loop_liveness() -> None:
    """跑在主事件循环里：循环活着才能刷新时间戳（挂死即停更）。"""
    global _loop_alive_at
    while True:
        _loop_alive_at = time.monotonic()
        await asyncio.sleep(LOOP_LIVENESS_INTERVAL)


def _heartbeat() -> None:
    """独立线程：仅当主循环活性新鲜时喂狗——喂狗即进展证明。"""
    while True:
        if time.monotonic() - _loop_alive_at < LOOP_LIVENESS_MAX_AGE:
            sd_notify("WATCHDOG=1")
        time.sleep(HEARTBEAT_SECONDS)


async def _run() -> None:
    global _liveness_task
    sd_notify("READY=1")
    threading.Thread(target=_heartbeat, name="sd-watchdog", daemon=True).start()
    _liveness_task = asyncio.get_running_loop().create_task(
        _loop_liveness(), name="loop-liveness")
    # 官方 worker 姿势（contrib/django management command 同源）：Django 连接
    # 只适合 defer（同事务）；worker 必须换原生 PsycopgConnector——LISTEN/NOTIFY
    # 支持与 jsonb 反序列化都依赖它（DjangoConnector 两者皆无）。
    # 注意：run_worker_async 不打开 app（同步版才包 open_async）——必须显式开
    with app.replace_connector(app.connector.get_worker_connector()):
        async with app.open_async():
            # 阻塞运行；并发/信号处理取 PROCRASTINATE_WORKER_DEFAULTS 与库默认
            # （SIGTERM 优雅停机：等待运行中任务；超时后 job 留 doing 由
            # retry_stalled periodic 回收——语义见 tasks.py）
            await app.run_worker_async()


def main() -> None:
    print("orchestration worker: procrastinate consumer starting", flush=True)
    asyncio.run(_run())


if __name__ == "__main__":
    main()
