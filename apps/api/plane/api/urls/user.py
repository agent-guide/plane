# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path

from plane.api.views import UserEndpoint, UserWorkspacesEndpoint

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
]
