# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""DAG 生成器（自 experts-backend airflow_publication 逐字移植，阶段 2′ worker）。

等价性依据：等价性清单 §2「发布链」+ 功能等价黄金校验（同输入同输出比对）。
适配点（仅两处，均为环境寻址）：
- 回调基地址 env：EXPERT_BACKEND_INTERNAL_BASE_URL → ORCHESTRATION_INTERNAL_BASE_URL
- 回调鉴权：Bearer EXPERT_INTERNAL_TOKEN → X-Orchestration-Token（对齐 Plane 引擎事件端点）
其余模板与节点转译逻辑逐字保留（含 none_failed_min_one_success 汇合规则、
sensor poke_interval=15 竞态防护、审批不设 execution_timeout 等 4 轮迭代修复）。

输入形态：definition 为 dict（Plane WorkflowVersion.definition JSON），
节点/边字段与旧 pydantic 契约同名（nodes[].key/type/timeoutSeconds/retries、
edges[].source/target）。
"""

import os
import tempfile
import time
from pathlib import Path
from textwrap import indent

HUMAN_NODE_TYPE = "human_approval"

# 平台默认（旧 Settings 同值；显式列出防漂移）
AI_DEFAULT_TIMEOUT_SECONDS = 30 * 60
APPROVAL_DEFAULT_TIMEOUT_SECONDS = 30 * 60
APPROVAL_MAX_TIMEOUT_SECONDS = 7 * 24 * 60 * 60
AI_DEFAULT_RETRIES = 1
MAX_ACTIVE_RUNS_PER_DAG = 16

_TEMPLATE = '''from __future__ import annotations

from datetime import datetime, timedelta
import os
import time

from uuid import uuid4

import requests
from airflow.exceptions import AirflowSkipException
from airflow.sdk import PokeReturnValue, dag, get_current_context, task

WORKFLOW_ID = {workflow_id!r}
WORKFLOW_VERSION_ID_HASH = {definition_hash!r}
NODES = {nodes_payload!r}


def _internal_request(method: str, path: str, timeout_seconds: int = 15, **kwargs):
    base_url = os.environ["ORCHESTRATION_INTERNAL_BASE_URL"].rstrip("/")
    token = os.environ["ORCHESTRATION_INTERNAL_TOKEN"]
    response = requests.request(
        method,
        f"{{base_url}}{{path}}",
        headers={{"X-Orchestration-Token": token}},
        timeout=timeout_seconds,
        **kwargs,
    )
    response.raise_for_status()
    return response.json()


def observe_human_node(node: dict) -> PokeReturnValue:
    """Start once and reschedule durable observations without occupying a worker slot."""
    context = get_current_context()
    run_id = context["dag_run"].conf["backendRunId"]
    path = f"/internal/workflow-runs/{{run_id}}/nodes/{{node['key']}}"
    # Human approval can wait for hours; the backend restarting or a network
    # blip during that window must NOT fail the run (design §2.6 durable
    # wait). Transient probe errors keep the sensor waiting; only an explicit
    # failed/cancelled status from the backend fails it.
    try:
        result = _internal_request("GET", path)
    except requests.RequestException:
        return PokeReturnValue(is_done=False, xcom_value=None)
    status = result.get("status")
    if status in {{"pending", "queued"}}:
        try:
            _internal_request(
                "POST",
                f"{{path}}/start",
                json={{
                    "eventId": f"{{run_id}}:{{node['key']}}:{{context['ti'].try_number}}:start",
                    "eventType": "node.started",
                    "attempt": int(context["ti"].try_number),
                    "payload": {{"nodeKey": node["key"]}},
                }},
            )
        except requests.RequestException:
            return PokeReturnValue(is_done=False, xcom_value=None)
        result = _internal_request("GET", path)
        status = result.get("status")
    if status == "skipped":
        raise AirflowSkipException(f"node {{node['key']}} was pruned by a condition")
    if status in {{"failed", "cancelled"}}:
        raise RuntimeError(result.get("error") or "human node failed")
    return PokeReturnValue(is_done=status == "success", xcom_value=result)


def execute_node(node: dict) -> dict:
    context = get_current_context()
    run_id = context["dag_run"].conf["backendRunId"]
    event = {{
        "eventId": f"{{run_id}}:{{node['key']}}:{{uuid4()}}",
        "eventType": "node.started",
        "attempt": int(context["ti"].try_number),
        "payload": {{"nodeKey": node["key"]}},
    }}
    # AI start is a synchronous gateway dispatch in the backend. The HTTP budget must
    # cover the node timeout plus callback overhead; otherwise Airflow retries a node
    # that is still running. Approval starts return immediately and keep short timeout.
    start_timeout = int(node.get("effectiveTimeoutSeconds") or 900) + 30
    _internal_request(
        "POST",
        f"/internal/workflow-runs/{{run_id}}/nodes/{{node['key']}}/start",
        json=event,
        timeout_seconds=start_timeout,
    )
    try:
        while True:
            result = _internal_request(
                "GET",
                f"/internal/workflow-runs/{{run_id}}/nodes/{{node['key']}}",
            )
            status = result.get("status")
            # A condition node upstream chose another branch, so the backend pruned this node.
            # Surfacing it as a skip (rather than a success or a failure) lets Airflow propagate
            # the skip down the dead branch while a join with none_failed_min_one_success still
            # runs. Reachability stays a backend decision; Airflow only mirrors it.
            if status == "skipped":
                raise AirflowSkipException(f"node {{node['key']}} was pruned by a condition")
            if status in {{"success", "failed", "cancelled"}}:
                if status != "success":
                    raise RuntimeError(result.get("error") or "node failed")
                return result
            time.sleep(2)
    except AirflowSkipException:
        # Not a failure: reporting it would mark the run failed and trip the compensation loop.
        raise
    except Exception as exc:
        _internal_request(
            "POST",
            f"/internal/workflow-runs/{{run_id}}/nodes/{{node['key']}}/fail",
            json={{
                "eventId": f"{{run_id}}:{{node['key']}}:{{uuid4()}}:failure",
                "eventType": "node.failed",
                "attempt": int(context["ti"].try_number),
                "payload": {{"nodeKey": node["key"]}},
                "result": {{"error": str(exc)}},
            }},
        )
        raise


@dag(
    dag_id={identifier!r},
    schedule=None,
    start_date=datetime(2026, 1, 1),
    catchup=False,
    max_active_runs={max_active_runs},
    tags=["workflow_version", {definition_hash!r}],
)
def generated_workflow():
{function_body}


generated_workflow()
'''


def dag_id(workflow_id: str, version: int) -> str:
    return f"wf_{workflow_id[-9:]}_v{version}"


def render_dag(*, workflow_id: str, version: int, definition_hash: str, definition: dict) -> str:
    """生成不包含业务 Prompt 和密钥的拓扑回调 DAG（与旧 render_dag 逐逻辑等价）。"""
    nodes = definition.get("nodes") or []
    edges = definition.get("edges") or []
    identifier = dag_id(workflow_id, version)
    upstream = _upstream_counts(nodes, edges)
    tasks: list[str] = []
    calls: list[str] = []
    nodes_payload: list[dict] = []
    for index, node in enumerate(nodes):
        effective_timeout = _effective_timeout(node)
        effective_retries = _effective_retries(node)
        # 审批 deadline 只驱动后端提醒/升级，不能作为 Airflow execution_timeout
        # （等待人工会被引擎自动失败）。
        timeout = (
            f", execution_timeout=timedelta(seconds={effective_timeout})"
            if node["type"] != HUMAN_NODE_TYPE
            else ""
        )
        retries = f", retries={effective_retries}, retry_delay=timedelta(seconds=30)"
        # 汇合节点放宽 trigger_rule：条件分支 skip 不再无声中断（与旧实现统一施加）。
        trigger = (
            ', trigger_rule="none_failed_min_one_success"'
            if upstream[node["key"]] > 1
            else ""
        )
        if node["type"] == HUMAN_NODE_TYPE:
            sensor_timeout = APPROVAL_MAX_TIMEOUT_SECONDS
            tasks.append(
                f'    @task.sensor(task_id="{node["key"]}", mode="reschedule", '
                f"poke_interval=15, retries=3, retry_delay=30, timeout={sensor_timeout}{trigger})\n"
                f"    def task_{index}_{node['key']}(node: dict) -> PokeReturnValue:\n"
                f"        return observe_human_node(node)\n"
            )
        else:
            tasks.append(
                f'    @task(task_id="{node["key"]}"{timeout}{retries}{trigger})\n'
                f"    def task_{index}_{node['key']}(node: dict) -> dict:\n"
                f"        return execute_node(node)\n"
            )
        calls.append(f"    step_{index} = task_{index}_{node['key']}(NODES[{index}])")
        nodes_payload.append(
            {
                "key": node["key"],
                "type": node["type"],
                "timeoutSeconds": node.get("timeoutSeconds"),
                "effectiveTimeoutSeconds": effective_timeout,
                "sensorTimeoutSeconds": APPROVAL_MAX_TIMEOUT_SECONDS
                if node["type"] == HUMAN_NODE_TYPE
                else None,
                "retries": effective_retries,
            }
        )
    task_body = indent("\n".join(tasks), "").rstrip()
    call_body = "\n".join(calls)
    dependency_body = _render_dependencies(nodes, edges)
    function_body = task_body + "\n\n" + call_body
    if dependency_body:
        function_body += "\n\n" + dependency_body
    return _TEMPLATE.format(
        workflow_id=workflow_id,
        definition_hash=definition_hash,
        nodes_payload=nodes_payload,
        identifier=identifier,
        max_active_runs=MAX_ACTIVE_RUNS_PER_DAG,
        function_body=function_body,
    )


def publish_version(*, dag_root: Path, workflow_id: str, version: int, dag_source: str) -> Path:
    """临时文件 + 原子重命名发布不可变版本（chmod 0644 跨 uid 兼容，与旧实现一致）。"""
    suffix = workflow_id[-9:]
    target = dag_root / f"wf_{suffix}_v{version}.py"
    temporary_root = dag_root / ".tmp"
    dag_root.mkdir(parents=True, exist_ok=True)
    temporary_root.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f"{target.stem}.", suffix=".tmp", dir=temporary_root)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(dag_source)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, 0o644)
        os.replace(temporary_name, target)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)
    return target


# ---------------------------------------------------------------- 私有：节点策略


def _effective_timeout(node: dict) -> int:
    if node.get("timeoutSeconds") is not None:
        return int(node["timeoutSeconds"])
    if node["type"] == HUMAN_NODE_TYPE:
        return APPROVAL_DEFAULT_TIMEOUT_SECONDS
    return AI_DEFAULT_TIMEOUT_SECONDS


def _effective_retries(node: dict) -> int:
    if node["type"] == HUMAN_NODE_TYPE:
        return 0
    if node.get("retries") is not None:
        return int(node["retries"])
    return AI_DEFAULT_RETRIES


def _dependency_pairs(nodes: list, edges: list) -> list:
    index_by_key = {node["key"]: index for index, node in enumerate(nodes)}
    if not edges:
        return [(index, index + 1) for index in range(len(nodes) - 1)]
    pairs: list = []
    seen: set = set()
    for edge in edges:
        source = index_by_key.get(edge.get("source"))
        target = index_by_key.get(edge.get("target"))
        if source is None or target is None:
            raise ValueError(f"Workflow edge {edge.get('source')}->{edge.get('target')} references an unknown node")
        if (source, target) in seen:
            continue
        seen.add((source, target))
        pairs.append((source, target))
    return pairs


def _upstream_counts(nodes: list, edges: list) -> dict:
    counts = {node["key"]: 0 for node in nodes}
    for _, target in _dependency_pairs(nodes, edges):
        counts[nodes[target]["key"]] += 1
    return counts


def _render_dependencies(nodes: list, edges: list) -> str:
    return "\n".join(
        f"    step_{source} >> step_{target}"
        for source, target in _dependency_pairs(nodes, edges)
    )
