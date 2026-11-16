# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""orchestration 套件密封：清引擎/目录 env——测试永远走无引擎路径，
不依赖（也不写脏）本地真实 Airflow/DAG 目录。"""

import os

_BLACKLIST = [
    "ORCHESTRATION_AIRFLOW_BASE_URL", "ORCHESTRATION_AIRFLOW_TOKEN",
    "ORCHESTRATION_DAG_ROOT", "ORCHESTRATION_INTERNAL_BASE_URL",
    "ORCHESTRATION_INTERNAL_TOKEN",
    "AGWMNGR_BASE_URL", "AGWMNGR_TENANT_TOKEN", "AGWMNGR_TENANT_ID",
]


def pytest_configure():
    for key in _BLACKLIST:
        os.environ.pop(key, None)


import pytest  # noqa: E402

# 投递记录注册表（fake_defer 写入，每测清空）——TestCase 方法不能接
# fixture 返回值，断言方直接 `from .conftest import DEFERRED`
DEFERRED: dict = {}


@pytest.fixture(autouse=True)
def _stub_command_defer(request, monkeypatch):
    """defer_command/command_exists 打桩（全套件 autouse）。

    Procrastinate 的 defer 依赖其 SQL 函数/枚举（由库迁移落库），本套件
    --nomigrations 建库没有——测试不真投递，改为内存记录器：投递语义
    （永久幂等/参数契约）由 test_tasks.py 单独覆盖（标 no_defer_stub 跳桩），
    真机链路由部署验收。API/视图层测试通过 DEFERRED 断言「命令已投递」
    与 attempt 判据，语义不变（等价旧查 OrchestrationOutbox 表）。
    """
    import plane.orchestration.tasks as tasks
    DEFERRED.clear()
    if request.node.get_closest_marker("no_defer_stub"):
        yield
        return

    def fake_defer(*, idempotency_key, task_name, payload, lock=None):
        if idempotency_key in DEFERRED:  # 永久幂等（等价旧唯一键 get_or_create）
            return False
        DEFERRED[idempotency_key] = (task_name, payload, lock)
        return True

    def fake_exists(key):
        return key in DEFERRED

    monkeypatch.setattr(tasks, "defer_command", fake_defer)
    monkeypatch.setattr(tasks, "command_exists", fake_exists)
    yield
