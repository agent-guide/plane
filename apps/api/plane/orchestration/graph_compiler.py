# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""画布 graph → 可执行 definition 编译器（自 experts-backend workflow_graph_compiler
+ domain/workflow_graph 移植，阶段 2′ 流程编辑前置）。

- 画布 graph（编辑态）：{version, nodes:[{id,type,position,data}], edges:[{source,target,label}]}
  ——position 是纯视图数据，绝不进执行路径
- definition（执行契约）：{nodes:[{key,type,name,order,...camelCase 业务字段}],
  edges:[{source,target,label}]}——存 WorkflowVersion.definition，DAG 生成器吃这个形状
- 编译有意有损：position/未知 data 键丢弃——画布上挪节点不改变 definition 哈希，
  不触发等值流程的重发布（与旧实现同一语义）
- 错误码沿用旧链（WORKFLOW_EMPTY/WORKFLOW_CYCLE/...），画布保存失败提示同一套
"""

import re

from .services import TeamDomainError

# 画布节点类型（编辑器发射的历史命名；"agent" 即 AI 节点）
NODE_TYPE_AGENT = "agent"
NODE_TYPE_TOOL = "tool"
NODE_TYPE_CONDITION = "condition"
NODE_TYPE_HUMAN_CONFIRM = "human_confirm"

# 画布类型 → definition 类型
_CANVAS_TO_DEFINITION = {
    NODE_TYPE_AGENT: "ai",
    NODE_TYPE_TOOL: "tool",
    NODE_TYPE_CONDITION: "condition",
    NODE_TYPE_HUMAN_CONFIRM: "human_approval",
}

_UNSAFE_KEY_CHARS = re.compile(r"[^a-zA-Z0-9_-]+")


def compile_graph(graph: dict) -> dict:
    """画布 graph 编译为校验过的 definition；非法输入抛 TeamDomainError(400)。"""
    if not isinstance(graph, dict):
        raise TeamDomainError(400, "WORKFLOW_GRAPH_INVALID", "Workflow graph must be an object")
    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    node_ids = {n.get("id") for n in nodes}
    # 悬挂边（指向已删节点）直接丢弃——画布删除可能留尾巴，后端不信任客户端形状
    edges = [e for e in edges if e.get("source") in node_ids and e.get("target") in node_ids]

    if not nodes:
        raise TeamDomainError(400, "WORKFLOW_EMPTY", "A workflow needs at least one node")

    ordered = _topological_order(nodes, edges)
    keys = _node_keys(ordered)
    compiled = [_compile_node(node, keys[node["id"]], order) for order, node in enumerate(ordered)]
    compiled_edges = [
        {"source": keys[e["source"]], "target": keys[e["target"]], "label": e.get("label")}
        for e in edges
    ]
    _validate_condition_branches(compiled, compiled_edges)
    return {"nodes": compiled, "edges": compiled_edges}


def _topological_order(nodes: list, edges: list) -> list:
    """Kahn 拓扑排序：就绪节点按声明顺序取——单链流程保持作者键入的顺序。"""
    indegree = {n["id"]: 0 for n in nodes}
    successors: dict[str, list[str]] = {n["id"]: [] for n in nodes}
    for edge in edges:
        source, target = edge.get("source"), edge.get("target")
        if source == target:
            raise TeamDomainError(400, "WORKFLOW_CYCLE", f"Workflow graph is not a DAG: self loop on node {source}")
        if source not in successors or target not in indegree:
            raise TeamDomainError(
                400, "WORKFLOW_CYCLE", f"Workflow graph is not a DAG: edge {source}->{target} references an unknown node")
        successors[source].append(target)
        indegree[target] += 1

    ordered: list[str] = []
    ready = [node_id for node_id, degree in indegree.items() if degree == 0]
    while ready:
        node_id = ready.pop(0)
        ordered.append(node_id)
        for successor in successors[node_id]:
            indegree[successor] -= 1
            if indegree[successor] == 0:
                ready.append(successor)
    if len(ordered) != len(indegree):
        raise TeamDomainError(400, "WORKFLOW_CYCLE", "Workflow graph is not a DAG: graph contains a cycle")
    by_id = {n["id"]: n for n in nodes}
    return [by_id[node_id] for node_id in ordered]


def _node_keys(ordered: list) -> dict[str, str]:
    """画布 id → 稳定且 DAG 安全的节点 key（作 Airflow task id，字符集受限）。"""
    keys: dict[str, str] = {}
    for index, node in enumerate(ordered):
        slug = _UNSAFE_KEY_CHARS.sub("_", str(node.get("id") or "")).strip("_") or "node"
        keys[node["id"]] = f"{slug}_{index}"
    return keys


def _compile_node(node: dict, key: str, order: int) -> dict:
    node_type = _CANVAS_TO_DEFINITION.get(node.get("type"))
    if node_type is None:
        raise TeamDomainError(
            400, "WORKFLOW_NODE_TYPE_UNKNOWN", f"Unknown canvas node type '{node.get('type')}'")

    data = node.get("data") or {}
    name = str(data.get("name") or "").strip() or key
    compiled = {
        "key": key, "type": node_type, "name": name, "order": order,
        "timeoutSeconds": _optional_int(data.get("timeoutSeconds")),
        "retries": _optional_int(data.get("retries")),
    }
    try:
        if node_type == "ai" or node_type == "condition":
            # 条件节点的判断本身是一次 AI turn，命名 expert 与 AI 节点同构；
            # 分支来自带 label 的出边，随整图拓扑校验
            compiled["expertId"] = _text(data.get("expertId"))
            compiled["prompt"] = _text(data.get("prompt"))
        elif node_type == "tool":
            compiled["toolName"] = _text(data.get("toolName") or data.get("tool_name"))
            compiled["connection"] = _text(data.get("connection"))
            compiled["params"] = data.get("params") or None
        else:  # human_approval
            compiled["approverUserId"] = _text(data.get("approverUserId"))
            compiled["escalationUserId"] = _text(data.get("escalationUserId"))
            compiled["prompt"] = _text(data.get("prompt"))
            compiled["options"] = _options(data.get("options"))
            compiled["message"] = _text(data.get("message"))
            compiled["freeText"] = _optional_boolean(data.get("freeText"))
    except ValueError as exc:
        raise TeamDomainError(400, "WORKFLOW_NODE_INVALID", str(exc))

    # 范围校验（对齐旧 pydantic gt=0 / ge=0）：越界值报可定位错误而非静默吞掉
    timeout = compiled.get("timeoutSeconds")
    if timeout is not None and timeout <= 0:
        raise TeamDomainError(400, "WORKFLOW_NODE_INVALID", "timeoutSeconds must be > 0")
    retries = compiled.get("retries")
    if retries is not None and retries < 0:
        raise TeamDomainError(400, "WORKFLOW_NODE_INVALID", "retries must be >= 0")

    # None 值键剔除——保持与旧「未设置不入序列化」的规范形一致，等值定义哈希稳定
    return {k: v for k, v in compiled.items() if v is not None}


def _validate_condition_branches(nodes: list, edges: list) -> None:
    """条件节点按 label 路由：出边必须都有 label 且互不重复——否则执行时
    agent 无法命名要走的分支（或选择有歧义），在编排期就拒绝。"""
    condition_keys = {n["key"] for n in nodes if n["type"] == NODE_TYPE_CONDITION}
    if not condition_keys:
        return
    outgoing: dict[str, list[str | None]] = {key: [] for key in condition_keys}
    for edge in edges:
        if edge["source"] in condition_keys:
            outgoing[edge["source"]].append(edge.get("label"))
    for key, labels in outgoing.items():
        if len(labels) < 2:
            raise TeamDomainError(400, "WORKFLOW_GRAPH_INVALID", f"Condition node '{key}' requires at least two outgoing branches")
        if any(not str(label or "").strip() for label in labels):
            raise TeamDomainError(400, "WORKFLOW_GRAPH_INVALID", f"Condition node '{key}' has an unlabelled branch")
        if len({str(label).strip() for label in labels}) != len(labels):
            raise TeamDomainError(400, "WORKFLOW_GRAPH_INVALID", f"Condition node '{key}' has duplicate branch labels")


def _text(value) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def _options(value) -> list[dict] | None:
    """确认节点选项归一：label 优先，机器值缺省回退 label；两者皆空的选项丢弃。"""
    if not isinstance(value, list):
        return None
    options: list[dict] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            continue
        label = _text(item.get("label")) or _text(item.get("value"))
        option_value = _text(item.get("value")) or label
        if not label or not option_value or option_value in seen:
            continue
        seen.add(option_value)
        options.append({"label": label, "value": option_value, "terminal": bool(item.get("terminal"))})
    return options or None


def _optional_int(value) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _optional_boolean(value) -> bool | None:
    if value is None or value is False:
        return None
    if value is True:
        return True
    raise ValueError("freeText must be a boolean")
