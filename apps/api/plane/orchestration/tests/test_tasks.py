# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""defer_command 契约单测（2026-11-16 Procrastinate 迁移）：

- 永久幂等：同键已投递（任意状态）不再投递（库 queueing_lock 仅覆盖排队期，
  永久语义由查表补齐——等价旧 outbox 幂等键唯一约束）；
- 参数契约：queueing_lock=幂等键、lock=同执行串行键、payload 原样 kwargs；
- 同键并发串行化（advisory lock 先于查表）。
"""

from django.test import TestCase
from unittest.mock import patch

import pytest

from plane.orchestration import tasks


@pytest.mark.no_defer_stub
class DeferCommandContractTests(TestCase):
    def _defer(self, key="agent_call:ex1:n1:1", exists=False):
        with patch.object(tasks, "command_exists", return_value=exists) as exists_mock, \
             patch.object(tasks, "app") as app_mock, \
             patch.object(tasks, "_xact_advisory_lock") as lock_mock:
            ok = tasks.defer_command(
                idempotency_key=key, task_name="orchestration.agent_invoke",
                payload={"executionId": "ex1", "nodeKey": "n1", "attempt": 1},
                lock="exec:ex1")
        return ok, app_mock, exists_mock, lock_mock

    def test_defer_passes_idempotency_and_lock_through(self):
        ok, app_mock, exists_mock, lock_mock = self._defer()
        self.assertTrue(ok)
        # 同键并发串行化先于查表（check-then-insert 竞态防线）
        lock_mock.assert_called_once_with("agent_call:ex1:n1:1")
        exists_mock.assert_called_once_with("agent_call:ex1:n1:1")
        app_mock.configure_task.assert_called_once_with(
            "orchestration.agent_invoke", queueing_lock="agent_call:ex1:n1:1",
            lock="exec:ex1")
        configure = app_mock.configure_task.return_value
        configure.defer.assert_called_once_with(
            executionId="ex1", nodeKey="n1", attempt=1)

    def test_already_deferred_is_permanently_skipped(self):
        """完成后同键重投（双击重放/网关重试）被永久挡住。"""
        ok, app_mock, _, _ = self._defer(exists=True)
        self.assertFalse(ok)
        app_mock.configure_task.assert_not_called()

    def test_no_lock_omits_lock_call(self):
        with patch.object(tasks, "command_exists", return_value=False), \
             patch.object(tasks, "app") as app_mock, \
             patch.object(tasks, "_xact_advisory_lock"):
            ok = tasks.defer_command(
                idempotency_key="k", task_name="t", payload={})
        self.assertTrue(ok)
        app_mock.configure_task.assert_called_once_with("t", queueing_lock="k", lock=None)
        app_mock.configure_task.return_value.defer.assert_called_once_with()
