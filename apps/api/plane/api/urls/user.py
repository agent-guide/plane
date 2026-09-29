# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file in the repository root for details.

from django.urls import path

from plane.api.views import AgentBotListCreateEndpoint, UserEndpoint, UserWorkspacesEndpoint

urlpatterns = [
    path(
        "users/me/",
        UserEndpoint.as_view(http_method_names=["get"]),
        name="users",
    ),
    # Agent Team Runtime extension: workspace list for the API-key user
    # (guided connection setup in the runtime console).
    path(
        "users/me/workspaces/",
        UserWorkspacesEndpoint.as_view(http_method_names=["get"]),
        name="user-workspaces",
    ),
    # Agent Team Runtime extension: idempotent agent-bot provisioning
    # (assignee identity per agent member; ADR 0011 bot supply domain).
    path(
        "workspaces/<str:slug>/agent-bots/",
        AgentBotListCreateEndpoint.as_view(http_method_names=["get", "post"]),
        name="agent-bots",
    ),
]
