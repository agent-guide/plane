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
