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

import requests
from airflow.exceptions import AirflowSkipException
from airflow.sdk import PokeReturnValue, dag, get_current_context, task

WORKFLOW_ID = {workflow_id!r}
WORKFLOW_VERSION_ID_HASH = {definition_hash!r}
NODES = {nodes_payload!r}
SENSOR_TIMEOUT_SECONDS = {sensor_timeout}


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


def report_dag_terminal(context):
    """DAG run 终局回调（主路径推送，11-23 补齐）：run success/failed 时
    主动推后端 engine.terminal——对账循环退为兜底（网络丢包等漏网场景）。

    此前主路径缺失：执行终态靠 sensor 级 on_failure_callback（节点失败
    被越界升级为执行终态）+ 对账循环兜底——112102 事故实证重试成功
    也翻不回来。DAG 级回调只在 run 真正终局时触发，不关心节点级重试。
    """
    dag_run = context["dag_run"]
    run_id = dag_run.conf.get("backendRunId", dag_run.run_id)
    state = dag_run.state  # success / failed
    try:
        _internal_request(
            "POST",
            "/api/internal/agent-teams/events/",
            json={{
                "externalEventId": f"dag-terminal:{{run_id}}:{{state}}",
                "eventType": "engine.terminal",
                "payload": {{"executionId": run_id.replace("exec-", ""), "engine_status": state}},
            }},
        )
    except Exception:
        pass  # 推送失败由对账循环兜底


def report_sensor_failure(context):
    """sensor 终结（超时/失败）回调：把失败原因登记回后端节点失败端点。

    后端登记节点 FAILED + 以团队助手身份把原因落到卡片评论（C5 一期：
    超时终结不再「悄悄失败」）。此处尽力而为，登不上时 worker 的引擎
    终态对账仍然兜底结算——只是没有原因可展示。
    """
    ti = context["task_instance"]
    node_key = ti.task_id.split("_", 2)[2]
    run_ref = context["dag_run"].conf.get("backendRunId", context["dag_run"].run_id)
    raw = str(context.get("exception") or "")
    is_timeout = "timed out" in raw.lower() or "AirflowTaskTimeout" in raw
    if is_timeout:
        reason = (
            f"节点 {{node_key}} 等待人工处理超时"
            f"（超过 {{SENSOR_TIMEOUT_SECONDS // 86400}} 天未响应），执行已终止"
        )
    else:
        reason = f"节点 {{node_key}} 运行失败：{{raw or 'unknown error'}}"
    try:
        _internal_request(
            "POST",
            f"/api/internal/workflow-runs/{{run_ref}}/nodes/{{node_key}}/fail/",
            json={{
                "eventId": f"sensor-fail:{{run_ref}}:{{node_key}}",
                "result": {{"error": reason, "timeout": is_timeout}},
            }},
        )
    except Exception:
        pass  # 对账兜底；此处仅尽力补原因


