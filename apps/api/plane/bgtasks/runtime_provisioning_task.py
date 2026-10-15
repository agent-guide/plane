# Copyright (c) 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE.txt file in the repository root for details.

"""Agent Teams runtime 工作区成员供给通知（设计 2026-10-14 §5.1，ADR 0012）。

fork 侧 WorkspaceMember 变更（加入/移出/删除/改名）→ 调 runtime 供给端点。
信任链复用 §12.6.7：连接 id 与签名密钥取自工作区登记的 runtime webhook
（无 webhook = 未接入该 runtime，跳过即静默）；Celery 异步执行、
失败重试 ×3 指数退避——供给永不阻塞成员变更本身，最终丢失由 runtime
exchange 首访兜底（通道②）。
"""

# Python imports
import hashlib
import hmac
import json
import logging
import os
import re
import time

# Third party imports
import requests
from celery import shared_task

# Django imports
from plane.db.models import User, Webhook

logger = logging.getLogger("plane.worker")

# Runtime ingest callback URLs carry the connection id（与 agent_teams_runtime
# 同一约定：连接 id 与密钥同源于权威 webhook 记录）。
_CONNECTION_ID_IN_URL = re.compile(
    r"/work-management/plane/(work_management_connection_[0-9a-f]+)/webhooks"
)


def _runtime_webhook_for_workspace(slug):
    for webhook in Webhook.objects.filter(workspace__slug=slug, is_active=True):
        match = _CONNECTION_ID_IN_URL.search(webhook.url or "")
        if match:
            return match.group(1), webhook.secret_key
    return None, None


def notify_runtime_member(*, workspace_slug, user_id, action):
    """成员变更入口：解析连接后异步入队；未接入/无用户静默跳过。

    action: provision（加入/改名/复活，runtime 侧幂等区分）| deactivate（移出/删除）。
    """
    if action not in ("provision", "deactivate"):
        raise ValueError(f"unknown provisioning action: {action}")
    user = User.objects.filter(pk=user_id).first()
    if user is None:
        return
    if user.is_bot:
        # 机器人不是人类成员（10-15 实证：runtime 供给的团队 bot 加入工作区
        # 时同样触发成员钩子，误同步成租户用户）。bot 的 runtime 侧身份由
        # ADR 0011 服务凭据供给，不走人类成员通道。
        return
    connection_id, _secret = _runtime_webhook_for_workspace(workspace_slug)
    if not connection_id:
        # 工作区未接入 runtime：不是错误，静默跳过（首访兜底也轮不到它）。
        return
    provision_workspace_member.delay(
        workspace_slug=workspace_slug,
        user_id=str(user_id),
        action=action,
    )


def notify_runtime_user_everywhere(*, user_id, action):
    """用户级变更（改名/删除）广播到其全部接入工作区（每个 scope 一条
    映射，runtime 侧按 (connection, scope, user) 幂等区分）。"""
    from plane.db.models import WorkspaceMember

    slugs = list(
        WorkspaceMember.objects.filter(
            member_id=user_id, is_active=True
        ).values_list("workspace__slug", flat=True)
    )
    for slug in slugs:
        notify_runtime_member(workspace_slug=slug, user_id=user_id, action=action)


def enqueue_on_commit(**kwargs):
    """事务提交后再入队：Celery worker 与视图事务并发时避免读到未提交
    的成员行（非事务上下文 on_commit 立即执行，行为不变）。"""
    from django.db import transaction

    transaction.on_commit(lambda: notify_runtime_member(**kwargs))


@shared_task(
    bind=True,
    max_retries=3,
    autoretry_for=(requests.RequestException,),
    retry_backoff=2,
    retry_jitter=False,
)
def provision_workspace_member(self, *, workspace_slug, user_id, action):
    base_url = os.environ.get("EXPERTS_RUNTIME_BASE_URL", "").strip().rstrip("/")
    if not base_url:
        logger.error(
            "runtime provisioning called without deployment env (EXPERTS_RUNTIME_BASE_URL)"
        )
        return
    connection_id, secret = _runtime_webhook_for_workspace(workspace_slug)
    if not connection_id or not secret:
        logger.warning(
            "runtime provisioning: workspace %s lost its runtime webhook", workspace_slug
        )
        return
    try:
        user = User.objects.get(pk=user_id)
    except User.DoesNotExist:
        return  # 用户已删除且 deactivate 已由删除钩子触发

    now = int(time.time())
    assertion = {
        "iss": "plane-fork",
        "aud": "experts-backend",
        "sub": str(user.id),
        "connectionId": connection_id,
        "scopeSlug": workspace_slug,
        "email": user.email or "",
        "name": user.display_name or "",
        "action": action,
        "iat": now,
        "exp": now + 60,
    }
    raw = json.dumps(assertion, sort_keys=True, separators=(",", ":")).encode()
    signature = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    response = requests.post(
        f"{base_url}/api/v1/work-management-connections/{connection_id}/provision",
        data=raw,
        headers={
            "Content-Type": "application/json",
            "x-runtime-exchange-signature": signature,
        },
        timeout=10,
    )
    # 4xx = runtime 明确拒绝（范围外/断言问题/限流部分场景），重试无意义；
    # 5xx/网络异常交给 Celery autoretry；重试耗尽由通道②首访兜底。
    if response.status_code >= 400 and response.status_code < 500:
        logger.error(
            "runtime provisioning rejected (workspace=%s user=%s action=%s): %s %s",
            workspace_slug,
            user_id,
            action,
            response.status_code,
            response.text[:300],
        )
        return
    response.raise_for_status()
    logger.info(
        "runtime provisioning ok (workspace=%s user=%s action=%s): %s",
        workspace_slug,
        user_id,
        action,
        response.text[:200],
    )
