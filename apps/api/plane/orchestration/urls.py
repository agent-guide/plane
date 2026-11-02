# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""编排域路由（挂 /api/workspaces/<slug>/orchestration/**）。"""

from django.urls import path

from .views import (
    ConnectionsEndpoint, ConnectionDetailEndpoint, ConnectionTestEndpoint, ConnectionResolveEndpoint,
    ApprovalsEndpoint, DagNodeFailView, DagNodeFinishView, DagNodeStartView, DagNodeView,
    EngineEventEndpoint, ProjectBindingsEndpoint, ProjectExecutionsEndpoint,
    StartExecutionEndpoint, TeamQuotaEndpoint, TeamProjectsEndpoint, TeamActiveTasksEndpoint,
    TeamAgentCatalogEndpoint, ProjectTeamPanelEndpoint, WorkItemRuntimeEndpoint,
    ProjectRuntimeOverviewEndpoint,
    ProjectWorkflowDetailEndpoint, ProjectWorkflowsEndpoint, TeamDetailEndpoint,
    TeamLifecycleEndpoint, TeamMemberDetailEndpoint, TeamMembersEndpoint,
    TeamsEndpoint, WorkflowPublishEndpoint, WorkflowVersionsEndpoint,
)

urlpatterns = [
    path("workspaces/<str:slug>/agent-teams/", TeamsEndpoint.as_view(), name="orchestration-teams"),
    path("workspaces/<str:slug>/agent-teams/approvals/", ApprovalsEndpoint.as_view(), name="orchestration-approvals"),
    path("workspaces/<str:slug>/agent-teams/approvals/<str:approval_id>/", ApprovalsEndpoint.as_view(http_method_names=["post"]), name="orchestration-approval-answer"),
    # quota / agent-catalog 必须排在 <team_id> 通配之前，否则会被当成 team_id
    path("workspaces/<str:slug>/agent-teams/agent-catalog/", TeamAgentCatalogEndpoint.as_view(), name="orchestration-agent-catalog"),
    path("workspaces/<str:slug>/agent-teams/quota/", TeamQuotaEndpoint.as_view(), name="orchestration-team-quota"),
    # 连接管理（工作区级外部系统凭据，设计 §4）
    path("workspaces/<str:slug>/connections/", ConnectionsEndpoint.as_view(), name="orchestration-connections"),
    path("workspaces/<str:slug>/connections/<str:conn_id>/", ConnectionDetailEndpoint.as_view(), name="orchestration-connection-detail"),
    path("workspaces/<str:slug>/connections/<str:conn_id>/test/", ConnectionTestEndpoint.as_view(), name="orchestration-connection-test"),
    path("internal/orchestration/connections/resolve/", ConnectionResolveEndpoint.as_view(http_method_names=["post"]), name="orchestration-connection-resolve"),
    path("workspaces/<str:slug>/agent-teams/<str:team_id>/", TeamDetailEndpoint.as_view(), name="orchestration-team-detail"),
    path("workspaces/<str:slug>/agent-teams/<str:team_id>/members/", TeamMembersEndpoint.as_view(), name="orchestration-team-members"),
    path("workspaces/<str:slug>/agent-teams/<str:team_id>/members/<str:member_id>/", TeamMemberDetailEndpoint.as_view(), name="orchestration-team-member-detail"),
    path("workspaces/<str:slug>/agent-teams/<str:team_id>/projects/", TeamProjectsEndpoint.as_view(), name="orchestration-team-projects"),
    path("workspaces/<str:slug>/agent-teams/<str:team_id>/active-tasks/", TeamActiveTasksEndpoint.as_view(), name="orchestration-team-active-tasks"),
    path("workspaces/<str:slug>/agent-teams/<str:team_id>/<str:action>/", TeamLifecycleEndpoint.as_view(), name="orchestration-team-lifecycle"),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/workflows/", ProjectWorkflowsEndpoint.as_view(), name="orchestration-workflows"),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/workflows/<str:workflow_id>/", ProjectWorkflowDetailEndpoint.as_view(), name="orchestration-workflow-detail"),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/workflows/<str:workflow_id>/versions/", WorkflowVersionsEndpoint.as_view(), name="orchestration-workflow-versions"),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/workflows/<str:workflow_id>/versions/<str:version_id>/publish/", WorkflowPublishEndpoint.as_view(), name="orchestration-workflow-publish"),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/team-bindings/", ProjectBindingsEndpoint.as_view(), name="orchestration-bindings"),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/team-panel/", ProjectTeamPanelEndpoint.as_view(), name="orchestration-team-panel"),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/runtime-overview/", ProjectRuntimeOverviewEndpoint.as_view(), name="orchestration-runtime-overview"),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/executions/", ProjectExecutionsEndpoint.as_view(), name="orchestration-executions"),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/executions/start/", StartExecutionEndpoint.as_view(), name="orchestration-execution-start"),
    path("workspaces/<str:slug>/projects/<uuid:project_id>/work-items/<uuid:issue_id>/runtime/", WorkItemRuntimeEndpoint.as_view(), name="orchestration-work-item-runtime"),
    path("internal/agent-teams/events/", EngineEventEndpoint.as_view(http_method_names=["post"]), name="orchestration-engine-events"),
]

urlpatterns += [
    path("internal/workflow-runs/<str:run_ref>/nodes/<str:node_key>/", DagNodeView.as_view(http_method_names=["get"]), name="dag-node-view"),
    path("internal/workflow-runs/<str:run_ref>/nodes/<str:node_key>/start/", DagNodeStartView.as_view(http_method_names=["post"]), name="dag-node-start"),
    path("internal/workflow-runs/<str:run_ref>/nodes/<str:node_key>/finish/", DagNodeFinishView.as_view(http_method_names=["post"]), name="dag-node-finish"),
    path("internal/workflow-runs/<str:run_ref>/nodes/<str:node_key>/fail/", DagNodeFailView.as_view(http_method_names=["post"]), name="dag-node-fail"),
]