def observe_node(node: dict) -> PokeReturnValue:
    """通用节点观察 sensor（人工审批与 AI/条件节点共用，reschedule 不占 worker 槽）。

    状态语义：
    - pending/queued → POST /start 启动（AI 节点建 agent.invoke，人工节点建审批）
    - running / waiting_human → 继续等（不超时、不忙轮询、不占槽）
    - failed → AI/条件节点重新 POST /start 重试（重试上限由后端 /start 判定，
      耗尽返回 failed 则 raise）；人工节点直接 raise
    - success → 完成；cancelled → raise

    这取代旧的 execute_node 忙轮询（@task + execution_timeout）——「等人工」是
    sensor 语义，不是「有限时间跑完」的 task 语义（NEED_INPUT 暂停等人工可跨
    数小时/天，忙轮询 + timeout 会误判重试、占 worker 槽、与 engine.terminal
    抢状态机）。
    """
    context = get_current_context()
    run_id = context["dag_run"].conf["backendRunId"]
    path = f"/api/internal/workflow-runs/{{run_id}}/nodes/{{node['key']}}/"
    # 等人工可跨数小时；后端重启/网络抖动不能误判 run 失败（设计 §2.6 durable
    # wait）。瞬时探测错误保持等待；只有后端显式 failed/cancelled 才失败。
    try:
        result = _internal_request("GET", path)
    except requests.RequestException:
        return PokeReturnValue(is_done=False, xcom_value=None)
    status = result.get("status")
    if status in {{"pending", "queued"}} or (status == "failed" and node["type"] in ("ai", "condition")):
        try:
            start_resp = _internal_request(
                "POST",
                f"{{path}}start/",
                json={{
                    "eventId": f"{{run_id}}:{{node['key']}}:{{context['ti'].try_number}}:start",
                    "eventType": "node.started",
                    "attempt": int(context["ti"].try_number),
                    "payload": {{"nodeKey": node["key"]}},
                }},
            )
        except requests.RequestException:
            return PokeReturnValue(is_done=False, xcom_value=None)
        # 重试耗尽时后端 /start 返回 status=failed → 让 DAG run 失败（不再无限重试）
        if start_resp.get("status") == "failed":
            raise RuntimeError(start_resp.get("error") or "node failed after retries exhausted")
        return PokeReturnValue(is_done=False, xcom_value=None)
    if status == "skipped":
        raise AirflowSkipException(f"node {{node['key']}} was pruned by a condition")
    if status in {{"failed", "cancelled"}}:
        raise RuntimeError(result.get("error") or "node failed")
    return PokeReturnValue(is_done=status == "success", xcom_value=result)


@dag(
    dag_id={identifier!r},
    schedule=None,
    start_date=datetime(2026, 1, 1),
    catchup=False,
    max_active_runs={max_active_runs},
    tags=["workflow_version", {definition_hash!r}],
    on_success_callback=report_dag_terminal,
    on_failure_callback=report_dag_terminal,
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
        # 人工审批与 AI/条件节点都用 sensor（reschedule）：等待人工可跨数小时/天，
        # sensor 不占 worker 槽、无 execution_timeout。AI 节点的 NEED_INPUT 暂停
        # 等人工不再被 execution_timeout 误判重试（WB-4005 双线竞态）；agent 自身
        # total_timeout（invoke_agent_node 用 _effective_timeout）仍兜底「agent 卡死」。
        # 汇合节点放宽 trigger_rule：条件分支 skip 不再无声中断（与旧实现统一施加）。
        trigger = (
            ', trigger_rule="none_failed_min_one_success"'
            if upstream[node["key"]] > 1
            else ""
        )
        # C5 一期（2026-11-15）：sensor retries=0——Airflow 层重试会让超时窗口
        # 静默翻倍（人工节点原 retries=3 = 最多 4×7 天无人知晓），且业务失败
        # 重试预算已由后端 /start 的 failure_retries 判定，Airflow 重试纯空转。
        # 超时/失败经 on_failure_callback 带原因回后端（report_sensor_failure）。
        tasks.append(
            f'    @task.sensor(task_id="{node["key"]}", mode="reschedule", '
            f"poke_interval=15, retries=0, timeout={APPROVAL_MAX_TIMEOUT_SECONDS}, "
            f"on_failure_callback=report_sensor_failure{trigger})\n"
            f"    def task_{index}_{node['key']}(node: dict) -> PokeReturnValue:\n"
            f"        return observe_node(node)\n"
        )
        calls.append(f"    step_{index} = task_{index}_{node['key']}(NODES[{index}])")
        nodes_payload.append(
            {
                "key": node["key"],
                "type": node["type"],
                "timeoutSeconds": node.get("timeoutSeconds"),
                "effectiveTimeoutSeconds": effective_timeout,
                # 等待上限对全部节点生效（AI 节点 NEED_INPUT 等人也受此封顶）
                "sensorTimeoutSeconds": APPROVAL_MAX_TIMEOUT_SECONDS,
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
        sensor_timeout=APPROVAL_MAX_TIMEOUT_SECONDS,
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
