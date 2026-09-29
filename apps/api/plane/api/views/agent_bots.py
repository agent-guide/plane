# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file in the repository root for details.

"""Agent-runtime bot provisioning (external API, ADR 0011 bot 供给域).

POST /api/v1/workspaces/{slug}/agent-bots/ creates (idempotently) a bot
user for a named runtime agent and adds it to the workspace at member
role. The runtime calls this when binding a team so each agent member
gets a card-visible identity (assignee projection) without any manual
account seeding.
"""

# Django imports
from urllib.parse import urlparse
from django.db import transaction
from django.contrib.auth.hashers import make_password
from django.utils.text import slugify

# Third party imports
from rest_framework import status
from rest_framework.response import Response

# Module imports
from plane.api.views.base import BaseAPIView
from plane.app.permissions.workspace import WorkSpaceAdminPermission
from plane.db.models import User, Workspace, WorkspaceMember
from django.conf import settings
import uuid


def _host() -> str:
    return urlparse(settings.WEB_URL or "https://plane.so").hostname or "plane.so"


class AgentBotListCreateEndpoint(BaseAPIView):
    """List provisioned agent bots or idempotently provision one.

    Body: {"name": "<agent display name>", "username_suffix": "<optional stable slug>"}
    The stable email is agent-<suffix-or-slugified-name>@<web host>; re-POSTing
    the same identity returns the existing bot (200) instead of creating a
    duplicate, so the runtime can call it on every binding.
    """

    permission_classes = [WorkSpaceAdminPermission]

    def get(self, request, slug):
        bots = User.objects.filter(
            is_bot=True,
            email__startswith="agent-",
            email__endswith=f"@{_host()}",
            workspace_member__workspace__slug=slug,
        ).values("id", "username", "display_name", "email")
        return Response({"bots": list(bots)}, status=status.HTTP_200_OK)

    @transaction.atomic
    def post(self, request, slug):
        name = (request.data.get("name") or "").strip()
        suffix = (request.data.get("username_suffix") or "").strip() or slugify(name)
        if not name or not suffix:
            return Response(
                {"error": "name is required"}, status=status.HTTP_400_BAD_REQUEST
            )
        workspace = Workspace.objects.get(slug=slug)
        host = _host()
        email = f"agent-{suffix}@{host}"
        bot = User.objects.filter(email=email).first()
        created = False
        if bot is None:
            bot = User.objects.create(
                username=f"agent_{suffix}",
                display_name=name,
                first_name=name,
                last_name="",
                is_bot=True,
                email=email,
                password=make_password(uuid.uuid4().hex),
                is_password_autoset=True,
            )
            created = True
        WorkspaceMember.objects.get_or_create(
            workspace=workspace,
            member=bot,
            defaults={"role": 20, "company_role": ""},
        )
        return Response(
            {
                "id": str(bot.id),
                "username": bot.username,
                "display_name": bot.display_name,
                "email": bot.email,
                "created": created,
            },
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )
