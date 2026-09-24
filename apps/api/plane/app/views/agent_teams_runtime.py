# Copyright (c) 2026-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Agent Teams runtime BFF (runtime plan §12.6.7 authentication and navigation).

Exchanges the caller's Plane session for a short-lived Runtime user token:
the browser never holds a service credential, and every Runtime call is
attributed to the mapped tenant user (work_management_identity_mappings —
confirm pending proposals in the admin connections page). The assertion is
MAC'd (HMAC-SHA256, RFC 7523 profile) with the deployment-level shared secret
``RUNTIME_EXCHANGE_SECRET``; the Runtime endpoint is
``{EXPERTS_RUNTIME_BASE_URL}/api/v1/auth/exchange``.
"""

# Python imports
import hashlib
import hmac
import json
import logging
import os
import time

# Third party imports
import requests
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

# Module imports
import re

from plane.app.views.base import BaseAPIView
from plane.db.models import Webhook

# Runtime ingest callback URLs carry the connection id:
# .../work-management/plane/{connection_id}/webhooks — the authoritative link
# between a workspace and its Runtime connection (registered at setup time).
_CONNECTION_ID_IN_URL = re.compile(
    r"/work-management/plane/(work_management_connection_[0-9a-f]+)/webhooks"
)


def _runtime_webhook_for_workspace(slug):
    """Resolve (connection_id, secret) from the workspace's registered
    webhook (single source of truth — connection id and signing key both come
    from the authoritative webhook record; no deployment env copy to go
    stale). Multiple connected workspaces each map through their own webhook."""
    for webhook in Webhook.objects.filter(workspace__slug=slug, is_active=True):
        match = _CONNECTION_ID_IN_URL.search(webhook.url or "")
        if match:
            return match.group(1), webhook.secret_key
    return None, None

logger = logging.getLogger("plane.app")


def _setting(name):
    return os.environ.get(name, "").strip()


class AgentTeamsRuntimeTokenEndpoint(BaseAPIView):
    """POST /api/workspaces/{slug}/agent-teams/runtime-token/"""

    permission_classes = [IsAuthenticated]

    def post(self, request, slug):
        base_url = _setting("EXPERTS_RUNTIME_BASE_URL").rstrip("/")
        if not base_url:
            logger.error(
                "agent-teams runtime-token called without deployment env "
                "(EXPERTS_RUNTIME_BASE_URL)"
            )
            return Response(
                {"error": "Runtime exchange is not configured"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        # Connection id AND signing key come from the registered webhook
        # (see _runtime_webhook_for_workspace) — a missing webhook means the
        # workspace genuinely has no Runtime connection; surface that
        # instead of falling back to a possibly-stale configured value.
        connection_id, secret = _runtime_webhook_for_workspace(slug)
        if not connection_id or not secret:
            logger.warning(
                "agent-teams runtime-token: workspace %s has no active runtime webhook", slug
            )
            return Response(
                {"error": "This workspace is not connected to the runtime"},
                status=status.HTTP_409_CONFLICT,
            )

        now = int(time.time())
        assertion = {
            "iss": "plane-fork",
            "aud": "experts-backend",
            "sub": str(request.user.id),
            "connectionId": connection_id,
            "scopeSlug": slug,
            "displayName": request.user.display_name,
            "email": request.user.email,
            "iat": now,
            "exp": now + 60,
        }
        raw = json.dumps(assertion, sort_keys=True, separators=(",", ":")).encode()
        signature = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
        try:
            upstream = requests.post(
                f"{base_url}/api/v1/auth/exchange",
                data=raw,
                headers={
                    "Content-Type": "application/json",
                    "x-runtime-exchange-signature": signature,
                },
                timeout=10,
            )
        except requests.RequestException as exc:
            logger.error("agent-teams runtime-token upstream exchange failed: %s", exc)
            return Response(
                {"error": "Runtime exchange failed"},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        return Response(upstream.json(), status=upstream.status_code)
