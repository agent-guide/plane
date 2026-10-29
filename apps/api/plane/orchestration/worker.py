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
        """幂等触发：dag_run_id 由调用方预生成，重放不产生第二个业务 run。

        Airflow 3.3 Stable API 必须带 logical_date（10-29 真机联调实证 422）；
        同 dag_run_id 重放返回 409 —— 幂等成功（10-29 实证）。
        """
        from datetime import datetime, timezone
        try:
            return self._request(
                "POST", f"dags/{dag_id}/dagRuns",
                {"dag_run_id": dag_run_id, "conf": conf,
                 "logical_date": datetime.now(timezone.utc).isoformat()})
        except AirflowError as exc:
            if exc.status == 409:
                return {"dag_run_id": dag_run_id, "note": "idempotent replay"}
            raise


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


def _post_internal_event(event: dict) -> dict:
    """向 Plane 引擎事件端点投递（X-Orchestration-Token 服务鉴权）。"""
    import os
    base = os.environ.get("ORCHESTRATION_INTERNAL_BASE_URL", "http://127.0.0.1:8001").rstrip("/")
    token = os.environ.get("ORCHESTRATION_INTERNAL_TOKEN", "")
    req = urllib.request.Request(
        f"{base}/api/internal/agent-teams/events/",
        data=json.dumps(event).encode(), method="POST",
        headers={"Content-Type": "application/json", "X-Orchestration-Token": token})
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.loads(response.read() or b"{}")


def publish_workflow(*, workflow_id: str, version_number: int, definition: dict, definition_hash: str,
                     dag_root: Path) -> dict:
    """发布链（视图层调用）：渲染 → 原子落盘 → 轮询就绪 → 激活。

    返回 {status: published|failed, engine_deploy_ref}；失败由调用方落 fail_publish
    （版本可重发）。DAG 文件回调地址/TOKEN 取自 Airflow 侧 env
    （ORCHESTRATION_INTERNAL_*，DAG 解析期读取）。
    """
    from .dag_publication import render_dag, publish_version
    dag_source = render_dag(
        workflow_id=workflow_id, version=version_number,
        definition_hash=definition_hash, definition=definition)
    path = publish_version(
        dag_root=dag_root, workflow_id=workflow_id, version=version_number, dag_source=dag_source)
    from .dag_publication import dag_id
    identifier = dag_id(workflow_id, version_number)
    client = airflow_client_from_env()
    ready = wait_until_ready(client, dag_id=identifier, definition_hash=definition_hash, timeout_seconds=90)
    if not ready:
        return {"status": "failed", "reason": "dag not ready in 90s", "path": str(path)}
    return {"status": "published", "engine_deploy_ref": {"dag_id": identifier, "file": path.name}}


def _internal_node_call(method: str, path: str, payload: dict) -> dict:
    """worker → Plane 内部节点端点（X-Orchestration-Token）。"""
    import os
    base = os.environ.get("ORCHESTRATION_INTERNAL_BASE_URL", "http://127.0.0.1:8001").rstrip("/")
    token = os.environ.get("ORCHESTRATION_INTERNAL_TOKEN", "")
    req = urllib.request.Request(
        f"{base}{path}", method=method,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "X-Orchestration-Token": token})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read() or b"{}")


def _agwmngr_headers() -> dict:
    import os
    token = os.environ.get("AGWMNGR_TENANT_TOKEN", "")
    if not token:
        raise RuntimeError("AGWMNGR_TENANT_TOKEN not configured")
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _agwmngr_base() -> str:
    import os
    base = os.environ.get("AGWMNGR_BASE_URL", "").rstrip("/")
    tenant = os.environ.get("AGWMNGR_TENANT_ID", "")
    if not base or not tenant:
        raise RuntimeError("AGWMNGR_BASE_URL/TENANT_ID not configured")
    return f"{base}/api/platform/v1/tenants/{tenant}"


