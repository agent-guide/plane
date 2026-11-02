# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""graph_compiler 契约测试——黄金基准 + 逐错误码触发（移植语义锁定）。"""

from django.test import SimpleTestCase

from plane.orchestration.graph_compiler import compile_graph
from plane.orchestration.services import TeamDomainError

# 分支流程黄金样例：AI → 条件（两条带 label 出边）→ 人工确认 / 工具；含视图位
# 置、悬挂边、空选项——编译必须全部按规则处置
GOLDEN_GRAPH = {
    "version": 1,
    "nodes": [
        {"id": "start", "type": "agent", "position": {"x": 0, "y": 0},
         "data": {"name": "起草", "prompt": "起草方案", "expertId": "agent:t:writer", "timeoutSeconds": 300}},
        {"id": "decide", "type": "condition", "position": {"x": 0, "y": 1},
         "data": {"name": "评审", "prompt": "判断是否通过", "expertId": "agent:t:reviewer"}},
        {"id": "confirm", "type": "human_confirm", "position": {"x": 0, "y": 2},
         "data": {"name": "人工确认", "approverUserId": "u1", "message": "确认发布？",
                  "options": [{"label": "通过", "value": "ok"}, {"label": "驳回", "value": "no", "terminal": True}]}},
        {"id": "call", "type": "tool", "position": {"x": 0, "y": 3},
         "data": {"name": "发布", "toolName": "deploy", "connection": "prod", "params": {"env": "test"}}},
    ],
    "edges": [
        {"id": "e1", "source": "start", "target": "decide"},
        {"source": "decide", "target": "confirm", "label": "通过"},
        {"source": "decide", "target": "call", "label": "直接发布"},
        {"source": "confirm", "target": "call"},
        {"source": "start", "target": "ghost"},  # 悬挂边 → 丢弃
    ],
}


class CompileGoldenTests(SimpleTestCase):
    def test_golden_definition(self):
        d = compile_graph(GOLDEN_GRAPH)
        by_key = {n["key"]: n for n in d["nodes"]}
        # 画布 id → slug_key（拓扑序后缀），position 不进 definition
        self.assertEqual([n["key"] for n in d["nodes"]],
                         ["start_0", "decide_1", "confirm_2", "call_3"])
        self.assertNotIn("position", str(d))
        # AI/条件节点：expertId+prompt；类型映射 agent/condition → ai/condition
        self.assertEqual(by_key["start_0"]["type"], "ai")
        self.assertEqual(by_key["start_0"]["expertId"], "agent:t:writer")
        self.assertEqual(by_key["start_0"]["timeoutSeconds"], 300)
        self.assertEqual(by_key["decide_1"]["type"], "condition")
        # 人工节点：approver/options 归一（label 优先、terminal 布尔化）
        human = by_key["confirm_2"]
        self.assertEqual(human["approverUserId"], "u1")
        self.assertEqual(human["options"], [
            {"label": "通过", "value": "ok", "terminal": False},
            {"label": "驳回", "value": "no", "terminal": True},
        ])
        # 工具节点：toolName/connection/params
        tool = by_key["call_3"]
        self.assertEqual(tool["toolName"], "deploy")
        self.assertEqual(tool["params"], {"env": "test"})
        # 边：id 换 key、label 保留；悬挂边消失
        pairs = {(e["source"], e["target"]) for e in d["edges"]}
        self.assertEqual(len(d["edges"]), 4)
        self.assertIn(("decide_1", "confirm_2"), pairs)
        self.assertIn(("confirm_2", "call_3"), pairs)

    def test_position_change_does_not_rehash(self):
        moved = {**GOLDEN_GRAPH, "nodes": [
            {**n, "position": {"x": 999, "y": 999}} for n in GOLDEN_GRAPH["nodes"]]}
        self.assertEqual(compile_graph(moved), compile_graph(GOLDEN_GRAPH))

    def test_unkeyed_fields_dropped_for_canonical_hash(self):
        # 未设置的可选字段不出现（None 键剔除）——保持规范形，等值定义哈希稳定
        d = compile_graph(GOLDEN_GRAPH)
        for node in d["nodes"]:
            self.assertNotIn("escalationUserId", node)
            if node["type"] != "human_approval":
                self.assertNotIn("freeText", node)
            if node["type"] != "tool":
                self.assertNotIn("params", node)


