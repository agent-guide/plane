# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
from django.apps import AppConfig


class OrchestrationConfig(AppConfig):
    name = "plane.orchestration"

    def ready(self):
        # 建卡自动启动信号（等价旧链事件驱动触发面）
        from . import signals  # noqa: F401
