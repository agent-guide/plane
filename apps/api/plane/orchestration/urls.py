# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""编排域路由（挂 /api/workspaces/<slug>/orchestration/**）。"""

from django.urls import path

from .views import (
    ApprovalsEndpoint, ProjectBindingsEndpoint, ProjectExecutionsEndpoint,
    ProjectWorkflowDetailEndpoint, ProjectWorkflowsEndpoint, TeamDetailEndpoint,
    TeamLifecycleEndpoint, TeamMemberDetailEndpoint, TeamMembersEndpoint,
    TeamsEndpoint, WorkflowPublishEndpoint, WorkflowVersionsEndpoint,
)

urlpatterns = [
    path("workspaces/<str:slug>/orchestration/teams/", TeamsEndpoint.as_view(), name="orchestration-teams"),
    path("workspaces/<str:slug>/orchestration/teams/<str:team_id>/", TeamDetailEndpoint.as_view(), name="orchestration-team-detail"),
    path("workspaces/<str:slug>/orchestration/teams/<str:team_id>/members/", TeamMembersEndpoint.as_view(), name="orchestration-team-members"),
    path("workspaces/<str:slug>/orchestration/teams/<str:team_id>/members/<str:member_id>/", TeamMemberDetailEndpoint.as_view(), name="orchestration-team-member-detail"),
    path("workspaces/<str:slug>/orchestration/teams/<str:team_id>/<str:action>/", TeamLifecycleEndpoint.as_view(), name="orchestration-team-lifecycle"),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/orchestration/workflows/", ProjectWorkflowsEndpoint.as_view(), name="orchestration-workflows"),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/orchestration/workflows/<str:workflow_id>/", ProjectWorkflowDetailEndpoint.as_view(), name="orchestration-workflow-detail"),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/orchestration/workflows/<str:workflow_id>/versions/", WorkflowVersionsEndpoint.as_view(), name="orchestration-workflow-versions"),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/orchestration/workflows/<str:workflow_id>/versions/<str:version_id>/publish/", WorkflowPublishEndpoint.as_view(), name="orchestration-workflow-publish"),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/orchestration/bindings/", ProjectBindingsEndpoint.as_view(), name="orchestration-bindings"),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/orchestration/executions/", ProjectExecutionsEndpoint.as_view(), name="orchestration-executions"),
    path("workspaces/<str:slug>/orchestration/approvals/", ApprovalsEndpoint.as_view(), name="orchestration-approvals"),
    path("workspaces/<str:slug>/orchestration/approvals/<str:approval_id>/", ApprovalsEndpoint.as_view(http_method_names=["post"]), name="orchestration-approval-answer"),
]
