# Copyright (c) 2026-present Plane Software, Inc. and contributors.
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path

from plane.app.views.agent_teams_runtime import AgentTeamsRuntimeTokenEndpoint

urlpatterns = [
    path(
        "workspaces/<str:slug>/agent-teams/runtime-token/",
        AgentTeamsRuntimeTokenEndpoint.as_view(http_method_names=["post"]),
        name="agent-teams-runtime-token",
    ),
]
