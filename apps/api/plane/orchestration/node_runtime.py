# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""DAG 运行时回调端点（worker 切片）——生成 DAG 执行期调用的节点协议。

协议（与旧 /internal/workflow-runs 等价，语义归并到编排域模型）：
- GET  node/{key}        → 观察节点状态（sensor 每次 poke）
- POST node/{key}/start  → 节点启动（AI 节点→outbox agent 调用命令；人工节点→建审批）
- POST node/{key}/finish → 节点成功（含条件跳过 skipped）
- POST node/{key}/fail   → 节点失败上报

节点级状态以 NodeRuntimeRecord 承载（幂等锚 event_id），执行级状态机经
process_event 驱动。agent 实际分发（调 agwmngr 部署）为 outbox 命令，
由 worker 消费执行——本模块不直接触碰网关。
"""

from django.db import models
from django.utils import timezone


class NodeRuntimeRecord(models.Model):
    """单节点执行记录（run_ref + node_key 唯一；状态含 skipped 条件剪枝）。"""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        RUNNING = "running", "Running"
        SUCCESS = "success", "Success"
        FAILED = "failed", "Failed"
        CANCELLED = "cancelled", "Cancelled"
        SKIPPED = "skipped", "Skipped"

    execution = models.ForeignKey(
        "orchestration.WorkItemExecution", on_delete=models.CASCADE, related_name="node_records")
    node_key = models.CharField(max_length=200)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    attempt = models.PositiveIntegerField(default=1)
    last_event_id = models.CharField(max_length=250, default="")
    result = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["execution", "node_key"], name="uniq_node_record_per_execution"),
        ]

    def view(self) -> dict:
        return {"status": self.status, "error": self.result.get("error"), "nodeKey": self.node_key}
