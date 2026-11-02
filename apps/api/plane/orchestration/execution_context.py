# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""执行上下文组装与条件分支判定（自 experts-backend agent_node_dispatcher._prompt
+ workflow_branching 等价移植，2026-10-30 验收发现的等价缺口补齐）。

- 节点 prompt 不再裸发：注入任务标题/描述 + 前置节点输出（旧链同构）
- 条件节点：agent 答复必须是分支名本身（精确→包含回退；多匹配视为未选），
  判定后按选择剪枝不可达节点（fail-open：无法解析的选择不剪任何边）
"""


def build_node_prompt(*, node: dict, issue, prior_outputs: list[dict]) -> str:
    """AI/工具节点的执行指令（等价旧 _prompt 的非分支形态）。"""
    lines = [
        "你是项目工作流中的一个执行节点，请直接输出本节点结果。",
        f"节点：{node.get('name') or node.get('key')}",
        f"指令：{node.get('prompt') or '完成节点目标'}",
        f"任务标题：{getattr(issue, 'name', '') or ''}",
        f"任务描述：{_plain_description(getattr(issue, 'description_html', None))}",
    ]
    for prior in prior_outputs:
        output = prior.get("output") or ""
        lines.append(f"前置节点 {prior.get('node_key')} 输出：{output}")
    return "\n".join(lines)


def build_condition_prompt(*, node: dict, issue, labels: list[str]) -> str:
    """条件节点判定指令（等价旧 _branch_prompt）：答复必须是分支名本身。"""
    return "\n".join([
        "你正在执行项目工作流中的一个条件判断节点，请判断接下来应该走哪个分支。",
        f"节点：{node.get('name') or node.get('key')}",
        f"判断依据：{node.get('prompt') or '根据任务与前置产出选择分支'}",
        f"任务标题：{getattr(issue, 'name', '') or ''}",
        f"任务描述：{_plain_description(getattr(issue, 'description_html', None))}",
        "可选分支（只能选其中一个）：",
        *(f"- {label}" for label in labels),
        "只输出所选分支的名称本身，不要输出任何其他内容，不要调用工具。",
    ])


def condition_branch_labels(definition: dict, node_key: str) -> list[str]:
    """条件节点出边的 label（作者顺序）——即 agent 的候选选项。"""
    return [
        str(edge.get("label"))
        for edge in (definition.get("edges") or [])
        if edge.get("source") == node_key and str(edge.get("label") or "").strip()
    ]


def match_branch_label(answer: str, labels: list[str]) -> str | None:
    """答复映射到分支名；精确优先→包含回退；匹配多个视为未选（不猜）。"""
    cleaned = answer.strip().strip("\"'`").strip("「」").strip()
    if not cleaned:
        return None
    for label in labels:
        if label.strip() == cleaned:
            return label
    contained = [label for label in labels if label.strip() and label.strip() in cleaned]
    return contained[0] if len(contained) == 1 else None


def pruned_node_keys(definition: dict, choices: dict[str, str]) -> set[str]:
    """按已记录的分支选择，不再可达的节点集合（等价旧 reachable/pruned）。"""
    nodes = definition.get("nodes") or []
    edges = definition.get("edges") or []
    keys = [n.get("key") for n in nodes]
    if not edges:
        return set()
    condition_keys = {n.get("key") for n in nodes if n.get("type") == "condition"}
    targets = {e.get("target") for e in edges}
    frontier = [key for key in keys if key not in targets]
    reachable: set[str] = set()
    while frontier:
        current = frontier.pop()
        if current in reachable:
            continue
        reachable.add(current)
        chosen = choices.get(current) if current in condition_keys else None
        if chosen is not None and chosen not in condition_branch_labels(definition, current):
            chosen = None  # 记录的选择不能解析为本节点边 → fail-open 全转发
        for edge in edges:
            if edge.get("source") != current:
                continue
            if chosen is not None and str(edge.get("label") or "").strip() != chosen:
                continue
            frontier.append(edge.get("target"))
    return {key for key in keys} - reachable


def _plain_description(html: str | None) -> str:
    """富文本描述取纯文本（粗剥标签——执行注入不需要保留格式）。"""
    import re
    if not html:
        return ""
    text = re.sub(r"<[^>]+>", " ", html)
    return re.sub(r"\s+", " ", text).strip()
