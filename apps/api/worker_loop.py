# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""编排域常驻 worker（v2 部署 systemd plane-v2-worker 的 ExecStart）。

10s 轮询三个入口（均幂等，单轮失败不中断）：
  process_outbox_once        outbox 消费（engine.start / agent.invoke / human_resume 转投）
  reconcile_publishing_once  发布中版本对 Airflow 上传/轮询收口
  reconcile_runs_once        补启动 + 活跃执行终态对账

历史：曾为服务器侧手工文件（11-02 部署时放置），未入仓库导致部署替换时被删
（2026-11-03 事故）；现入仓随包发布。
"""
import os
import time
from pathlib import Path

import django

# 与 manage.py 同默认（production）：服务器 venv 无 debug_toolbar，不能指 local
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "plane.settings.production")
django.setup()

from plane.orchestration.sdnotify import sd_notify  # noqa: E402
from plane.orchestration.worker import (  # noqa: E402
    process_outbox_once,
    reconcile_publishing_once,
    reconcile_runs_once,
)

INTERVAL_SECONDS = 10
DAG_ROOT = Path(os.environ.get("ORCHESTRATION_DAG_ROOT", "/tmp/agent-team-dags"))


def main() -> None:
    print(f"worker_loop: interval={INTERVAL_SECONDS}s dag_root={DAG_ROOT}", flush=True)
    sd_notify("READY=1")
    last_watchdog = 0.0
    while True:
        # 已知遗留：单轮异常静默（发布卡 publishing 时零日志）——改进项见 backlog
        try:
            stats = process_outbox_once(dag_root=DAG_ROOT)
            if stats:
                print(f"outbox: {stats}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"outbox round failed: {exc}", flush=True)
        try:
            reconcile_publishing_once()
        except Exception as exc:  # noqa: BLE001
            print(f"publish reconcile failed: {exc}", flush=True)
        try:
            reconcile_runs_once()
        except Exception as exc:  # noqa: BLE001
            print(f"run reconcile failed: {exc}", flush=True)
        # 轮询末尾报平安兜底（长 agent turn 期间由 SSE 事件级喂狗，
        # 见 worker.invoke_agent_node）——两路合力的看门狗语义。
        now = time.monotonic()
        if now - last_watchdog >= 20:
            sd_notify("WATCHDOG=1")
            last_watchdog = now
        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