def invoke_agent_node(*, agent_definition_id: str, prompt: str, session_hint: str) -> str:
    """agent 节点执行：解析部署 → 建调用上下文 → turn（SSE 聚合为完整回复）。

    阶段 0/1′ 摸底验证的租户调用链；SSE 形态与旧 llm_gateway 同源
    （data: 文本增量，[DONE] 终止）。
    """
    import os
    headers = _agwmngr_headers()
    base = _agwmngr_base()

    def call(method: str, path: str, payload: dict | None = None, timeout: float = 30):
        req = urllib.request.Request(
            f"{base}{path}", method=method,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read() or b"{}"
            return json.loads(body) if body.strip().startswith((b"{", b"[")) else body.decode()

    # ① 解析部署：agent 定义 → 最新 active 部署
    deployments = call("GET", "/deployments")
    items = deployments.get("items") if isinstance(deployments, dict) else deployments
    # 部署字段：definitionId / lifecycleState（active=可调用）
    candidates = [d for d in (items or [])
                  if d.get("definitionId") == agent_definition_id
                  and str(d.get("lifecycleState", "")).lower() == "active"]
    if not candidates:
        raise RuntimeError(f"no deployment for agent {agent_definition_id}")
    deployment = candidates[0]

    # ② 调用上下文（15 分钟有效；key 解析交平台默认）
    context = call("POST", f"/deployments/{deployment['id']}/invocations", {})

    # ③ turn：SSE 聚合（节点超时预算 + 回调余量；builtin 直答通常 <60s）
    req = urllib.request.Request(
        f"{base}/invocations/{context['id']}/turn", method="POST",
        data=json.dumps({"input": prompt, "session_id": session_hint}).encode(),
        headers=headers)
    # SSE 信封：event: <type> / data: {json}——delta 事件取 text 聚合；
    # error 事件显式抛错（不静默空回复）
    pieces: list[str] = []
    event_type = ""
    with urllib.request.urlopen(req, timeout=600) as response:
        for raw in response:
            line = raw.decode("utf-8", "replace").strip()
            if line.startswith("event: "):
                event_type = line[len("event: "):].strip()
                continue
            if not line.startswith("data: "):
                continue
            data = line[len("data: "):].strip()
            if data == "[DONE]":
                break
            try:
                envelope = json.loads(data)
            except ValueError:
                continue
            if event_type == "error":
                raise RuntimeError(f"agent turn error: {str(envelope)[:200]}")
            if event_type == "delta" and isinstance(envelope.get("text"), str):
                pieces.append(envelope["text"])
    return "".join(pieces)


def reconcile_runs_once() -> dict:
    """活跃执行对账：向 Airflow 查 run 终态并投 engine.terminal。

    常驻 worker 周期调用（DAG 节点全部收口后 run 才终态；此处只投事件，
    状态推进走引擎事件消费——单一事实源）。
    """
    from .models import WorkItemExecution
    from .state_machine import TERMINAL_STATUSES
    client = airflow_client_from_env()
    stats = {"checked": 0, "settled": 0}
    for ex in WorkItemExecution.objects.exclude(business_status__in=list(TERMINAL_STATUSES)):
        if not ex.engine_run_ref:
            continue
        stats["checked"] += 1
        dag_run_id = f"exec-{ex.id[:12]}"
        version = ex.binding.workflow_version
        from .dag_publication import dag_id
        try:
            run = client._request("GET", f"dags/{dag_id(version.workflow_id, version.version)}/dagRuns/{dag_run_id}")
        except AirflowError as exc:
            if exc.status == 404:
                continue  # 引擎侧尚无 run（启动在途）
            raise
        state = run.get("state")
        if state in ("success", "failed", "cancelled"):
            _post_internal_event({
                "externalEventId": f"engine-terminal:{ex.id}:{state}",
                "eventType": "engine.terminal",
                "payload": {"executionId": ex.id, "engine_status": state},
            })
            stats["settled"] += 1
    return stats


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
                from .models import WorkflowVersion
                execution = WorkItemExecution.objects.get(id=command.payload["executionId"])
                version = WorkflowVersion.objects.select_related("workflow").get(
                    id=execution.binding.workflow_version_id)
                from .dag_publication import dag_id
                identifier = dag_id(version.workflow_id, version.version)
                client.trigger_run(
                    identifier,
                    dag_run_id=f"exec-{execution.id[:12]}",
                    conf={"backendRunId": execution.id},
                )
                # 触发即回投 engine.started：engine_run_ref = execution.id
                # （DAG 节点回调按 run_ref 解析执行，与 conf backendRunId 同源）
                _post_internal_event({
                    "externalEventId": f"start:{execution.id}:started",
                    "eventType": "engine.started",
                    "payload": {"executionId": execution.id, "engine_run_ref": execution.id},
                })
            elif command.command_type == "agent.invoke":
                # 真调用：发布版本 definition 的节点（key=DAG 任务 id）→ 部署 →
                # turn 聚合 → 节点 finish 回写（DAG 轮询 observe 收口）
                from .models import WorkflowVersion
                execution = WorkItemExecution.objects.select_related(
                    "binding", "binding__workflow_version").get(id=command.payload["executionId"])
                node_key = command.payload["nodeKey"]
                definition = execution.binding.workflow_version.definition or {}
                node = next((n for n in (definition.get("nodes") or []) if n.get("key") == node_key), None)
                if node is None or not node.get("expertId"):
                    raise RuntimeError(f"node {node_key} has no agent reference")
                prompt = (node.get("prompt") or node.get("name") or node_key)
                reply = invoke_agent_node(
                    agent_definition_id=node["expertId"], prompt=prompt, session_hint=f"{execution.id}:{node_key}")
                _internal_node_call("POST", f"/api/internal/workflow-runs/{execution.engine_run_ref or execution.id}"
                                    f"/nodes/{node_key}/finish/",
                                    {"result": {"status": "success", "output": reply[:20000]}})
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
    "invoke_agent_node",
    "AirflowClient", "AirflowError", "airflow_client_from_env",
    "wait_until_ready", "process_outbox_once", "publish_workflow", "reconcile_runs_once",
]
