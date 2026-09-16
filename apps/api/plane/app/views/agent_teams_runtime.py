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
from plane.app.views.base import BaseAPIView

logger = logging.getLogger("plane.app")


def _setting(name):
    return os.environ.get(name, "").strip()


class AgentTeamsRuntimeTokenEndpoint(BaseAPIView):
    """POST /api/workspaces/{slug}/agent-teams/runtime-token/"""

    permission_classes = [IsAuthenticated]

    def post(self, request, slug):
        base_url = _setting("EXPERTS_RUNTIME_BASE_URL").rstrip("/")
        secret = _setting("RUNTIME_EXCHANGE_SECRET")
        connection_id = _setting("RUNTIME_CONNECTION_ID")
        if not base_url or not secret or not connection_id:
            logger.error(
                "agent-teams runtime-token called without deployment env "
                "(EXPERTS_RUNTIME_BASE_URL/RUNTIME_EXCHANGE_SECRET/RUNTIME_CONNECTION_ID)"
            )
            return Response(
                {"error": "Runtime exchange is not configured"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
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
