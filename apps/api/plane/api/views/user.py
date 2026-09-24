# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party imports
from rest_framework import status
from rest_framework.response import Response
from drf_spectacular.utils import OpenApiResponse

# Module imports
from rest_framework.response import Response

from plane.api.serializers import UserLiteSerializer
from plane.api.views.base import BaseAPIView
from plane.db.models import User, WorkspaceMember
from plane.utils.openapi.decorators import user_docs
from plane.utils.openapi import USER_EXAMPLE


class UserEndpoint(BaseAPIView):
    serializer_class = UserLiteSerializer
    model = User

    @user_docs(
        operation_id="get_current_user",
        summary="Get current user",
        description="Retrieve the authenticated user's profile information including basic details.",
        responses={
            200: OpenApiResponse(
                description="Current user profile",
                response=UserLiteSerializer,
                examples=[USER_EXAMPLE],
            ),
        },
    )
    def get(self, request):
        """Get current user

        Retrieve the authenticated user's profile information including basic details.
        Returns user data based on the current authentication context.
        """
        serializer = UserLiteSerializer(request.user)
        return Response(serializer.data, status=status.HTTP_200_OK)


class UserWorkspacesEndpoint(BaseAPIView):
    """Agent Team Runtime extension: workspaces visible to the API key's user.

    Backs the runtime console's guided connection setup — the operator pastes
    a personal access token and picks the workspaces to connect; this is the
    only external-API surface that lists them (the session endpoint is
    cookie-only)."""

    def get(self, request):
        members = (
            WorkspaceMember.objects.filter(
                member=request.user, is_active=True, workspace__deleted_at__isnull=True
            )
            .select_related("workspace")
            .order_by("workspace__name")
        )
        return Response(
            [
                {
                    "slug": member.workspace.slug,
                    "name": member.workspace.name,
                    "role": member.role,
                }
                for member in members
            ]
        )
