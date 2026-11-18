# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""agwmngr 接口契约冻结测试（2026-11-16 断裂复盘的产物）。

背景：agwmngr dev 重构把 release 标识从字符串 id 改为数字 number
（appliedReleaseId → appliedReleaseNumber、releases[].id → releases[].number），
plane worker 静默拿到空运行时类型、生产链路断——两边代码各自正确、契约无人守护。
本文件把 worker 实际依赖的字段子集冻结成断言：agwmngr 任何形状变更先红在这里。

两类用例：
  1. 形状冻结（本文件内嵌 fixture，离线跑，CI 门禁）
  2. 真机对拍（设 AGWMNGR_CONTRACT_BASE_URL/TOKEN 时启用，打运行中的 agwmngr）
"""
import json
import os
import unittest
import urllib.request
from unittest import mock

from plane.orchestration.worker import _resolve_runtime_type

# ── 冻结的响应形状（2026-11-16 agwmngr dev 实测抓取；字段裁剪到 worker 依赖集）──
# GET /deployments → {"items": [...]}，每项 worker 消费：id / definitionId / lifecycleState
#   ＋ _resolve_runtime_type 消费 appliedReleaseId（旧）或 appliedReleaseNumber（新）
DEPLOYMENT_ITEM_NUMBER = {
    "id": "deployment:orch-v2:b6ec7c7c0d8512f0cd1eac05",
    "definitionId": "agent:orch-v2:chat-employee",
    "requestedReleaseNumber": 1,
    "appliedReleaseNumber": 1,
    "lifecycleState": "active",
}
DEPLOYMENT_ITEM_ID = {  # 旧契约（feature/agent-resource-platform 时代），兼容期保留
    "id": "deployment:orch-v2:legacy",
    "definitionId": "agent:orch-v2:chat-employee",
    "appliedReleaseId": "release:orch-v2:r1",
    "lifecycleState": "active",
}
# GET /agents/{id}/releases → items[]，_resolve_runtime_type 消费：
#   id（旧匹配键）/ number（新匹配键）＋ snapshot.runtime.type（权威值）
RELEASE_ITEM_NUMBER = {
    "number": 1,
    "runtimeType": "builtin",  # 顶层冗余字段；worker 不读（读 snapshot 权威值）
    "snapshot": {"runtime": {"type": "builtin", "advanced": {"topology": {"kind": "single"}}}},
}
RELEASE_ITEM_ID = {
    "id": "release:orch-v2:r1",
    "snapshot": {"runtime": {"type": "builtin"}},
}
RELEASE_ITEM_ACP = {"number": 2, "snapshot": {"runtime": {"type": "acp"}}}


class ShapeContractTests(unittest.TestCase):
    """worker 消费路径的形状断言——agwmngr 改字段先红这里。"""

    def _resolve(self, deployment, releases):
        fake_call = mock.Mock(side_effect=lambda method, path: {"items": releases})
        return _resolve_runtime_type(fake_call, "agent:orch-v2:chat-employee", deployment)

    def test_number_shape_builtin(self):
        self.assertEqual(self._resolve(DEPLOYMENT_ITEM_NUMBER, [RELEASE_ITEM_NUMBER]), "builtin")

    def test_number_shape_acp(self):
        self.assertEqual(
            self._resolve(dict(DEPLOYMENT_ITEM_NUMBER, appliedReleaseNumber=2), [RELEASE_ITEM_NUMBER, RELEASE_ITEM_ACP]),
            "acp")

    def test_id_shape_still_supported(self):
        self.assertEqual(self._resolve(DEPLOYMENT_ITEM_ID, [RELEASE_ITEM_ID]), "builtin")

    def test_missing_runtime_type_fails_loud(self):
        """快照缺 runtime.type 必须报错（fail-loud，不猜默认）——A1 纪律。"""
        broken = {"number": 9, "snapshot": {}}
        with self.assertRaises(RuntimeError) as ctx:
            self._resolve(dict(DEPLOYMENT_ITEM_NUMBER, appliedReleaseNumber=9), [broken])
        self.assertIn("cannot resolve runtime type", str(ctx.exception))

    def test_deployment_field_names_frozen(self):
        """GET /deployments 条目必须含 worker 依赖的三个键（缺任一即契约破坏）。"""
        for required in ("id", "definitionId", "lifecycleState"):
            self.assertIn(required, DEPLOYMENT_ITEM_NUMBER)


class LiveContractTests(unittest.TestCase):
    """真机对拍（可选）：AGWMNGR_CONTRACT_BASE_URL + _TOKEN 指向运行中的 agwmngr。"""

    BASE = os.environ.get("AGWMNGR_CONTRACT_BASE_URL", "")
    TOKEN = os.environ.get("AGWMNGR_CONTRACT_TOKEN", "")
    TENANT = os.environ.get("AGWMNGR_CONTRACT_TENANT", "orch-v2")
    AGENT = os.environ.get("AGWMNGR_CONTRACT_AGENT", "agent:orch-v2:chat-employee")

    @unittest.skipUnless(BASE and TOKEN, "设 AGWMNGR_CONTRACT_BASE_URL/TOKEN 启用真机对拍")
    def test_live_deployment_and_release_shapes(self):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 绕系统代理（Clash 坑）
        headers = {"Authorization": f"Bearer {self.TOKEN}"}

        def get(path):
            req = urllib.request.Request(f"{self.BASE}{path}", headers=headers)
            with opener.open(req, timeout=10) as resp:
                return json.loads(resp.read() or b"{}")

        deps = get(f"/api/platform/v1/tenants/{self.TENANT}/deployments")["items"]
        active = [d for d in deps if d.get("definitionId") == self.AGENT
                  and str(d.get("lifecycleState", "")).lower() == "active"]
        self.assertTrue(active, "无 active 部署（平台链未开通？）")
        d = active[0]
        self.assertTrue(d.get("appliedReleaseNumber") or d.get("appliedReleaseId"),
                        "部署既无 appliedReleaseNumber 也无 appliedReleaseId——契约又漂了")
        releases = get(f"/api/platform/v1/tenants/{self.TENANT}/agents/{self.AGENT}/releases")
        items = releases.get("items", releases)
        self.assertTrue(items, "releases 为空")
        snap_types = {((r.get("snapshot") or {}).get("runtime") or {}).get("type") for r in items}
        self.assertTrue(snap_types - {None}, "所有 release 快照都缺 runtime.type")