class CompileErrorTests(SimpleTestCase):
    def _expect(self, graph, code):
        with self.assertRaises(TeamDomainError) as c:
            compile_graph(graph)
        self.assertEqual(c.exception.code, code)

    def test_empty(self):
        self._expect({"nodes": [], "edges": []}, "WORKFLOW_EMPTY")

    def test_cycle(self):
        self._expect({
            "nodes": [{"id": "a", "type": "agent", "data": {}}, {"id": "b", "type": "agent", "data": {}}],
            "edges": [{"source": "a", "target": "b"}, {"source": "b", "target": "a"}],
        }, "WORKFLOW_CYCLE")

    def test_self_loop(self):
        self._expect({
            "nodes": [{"id": "a", "type": "agent", "data": {}}],
            "edges": [{"source": "a", "target": "a"}],
        }, "WORKFLOW_CYCLE")

    def test_unknown_node_type(self):
        self._expect({"nodes": [{"id": "a", "type": "wat", "data": {}}], "edges": []},
                     "WORKFLOW_NODE_TYPE_UNKNOWN")

    def test_condition_needs_two_labelled_branches(self):
        one_branch = {
            "nodes": [{"id": "c", "type": "condition", "data": {}}, {"id": "a", "type": "agent", "data": {}}],
            "edges": [{"source": "c", "target": "a", "label": "唯一"}],
        }
        self._expect(one_branch, "WORKFLOW_GRAPH_INVALID")
        unlabelled = {
            "nodes": [{"id": "c", "type": "condition", "data": {}},
                      {"id": "a", "type": "agent", "data": {}}, {"id": "b", "type": "agent", "data": {}}],
            "edges": [{"source": "c", "target": "a", "label": "x"}, {"source": "c", "target": "b"}],
        }
        self._expect(unlabelled, "WORKFLOW_GRAPH_INVALID")

    def test_duplicate_branch_labels(self):
        self._expect({
            "nodes": [{"id": "c", "type": "condition", "data": {}},
                      {"id": "a", "type": "agent", "data": {}}, {"id": "b", "type": "agent", "data": {}}],
            "edges": [{"source": "c", "target": "a", "label": "同"}, {"source": "c", "target": "b", "label": "同"}],
        }, "WORKFLOW_GRAPH_INVALID")

    def test_bad_timeout_rejected(self):
        self._expect({"nodes": [{"id": "a", "type": "agent",
                                 "data": {"timeoutSeconds": 0}}], "edges": []},
                     "WORKFLOW_NODE_INVALID")

    def test_bad_free_text_rejected(self):
        self._expect({"nodes": [{"id": "h", "type": "human_confirm",
                                 "data": {"freeText": "yes"}}], "edges": []},
                     "WORKFLOW_NODE_INVALID")


class ExecutionContextTests(SimpleTestCase):
    """执行上下文组装与分支判定（等价旧 _prompt / workflow_branching）。"""

    def test_prompt_injects_task_and_prior_outputs(self):
        from plane.orchestration.execution_context import build_node_prompt

        class Issue:
            name = "上线报销系统"
            description_html = "<p>含审批流与</p><p>发票上传</p>"

        prompt = build_node_prompt(
            node={"key": "a_0", "name": "需求分析", "prompt": "整理需求"},
            issue=Issue(),
            prior_outputs=[{"node_key": "b_0", "output": "前置结论"}],
        )
        self.assertIn("任务标题：上线报销系统", prompt)
        self.assertIn("任务描述：含审批流与 发票上传", prompt)
        self.assertIn("前置节点 b_0 输出：前置结论", prompt)

    def test_match_branch_label_exact_then_containment(self):
        from plane.orchestration.execution_context import match_branch_label

        self.assertEqual(match_branch_label("「通过」", ["通过", "驳回"]), "通过")
        self.assertEqual(match_branch_label("我建议选择 直接发布", ["通过", "直接发布"]), "直接发布")
        self.assertIsNone(match_branch_label("都行", ["通过", "驳回"]))  # 未选不猜
        self.assertIsNone(match_branch_label("通过 驳回", ["通过", "驳回"]))  # 多匹配视为未选

    def test_pruned_nodes_by_choice(self):
        from plane.orchestration.execution_context import pruned_node_keys

        definition = {
            "nodes": [{"key": k, "type": "condition" if k == "c" else "ai"} for k in ("s", "c", "a", "b", "j")],
            "edges": [
                {"source": "s", "target": "c"},
                {"source": "c", "target": "a", "label": "左"},
                {"source": "c", "target": "b", "label": "右"},
                {"source": "a", "target": "j"},
                {"source": "b", "target": "j"},
            ],
        }
        self.assertEqual(pruned_node_keys(definition, {"c": "左"}), {"b"})
        self.assertEqual(pruned_node_keys(definition, {}), set())  # 未判定不剪
        self.assertEqual(pruned_node_keys(definition, {"c": "不存在"}), set())  # fail-open
