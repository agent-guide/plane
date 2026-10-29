# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""agwmngr Agent 目录查询（跨服务引用取显示名，读时聚合方案）。

- 凭证用 agwmngr 服务凭证（agwmngr_svc_*，env AGWMNGR_TENANT_TOKEN），
  非登录 session token（7 天过期，不能做服务间凭证）
- 失败降级：任何异常返回空映射，调用方显示回退值（成员页暂显「—」），
  不影响页面其他数据——agwmngr 可用性不拖垮编排域读路径
- 无缓存（当前读频个位数；将来升级 read-through 缓存只改本模块）
"""

import json
import os
import urllib.request


def _config() -> tuple[str, str, str] | None:
    base = os.environ.get("AGWMNGR_BASE_URL", "").rstrip("/")
    token = os.environ.get("AGWMNGR_TENANT_TOKEN", "")
    tenant = os.environ.get("AGWMNGR_TENANT_ID", "")
    if not (base and token and tenant):
        return None
    return base, token, tenant


def resolve_agent_names(definition_ids) -> dict[str, str]:
    """批量取 agent 显示名（definition id → draft.name，缺名回退 slug）。

    未配置 env 或 agwmngr 不可达 → 空映射（调用方自行降级）。
    """
    ids = set(definition_ids)
    if not ids:
        return {}
    cfg = _config()
    if cfg is None:
        return {}
    base, token, tenant = cfg
    try:
        req = urllib.request.Request(
            f"{base}/api/platform/v1/tenants/{tenant}/agents",
            headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=5) as response:
            items = json.loads(response.read() or b"{}").get("items") or []
    except Exception:
        return {}
    names: dict[str, str] = {}
    for item in items:
        agent_id = item.get("id")
        if agent_id in ids:
            draft = item.get("draft") or {}
            names[agent_id] = draft.get("name") or item.get("slug") or agent_id
    return names


def list_catalog() -> list[dict] | None:
    """租户 agent 目录（加成员候选列表）。未配置/不可达 → None（前端显空态）。"""
    cfg = _config()
    if cfg is None:
        return None
    base, token, tenant = cfg
    try:
        req = urllib.request.Request(
            f"{base}/api/platform/v1/tenants/{tenant}/agents",
            headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=5) as response:
            items = json.loads(response.read() or b"{}").get("items") or []
    except Exception:
        return None
    return [{
        "id": item.get("id"),
        "name": (item.get("draft") or {}).get("name") or item.get("slug") or item.get("id"),
        "description": (item.get("draft") or {}).get("description") or "",
    } for item in items]
