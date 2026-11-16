# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""编排域常驻 worker 入口（v2 部署 systemd plane-v2-worker 的 ExecStart）。

2026-11-16：自研 worker_loop（10s 轮询三循环）退役，改为 Procrastinate
PG 队列消费——命令事件驱动（defer 即 LISTEN/NOTIFY 唤醒，无轮询延迟），
对账走 periodic（分钟级，均为兜底路径），stalled job 由库心跳机制回收。

并发：PROCRASTINATE_WORKER_DEFAULTS（settings），同执行命令经
lock=exec:{id} 串行（等价旧单线程语义），跨执行并行。

看门狗：systemd Type=notify 语义保留——本入口 READY + 心跳线程双路喂狗
（长 agent turn 期间由 invoke_agent_node 的 SSE 事件级喂狗接力，
worker.py 内置），任意挂死由 systemd 强杀重启（11-11 事故语义不变）。
"""
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


def _heartbeat() -> None:
    while True:
        sd_notify("WATCHDOG=1")
        time.sleep(HEARTBEAT_SECONDS)


def main() -> None:
    print("orchestration worker: procrastinate consumer starting", flush=True)
    sd_notify("READY=1")
    threading.Thread(target=_heartbeat, name="sd-watchdog", daemon=True).start()
    # 官方 worker 姿势（contrib/django management command 同源）：Django 连接
    # 只适合 defer（同事务）；worker 必须换原生 PsycopgConnector——LISTEN/NOTIFY
    # 支持与 jsonb 反序列化都依赖它（DjangoConnector 两者皆无）
    with app.replace_connector(app.connector.get_worker_connector()):
        # 阻塞运行；并发/信号处理取 PROCRASTINATE_WORKER_DEFAULTS 与库默认
        # （SIGTERM 优雅停机：等待运行中任务；超时后 job 留 doing 由
        # retry_stalled periodic 回收——语义见 tasks.py）
        app.run_worker()


if __name__ == "__main__":
    main()
