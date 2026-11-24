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
        WAITING_HUMAN = "waiting_human", "Waiting Human"
        SUCCESS = "success", "Success"
        FAILED = "failed", "Failed"
        # 尝试失败但重试额度未尽（11-24）：Airflow up_for_retry 同语义——
        # 引擎侧仍可重试的中间态；FAILED 从此只表终态失败（重试耗尽）
        RETRYING = "retrying", "Retrying"
        CANCELLED = "cancelled", "Cancelled"
        SKIPPED = "skipped", "Skipped"

    execution = models.ForeignKey(
        "orchestration.WorkItemExecution", on_delete=models.CASCADE, related_name="node_records")
    node_key = models.CharField(max_length=200)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    attempt = models.PositiveIntegerField(default=1)
    # 失败重派专用预算（B1，2026-11-14）：attempt 是总运行序号（幂等键/线程
    # 保鲜用），重试上限只看 failure_retries——「提问→答复」重跑不占失败
    # 预算、无限次；人工答复到达视为新一轮，failure_retries 清零。
    failure_retries = models.PositiveIntegerField(default=0)
    # 最近一次人工答复（含附件解析文本）：失败重派随行携带，防「答复后偶发
    # 空回复→自动重派把用户答复丢了」。
    human_answer = models.TextField(blank=True, default="")
    last_event_id = models.CharField(max_length=250, default="")
    result = models.JSONField(default=dict, blank=True)
    # 工作过程留痕（11-24 定案：执行不黑盒）：agent turn 内工具调用/生成段
    # 的起止与耗时，只追加。worker 边执行边写（节流+上限+写失败不影响执行），
    # 完成后永久保留——用户完整知道做了什么、时间花在哪。
    # 条目：{"t": epoch_ms, "k": "tool"|"gen", "s": "start"|"end", "name": str, "ms": int}
    trace = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["execution", "node_key"], name="uniq_node_record_per_execution"),
        ]

    def view(self) -> dict:
        normalized_error = (self.result or {}).get("error_normalized") or {}
        return {
            # 引擎协议兼容（11-24）：已部署的 DAG 传感器只认 failed——
            # RETRYING 对引擎映射回 failed，重试行为与旧版完全一致，
            # 无需重发布流程；用户面走时间线（RETRYING 显示为执行中）
            "status": "failed" if self.status == self.Status.RETRYING else self.status,
            "error": self.result.get("error"),
            "errorCode": normalized_error.get("code"),
            "errorDetail": normalized_error.get("detail"),
            "nodeKey": self.node_key,
            "trace": self.trace or [],
        }
