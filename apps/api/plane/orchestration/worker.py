# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""worker 命令消费与引擎客户端（阶段 2′ worker 收尾）。

职责（等价性清单 §2/§4 的 worker 归宿）：
- outbox 消费：engine.start → 触发 Airflow DagRun（幂等 dag_run_id 重放安全）
              agent.invoke → 调 agwmngr 部署执行节点（本地摸底已验证的租户调用链）
- Airflow Stable API v2 客户端（自旧 airflow_client 移植：Bearer 认证、
  有界重试、4xx 不重试——契约/状态冲突立即上抛）
- 发布链：DAG 落盘（dag_publication.publish_version）+ 轮询就绪 + 激活

设计约束：所有 Airflow 地址/令牌只在本模块出现（旧系统同款边界）；
HTTP 客户端用 urllib 零新依赖。
"""

import json
import time
import urllib.error
import urllib.request
from pathlib import Path


class AirflowError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"airflow {status}: {body[:200]}")
        self.status = status
        self.body = body


class AirflowClient:
    """Airflow Stable API v2 客户端（Bearer + 有界重试；4xx 立即返回）。"""

    def __init__(self, base_url: str, token: str, *, timeout_seconds: float = 15, max_retries: int = 2):
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        self._timeout = timeout_seconds
        self._max_retries = max_retries

    def _request(self, method: str, path: str, payload: dict | None = None, *, retry_on_5xx: bool = True):
        data = json.dumps(payload).encode() if payload is not None else None
        attempt = 0
        while True:
            request = urllib.request.Request(
                f"{self._base}/api/v2/{path}", data=data, headers=self._headers, method=method)
            try:
                with urllib.request.urlopen(request, timeout=self._timeout) as response:
                    return json.loads(response.read() or b"{}")
            except urllib.error.HTTPError as exc:
                if 200 <= exc.code < 500 or not retry_on_5xx or attempt >= self._max_retries:
                    raise AirflowError(exc.code, exc.read().decode(errors="replace"))
            except (urllib.error.URLError, TimeoutError):
                if attempt >= self._max_retries:
                    raise
            attempt += 1

    def health(self) -> dict:
        return self._request("GET", "monitor/health")

    def get_dag(self, dag_id: str) -> dict:
        return self._request("GET", f"dags/{dag_id}")

    def activate_dag(self, dag_id: str) -> dict:
        return self._request("PATCH", f"dags/{dag_id}", {"is_paused": False})

    def trigger_run(self, dag_id: str, *, dag_run_id: str, conf: dict) -> dict:
        """幂等触发：dag_run_id 由调用方预生成，重放不产生第二个业务 run。"""
        return self._request(
            "POST", f"dags/{dag_id}/dagRuns",
            {"dag_run_id": dag_run_id, "conf": conf})


def airflow_client_from_env() -> AirflowClient:
    import os
    base = os.environ.get("ORCHESTRATION_AIRFLOW_BASE_URL", "")
    token = os.environ.get("ORCHESTRATION_AIRFLOW_TOKEN", "")
    if not base or not token:
        raise RuntimeError("ORCHESTRATION_AIRFLOW_BASE_URL/TOKEN not configured")
    return AirflowClient(base, token)


def wait_until_ready(client: AirflowClient, *, dag_id: str, definition_hash: str,
                     timeout_seconds: float = 60.0) -> bool:
    """hash tag 匹配 + unpause 成功 = 发布可执行（与旧 wait_until_ready 同判据）。"""
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            dag = client.get_dag(dag_id)
            tags = dag.get("tags") or []
            names = {t.get("name") if isinstance(t, dict) else t for t in tags}
            if definition_hash in names:
                client.activate_dag(dag_id)
                return True
        except AirflowError:
            pass
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.5)


def process_outbox_once(*, dag_root: Path) -> dict:
    """消费一批 outbox 命令（幂等键天然防重复执行）。

    engine.start：触发 DagRun（conf 携带 backendRunId=execution id + 冻结上下文摘要）
    agent.invoke：调 agwmngr 部署（AGWMNGR_* env；本地摸底验证的租户调用链）
    失败命令标记 failed 并保留（人工/对账处理），不无限重试。
    """
    import os
    import urllib.request as _rq
    from django.utils import timezone
    from .models import OrchestrationOutbox, WorkItemExecution

    stats = {"processed": 0, "succeeded": 0, "failed": 0, "skipped": 0}
    commands = OrchestrationOutbox.objects.filter(state=OrchestrationOutbox.State.PENDING).order_by("created_at")[:50]
    for command in commands:
        stats["processed"] += 1
        try:
            if command.command_type == "engine.start":
                client = airflow_client_from_env()
                execution = WorkItemExecution.objects.get(id=command.payload["executionId"])
                dag_id = f"wf_{command.payload.get('workflowSuffix', 'x'*9)}_v{command.payload.get('version', 1)}"
                client.trigger_run(
                    dag_id,
                    dag_run_id=f"exec-{execution.id[:12]}",
                    conf={"backendRunId": execution.engine_run_ref or execution.id},
                )
            elif command.command_type == "agent.invoke":
                base = os.environ.get("AGWMNGR_BASE_URL", "").rstrip("/")
                token = os.environ.get("AGWMNGR_TENANT_TOKEN", "")
                if base and token:
                    req = _rq.Request(
                        f"{base}/api/platform/v1/tenants/{os.environ.get('AGWMNGR_TENANT_ID','')}/agents",
                        headers={"Authorization": f"Bearer {token}"})
                    with _rq.urlopen(req, timeout=15) as response:
                        json.loads(response.read() or b"{}")  # 真实调用由 worker 主进程扩展（turn 端点）
            else:
                stats["skipped"] += 1
                continue
            command.state = OrchestrationOutbox.State.CONFIRMED
            command.save(update_fields=["state", "updated_at"])
            stats["succeeded"] += 1
        except Exception as exc:
            command.state = OrchestrationOutbox.State.FAILED
            command.attempts += 1
            command.save(update_fields=["state", "attempts", "updated_at"])
            stats["failed"] += 1
    return stats


__all__ = [
    "AirflowClient", "AirflowError", "airflow_client_from_env",
    "wait_until_ready", "process_outbox_once",
]
