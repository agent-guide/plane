# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""测试共用画布图夹具——graph_compiler 消费的编辑态形状。

仅 ASCII：本地测试库编码为 SQL_ASCII，非 ASCII JSON 落库报 DataError。
"""

# 单 AI 节点（最常见最小流程）
CANVAS_SINGLE = {
    "version": 1,
    "nodes": [
        {
            "id": "analyze",
            "type": "agent",
            "position": {"x": 240, "y": 200},
            "data": {"name": "analyze", "prompt": "do the analysis", "expertId": "agent:t1:analyst"},
        }
    ],
    "edges": [],
}
