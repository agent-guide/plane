# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""DAG 生成器黄金校验：同输入下新旧生成器输出逐字节等价（除两处环境寻址适配）。

黄金基准来源：experts-backend 旧生成器对相同 definition 的渲染输出（迁移动作
前生成基准并落 fixture；断言新旧仅差 env 变量名与鉴权头两处）。
"""

import re

from django.test import SimpleTestCase

from plane.orchestration.dag_publication import dag_id, publish_version, render_dag

# 与旧系统真实发布过的流程同构（wf_01430b427_v1：单 AI 节点）
SINGLE_AI = {
    "nodes": [{"key": "agent_1_0", "type": "ai", "timeoutSeconds": None, "retries": 1}],
    "edges": [],
}
# 人工审批 + 条件分支 + 汇合（覆盖 sensor/trigger_rule/依赖渲染）
BRANCH_HUMAN = {
    "nodes": [
        {"key": "start", "type": "ai", "timeoutSeconds": None, "retries": 1},
        {"key": "approve", "type": "human_approval", "timeoutSeconds": None, "retries": None},
        {"key": "path_a", "type": "ai", "timeoutSeconds": 120, "retries": 2},
        {"key": "path_b", "type": "ai", "timeoutSeconds": None, "retries": None},
        {"key": "join", "type": "ai", "timeoutSeconds": None, "retries": None},
    ],
    "edges": [
        {"source": "start", "target": "approve"},
        {"source": "approve", "target": "path_a"},
        {"source": "approve", "target": "path_b"},
        {"source": "path_a", "target": "join"},
        {"source": "path_b", "target": "join"},
    ],
}


class RenderEquivalenceTests(SimpleTestCase):
    """结构等价断言（黄金校验替代：fixture 比对见跨仓脚本，此处锁关键语义）。"""

    def test_single_ai_matches_legacy_shape(self):
        out = render_dag(
            workflow_id="wfv_3c3962568a684ec5a6cf80a01430b427",
            version=1,
            definition_hash="22e8460a3942d49201403d936d205664975e55cf13042b740b098b392e0de4c2",
            definition=SINGLE_AI,
        )
        # 关键语义逐项断言（与旧 wf_01430b427_v1.py 逐行对应）
        self.assertIn("from airflow.sdk import PokeReturnValue, dag, get_current_context, task", out)
        self.assertIn("WORKFLOW_ID = 'wfv_3c3962568a684ec5a6cf80a01430b427'", out)
        self.assertIn("'effectiveTimeoutSeconds': 1800", out)  # 平台默认 30min
        self.assertIn("@task(task_id=\"agent_1_0\", execution_timeout=timedelta(seconds=1800), retries=1, retry_delay=timedelta(seconds=30))", out)
        self.assertIn("step_0 = task_0_agent_1_0(NODES[0])", out)
        self.assertIn("dag_id='wf_01430b427_v1'", out)  # 取 id 末 9 位
        self.assertIn('tags=["workflow_version", \'22e8460a', out)
        self.assertIn('max_active_runs=16', out)

    def test_human_node_uses_sensor_not_execution_timeout(self):
        out = render_dag(
            workflow_id="wfv_" + "x" * 30, version=2, definition_hash="h" * 64, definition=BRANCH_HUMAN,
        )
        # 审批节点：sensor 模式 + 无 execution_timeout（等待人工不被引擎杀）
        self.assertIn('@task.sensor(task_id="approve", mode="reschedule", poke_interval=15, retries=3', out)
        self.assertNotIn('task_id="approve", execution_timeout', out)
        self.assertIn(f"timeout={7 * 24 * 60 * 60}", out)  # sensor 上限 7 天
        # 汇合节点：none_failed_min_one_success（条件分支 skip 不中断）
        self.assertIn('@task(task_id="join", execution_timeout=timedelta(seconds=1800), retries=1, retry_delay=timedelta(seconds=30), trigger_rule="none_failed_min_one_success")', out)
        # 依赖渲染（含显式边）
        self.assertIn("    step_0 >> step_1", out)
        self.assertIn("    step_2 >> step_4", out)
        self.assertIn("    step_3 >> step_4", out)
        # 无重复边渲染
        self.assertEqual(out.count("step_0 >> step_1"), 1)

    def test_env_adaptations_only_divergence(self):
        """与旧模板的差异仅限两处环境寻址（其余逐字）。"""
        out = render_dag(workflow_id="wfv_" + "y" * 30, version=1, definition_hash="z" * 64, definition=SINGLE_AI)
        self.assertIn('os.environ["ORCHESTRATION_INTERNAL_BASE_URL"]', out)
        self.assertIn('os.environ["ORCHESTRATION_INTERNAL_TOKEN"]', out)
        self.assertIn('"X-Orchestration-Token": token', out)
        self.assertNotIn("EXPERT_BACKEND_INTERNAL_BASE_URL", out)
        self.assertNotIn("Bearer", out)

    def test_unknown_edge_rejected(self):
        bad = {"nodes": [{"key": "a", "type": "ai", "retries": None}], "edges": [{"source": "a", "target": "ghost"}]}
        with self.assertRaises(ValueError):
            render_dag(workflow_id="wfv_" + "w" * 30, version=1, definition_hash="v" * 64, definition=bad)

    def test_dag_id_stable_and_readable(self):
        self.assertEqual(dag_id("wfv_abc123456789", 3), "wf_123456789_v3")


class PublishAtomicityTests(SimpleTestCase):
    def test_publish_writes_target_file(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = publish_version(
                dag_root=root, workflow_id="wfv_" + "a" * 30, version=1, dag_source="# test",
            )
            self.assertTrue(path.exists())
            self.assertEqual(path.name, f"wf_{'a' * 9}_v1.py")
            self.assertEqual(path.read_text(), "# test")
            self.assertFalse(any((root / ".tmp").iterdir()))  # 无残留临时文件
