# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""编排域 API（阶段 2′）——服务层的 HTTP 适配（薄壳）。

设计：路由挂 /api/workspaces/<slug>/orchestration/** 与
/api/workspaces/<slug>/projects/<project_id>/orchestration/**；
认证走 Plane 会话（BaseAPIView IsAuthenticated）；权限谓词由服务层执行
（is_admin 从 WorkspaceMember 角色推导）。
"""

from django.contrib.auth import get_user_model
from django.utils import timezone

from plane.app.views.base import BaseAPIView
from plane.db.models.workspace import ROLE_CHOICES, WorkspaceMember
from plane.db.models.project import Project
from plane.db.models.workspace import Workspace

from rest_framework.response import Response

from . import services, workflows
from .models import (
    AgentTeam, AgentTeamMember, BusinessApproval, ProjectTeamBinding,
    WorkItemExecution, WorkflowDefinition, WorkflowVersion,
)
from .services import TeamDomainError

User = get_user_model()


def _is_workspace_admin(user, slug) -> bool:
    try:
        member = WorkspaceMember.objects.select_related("workspace").get(workspace__slug=slug, member=user)
        admin_value = dict(ROLE_CHOICES).keys() and 20  # Admin=20（ROLE_CHOICES 同表）
        return member.role == admin_value
    except WorkspaceMember.DoesNotExist:
        return False


def _error_response(exc: TeamDomainError):
    return Response({"error": exc.message, "code": exc.code}, status=exc.status)


def _team_json(team: AgentTeam, with_members: bool = False, user=None, is_admin: bool | None = None,
               agent_names: dict[str, str] | None = None):
    data = {
        "id": team.id, "name": team.name, "objective": team.objective,
        "status": team.status,
        "createdBy": User.objects.filter(id=team.created_by_id)
        .values_list("display_name", flat=True).first(),
        "createdAt": team.created_at.isoformat(), "updatedAt": team.updated_at.isoformat(),
    }
    # 列表卡信号行（与旧系统 agent_team_repository 同语义）：
    # 成员数=enabled；活跃任务=非终态执行；运行中=running 执行。
    # 仅在列表端点 annotate 过 counts 时填充（_team_json 也被无注解的详情复用）。
    if hasattr(team, "member_count"):
        data["memberCount"] = team.member_count
        data["activeTaskCount"] = team.active_task_count
        data["runningRunCount"] = team.running_run_count
    # 管理动作可见性（前端只做展示，安全边界仍在服务层谓词）；
    # user/is_admin 由端点成对传入
    if user is not None and is_admin is not None:
        data["viewerCanManage"] = bool(is_admin) or team.created_by_id == user.id
        data["viewerIsAdmin"] = bool(is_admin)
    if with_members:
        data["members"] = [
            _member_json(m, agent_names) for m in team.members.order_by("sequence", "created_at")]
    return data


def _member_json(m: AgentTeamMember, agent_names: dict[str, str] | None = None):
    names = agent_names or {}
    # 显示名：人类取 Plane 用户名；数字员工经 agwmngr 目录读时聚合（失败回退 None）
    if m.kind == "human":
        display = User.objects.filter(id=m.user_id).values_list("display_name", flat=True).first()
    else:
        display = names.get(m.agent_definition_id)
    return {
        "id": m.id, "kind": m.kind,
        "userId": m.user_id, "agentDefinitionId": m.agent_definition_id,
        "displayName": display,
        "role": m.role, "capabilities": m.capabilities, "sequence": m.sequence,
        "enabled": m.enabled, "updatedAt": m.updated_at.isoformat(),
    }


def _workflow_json(wf: WorkflowDefinition, with_summary: bool = False):
    data = {
        "id": wf.id, "name": wf.name, "description": wf.description,
        "engineKind": wf.engine_kind, "draft": wf.draft,
        "createdAt": wf.created_at.isoformat(), "updatedAt": wf.updated_at.isoformat(),
    }
    if with_summary:
        # 列表卡状态：最新版本状态；currentVersion = 最新已发布版本号
        latest = wf.versions.order_by("-version").first()
        published = wf.versions.filter(
            status=WorkflowVersion.Status.PUBLISHED).order_by("-version").first()
        data["status"] = latest.status if latest else "draft"
        data["currentVersion"] = published.version if published else None
    return data


def _version_json(v: WorkflowVersion):
    return {
        "id": v.id, "version": v.version, "status": v.status,
        "contentHash": v.content_hash, "publishedAt": v.published_at.isoformat() if v.published_at else None,
    }


def _binding_json(b: ProjectTeamBinding):
    return {
        "id": b.id, "projectId": b.project_id, "teamId": b.team_id,
        "workflowVersionId": b.workflow_version_id, "status": b.status,
        "updatedAt": b.updated_at.isoformat(),
    }


def _approval_json(a: BusinessApproval):
    """审批列表/详情一体（旧收件箱列表+详情两次取数，新域一次给全）。"""
    e = a.execution
    return {
        "id": a.id, "executionId": a.execution_id, "nodeRef": a.node_ref,
        "question": a.question, "options": a.options, "freeText": a.free_text,
        "result": a.result, "reason": a.reason,
        "answeredAt": a.answered_at.isoformat() if a.answered_at else None,
        "createdAt": a.created_at.isoformat(),
        # 消费面（卡片列表/详情头）：团队与工作项上下文
        "teamId": e.binding.team_id, "teamName": e.binding.team.name,
        "projectId": str(e.issue.project_id), "issueId": e.issue_id, "taskTitle": e.issue.name,
    }


def _upcoming_steps(execution: WorkItemExecution) -> list[str]:
    """叙事流未来步骤名（剪枝感知）：定义序中未开始的节点，减去被条件淘汰的分支。"""
    from .execution_context import pruned_node_keys
    from .node_runtime import NodeRuntimeRecord
    definition = (execution.binding.workflow_version.definition or {})
    started = set(execution.node_records.values_list("node_key", flat=True))
    choices = {
        node_key: chosen for node_key, chosen in NodeRuntimeRecord.objects.filter(
            execution=execution, status=NodeRuntimeRecord.Status.SUCCESS,
        ).values_list("node_key", "result__chosenBranch") if chosen}
    pruned = pruned_node_keys(definition, choices) if choices else set()
    return [
        (n.get("name") or n.get("key"))
        for n in (definition.get("nodes") or [])
        if n.get("key") not in started and n.get("key") not in pruned and n.get("type") != "condition"
    ]


def _execution_json(e: WorkItemExecution):
    return {
        "id": e.id, "issueId": e.issue_id, "bindingId": e.binding_id,
        "businessStatus": e.business_status, "currentMemberId": e.current_member_id,
        "engineRunRef": e.engine_run_ref, "version": e.transition_version,
        "completedAt": e.completed_at.isoformat() if e.completed_at else None,
        "updatedAt": e.updated_at.isoformat(),
    }


class TeamsEndpoint(BaseAPIView):
    def get(self, request, slug):
        from django.db.models import Count, Q
        teams = (
            AgentTeam.objects.filter(workspace__slug=slug)
            .annotate(
                member_count=Count("members", filter=Q(members__enabled=True), distinct=True),
                active_task_count=Count(
                    "project_bindings__executions",
                    filter=~Q(project_bindings__executions__business_status__in=["failed", "completed", "cancelled"]),
                    distinct=True),
                running_run_count=Count(
                    "project_bindings__executions",
                    filter=Q(project_bindings__executions__business_status="running"),
                    distinct=True),
            )
            .order_by("-created_at")
        )
        is_admin = _is_workspace_admin(request.user, slug)
        return Response([_team_json(t, user=request.user, is_admin=is_admin) for t in teams])

    def post(self, request, slug):
        try:
            is_admin = _is_workspace_admin(request.user, slug)
            team = services.create_team(
                workspace_id=Workspace.objects.get(slug=slug).id,
                user_id=request.user.id,
                is_admin=_is_workspace_admin(request.user, slug),
                name=request.data.get("name", ""),
                objective=request.data.get("objective", ""),
            )
            return Response(_team_json(team, user=request.user, is_admin=is_admin), status=201)
        except TeamDomainError as exc:
            return _error_response(exc)
        except Workspace.DoesNotExist:
            return Response({"error": "workspace not found"}, status=404)


class TeamAgentCatalogEndpoint(BaseAPIView):
    """加成员候选：租户 agent 目录（经 agwmngr 读时聚合；不可达返回 503 语义空列表）。"""

    def get(self, request, slug):
        from .agent_directory import list_catalog
        catalog = list_catalog()
        if catalog is None:
            return Response({"error": "agent catalog unavailable", "code": "AGENT_CATALOG_UNAVAILABLE"}, status=503)
        return Response(catalog)


class TeamQuotaEndpoint(BaseAPIView):
    """配额提示（新建弹层预取）：管理员 bypass，普通成员数自己非归档团队。"""

    def get(self, request, slug):
        is_admin = _is_workspace_admin(request.user, slug)
        quota = services._quota()
        owned = AgentTeam.objects.filter(
            workspace__slug=slug, created_by=request.user
        ).exclude(status=AgentTeam.Status.ARCHIVED).count()
        return Response({
            "applies": not is_admin,
            "quota": quota,
            "owned": owned,
            "remaining": max(quota - owned, 0) if not is_admin else None,
        })


def _agent_names_for(team: AgentTeam) -> dict[str, str]:
    """团队的数字成员定义名（一次批量查询，读时聚合）。"""
    from .agent_directory import resolve_agent_names
    ids = team.members.filter(kind=AgentTeamMember.Kind.AGENT).values_list("agent_definition_id", flat=True)
    return resolve_agent_names(ids)


class TeamDetailEndpoint(BaseAPIView):
    def _get(self, slug, team_id) -> AgentTeam | None:
        return AgentTeam.objects.filter(workspace__slug=slug, id=team_id).first()

    def get(self, request, slug, team_id):
        team = self._get(slug, team_id)
        if not team:
            return Response({"error": "not found"}, status=404)
        return Response(_team_json(
            team, with_members=True, user=request.user,
            is_admin=_is_workspace_admin(request.user, slug),
            agent_names=_agent_names_for(team)))

    def patch(self, request, slug, team_id):
        team = self._get(slug, team_id)
        if not team:
            return Response({"error": "not found"}, status=404)
        try:
            services.update_team(
                team=team, user_id=request.user.id,
                is_admin=_is_workspace_admin(request.user, slug),
                name=request.data.get("name"), objective=request.data.get("objective"),
            )
            return Response(_team_json(team))
        except TeamDomainError as exc:
            return _error_response(exc)


class TeamLifecycleEndpoint(BaseAPIView):
    """activate / archive（动作路由）。"""

    def post(self, request, slug, team_id, action):
        team = AgentTeam.objects.filter(workspace__slug=slug, id=team_id).first()
        if not team:
            return Response({"error": "not found"}, status=404)
        is_admin = _is_workspace_admin(request.user, slug)
        try:
            if action == "activate":
                services.activate_team(team=team, user_id=request.user.id, is_admin=is_admin)
            elif action == "archive":
                services.archive_team(team=team, is_admin=is_admin)
            else:
                return Response({"error": "unknown action"}, status=400)
            return Response(_team_json(team, user=request.user, is_admin=is_admin))
        except TeamDomainError as exc:
            return _error_response(exc)


class TeamMembersEndpoint(BaseAPIView):
    def get(self, request, slug, team_id):
        team = AgentTeam.objects.filter(workspace__slug=slug, id=team_id).first()
        if not team:
            return Response({"error": "not found"}, status=404)
        names = _agent_names_for(team)
        return Response([_member_json(m, names) for m in team.members.order_by("sequence", "created_at")])

    def post(self, request, slug, team_id):
        team = AgentTeam.objects.filter(workspace__slug=slug, id=team_id).first()
        if not team:
            return Response({"error": "not found"}, status=404)
        try:
            member = services.add_member(
                team=team, user_id=request.user.id,
                is_admin=_is_workspace_admin(request.user, slug),
                kind=request.data.get("kind", "human"), role=request.data.get("role", ""),
                user_ref=request.data.get("userId"),
                agent_definition_id=request.data.get("agentDefinitionId", ""),
                capabilities=request.data.get("capabilities", []),
                sequence=int(request.data.get("sequence", 1)),
            )
            # 建成员响应同样聚合目录名（前端即时展示不显示空名）
            return Response(_member_json(member, _agent_names_for(team) if member.kind == "agent" else None), status=201)
        except TeamDomainError as exc:
            return _error_response(exc)


class TeamMemberDetailEndpoint(BaseAPIView):
    def patch(self, request, slug, team_id, member_id):
        team = AgentTeam.objects.filter(workspace__slug=slug, id=team_id).first()
        member = AgentTeamMember.objects.filter(team=team, id=member_id).first() if team else None
        if not member:
            return Response({"error": "not found"}, status=404)
        try:
            services.update_member(
                team=team, member=member, user_id=request.user.id,
                is_admin=_is_workspace_admin(request.user, slug),
                role=request.data.get("role"), capabilities=request.data.get("capabilities"),
                sequence=int(request.data["sequence"]) if request.data.get("sequence") else None,
                enabled=request.data.get("enabled"),
            )
            return Response(_member_json(member))
        except TeamDomainError as exc:
            return _error_response(exc)

    def delete(self, request, slug, team_id, member_id):
        team = AgentTeam.objects.filter(workspace__slug=slug, id=team_id).first()
        member = AgentTeamMember.objects.filter(team=team, id=member_id).first() if team else None
        if not member:
            return Response({"error": "not found"}, status=404)
        try:
            services.remove_member(team=team, member=member, user_id=request.user.id,
                                   is_admin=_is_workspace_admin(request.user, slug))
            return Response(status=204)
        except TeamDomainError as exc:
            return _error_response(exc)


class TeamProjectsEndpoint(BaseAPIView):
    """团队详情页「关联项目」：绑定全量返回（测试环境量级个位数，不分页）。"""

    def get(self, request, slug, team_id):
        bindings = ProjectTeamBinding.objects.filter(
            team__workspace__slug=slug, team_id=team_id,
        ).select_related("project", "workflow_version", "workflow_version__workflow").order_by("-created_at")
        return Response([{
            "projectId": b.id,
            "externalProjectId": str(b.project_id),
            "projectName": b.project.name,
            "workflowName": b.workflow_version.workflow.name if b.workflow_version else None,
            "workflowVersion": b.workflow_version.version if b.workflow_version else None,
            "status": b.status,
        } for b in bindings])


class TeamActiveTasksEndpoint(BaseAPIView):
    """团队详情页「进行中工作项」：本团队绑定下的非终态执行。

    字段对齐旧 AgentTeamActiveTask 消费面（taskBindingId 作 key、
    external* 供 Plane 路由跳转、controlStatus 即 business_status）。
    """

    def get(self, request, slug, team_id):
        from .state_machine import TERMINAL_STATUSES
        executions = WorkItemExecution.objects.filter(
            binding__team__workspace__slug=slug, binding__team_id=team_id,
        ).exclude(business_status__in=list(TERMINAL_STATUSES)).select_related(
            "issue", "issue__project", "current_member", "current_member__user",
        ).order_by("-updated_at")
        # 数字成员显示名：对本团队做一次目录批量查询
        team = AgentTeam.objects.filter(workspace__slug=slug, id=team_id).only("id").first()
        names = _agent_names_for(team) if team else {}
        items = []
        for e in executions:
            member = e.current_member
            member_name = None
            if member is not None:
                # 人类成员取 Plane 显示名；数字成员经 agwmngr 目录（失败为 None → 前端显「—」）
                if member.kind == "human":
                    member_name = member.user.display_name if member.user else None
                else:
                    member_name = names.get(member.agent_definition_id)
            items.append({
                "taskBindingId": e.id,
                "issueId": e.issue_id,
                "externalProjectId": str(e.issue.project_id),
                "externalItemId": str(e.issue_id),
                "taskName": e.issue.name,
                "controlStatus": e.business_status,
                # 工作项状态（与工作项列表显示同源：名+色徽章）
                "stateName": e.issue.state.name if e.issue.state_id else None,
                "stateColor": e.issue.state.color if e.issue.state_id else None,
                "stateGroup": e.issue.state.group if e.issue.state_id else None,
                "projectName": e.issue.project.name,
                "activeMemberName": member_name,
                "updatedAt": e.updated_at.isoformat(),
            })
        return Response(items)



class ProjectWorkflowsEndpoint(BaseAPIView):
    def get(self, request, slug, project_id):
        wfs = WorkflowDefinition.objects.filter(project__workspace__slug=slug, project_id=project_id)
        return Response([_workflow_json(wf, with_summary=True) for wf in wfs])

    def post(self, request, slug, project_id):
        project = Project.objects.filter(workspace__slug=slug, id=project_id).first()
        if not project:
            return Response({"error": "not found"}, status=404)
        # 成员收敛 §3.2 建流程闸门：先绑团队才能编流程（成员选择以绑定团队为范围）
        if not ProjectTeamBinding.objects.filter(
                project_id=project_id, status=ProjectTeamBinding.Status.ACTIVE).exists():
            return Response({"error": "Project has no active team binding. Assign a team before creating workflows.",
                             "code": "PROJECT_NOT_BOUND"}, status=409)
        try:
            wf = workflows.create_workflow(
                project=project, user_id=request.user.id,
                name=request.data.get("name", ""), description=request.data.get("description", ""),
            )
            return Response(_workflow_json(wf), status=201)
        except TeamDomainError as exc:
            return _error_response(exc)


class ProjectWorkflowDetailEndpoint(BaseAPIView):
    def _get(self, slug, project_id, workflow_id):
        return WorkflowDefinition.objects.filter(
            project__workspace__slug=slug, project_id=project_id, id=workflow_id).first()

    def get(self, request, slug, project_id, workflow_id):
        wf = self._get(slug, project_id, workflow_id)
        if not wf:
            return Response({"error": "not found"}, status=404)
        versions = [_version_json(v) for v in wf.versions.order_by("-version")]
        return Response({**_workflow_json(wf), "versions": versions})

    def patch(self, request, slug, project_id, workflow_id):
        wf = self._get(slug, project_id, workflow_id)
        if not wf:
            return Response({"error": "not found"}, status=404)
        try:
            if "draft" in request.data:
                workflows.update_draft(workflow=wf, user_id=request.user.id, draft=request.data["draft"])
            if request.data.get("name"):
                wf.name = request.data["name"].strip()
            if "description" in request.data:
                wf.description = request.data.get("description") or ""
            wf.save(update_fields=["name", "description", "updated_at"])
            return Response(_workflow_json(wf))
        except TeamDomainError as exc:
            return _error_response(exc)

    def delete(self, request, slug, project_id, workflow_id):
        """删除流程定义：仍有活跃绑定引用其任一版本时拒绝（fail-closed）。"""
        wf = self._get(slug, project_id, workflow_id)
        if not wf:
            return Response({"error": "not found"}, status=404)
        from plane.orchestration.models import ProjectTeamBinding
        referenced = ProjectTeamBinding.objects.filter(
            workflow_version__workflow=wf, status=ProjectTeamBinding.Status.ACTIVE).exists()
        if referenced:
            return Response({"error": "workflow is bound to a project team",
                             "code": "WORKFLOW_IN_USE"}, status=409)
        wf.delete()
        return Response(status=204)


class WorkflowVersionsEndpoint(BaseAPIView):
    def post(self, request, slug, project_id, workflow_id):
        """存草稿版本（发布前置）。"""
        wf = WorkflowDefinition.objects.filter(
            project__workspace__slug=slug, project_id=project_id, id=workflow_id).first()
        if not wf:
            return Response({"error": "not found"}, status=404)
        try:
            version = workflows.save_draft_version(workflow=wf, user_id=request.user.id)
            return Response(_version_json(version), status=201)
        except TeamDomainError as exc:
            return _error_response(exc)


class WorkflowPublishEndpoint(BaseAPIView):
    def post(self, request, slug, project_id, workflow_id, version_id):
        wf = WorkflowDefinition.objects.filter(
            project__workspace__slug=slug, project_id=project_id, id=workflow_id).first()
        if not wf:
            return Response({"error": "not found"}, status=404)
        try:
            version = workflows.start_publish(workflow=wf, user_id=request.user.id)
            # 引擎已配置（ORCHESTRATION_AIRFLOW_*）→ 真实发布链：渲染落盘→轮询就绪→激活
            # 未配置（本地无引擎）→ 过渡直接 finish（engine_deploy_ref 占位）
            import os
            from pathlib import Path as _Path
            if os.environ.get("ORCHESTRATION_AIRFLOW_BASE_URL") and os.environ.get("ORCHESTRATION_AIRFLOW_TOKEN"):
                from .worker import publish_workflow
                result = publish_workflow(
                    workflow_id=wf.id, version_number=version.version,
                    definition=version.definition, definition_hash=version.content_hash,
                    dag_root=_Path(os.environ.get("ORCHESTRATION_DAG_ROOT", "/tmp/orchestration-dags")))
                if result["status"] == "published":
                    workflows.finish_publish(version=version, engine_deploy_ref=result["engine_deploy_ref"])
                # 窗口内未就绪（dag processor 扫描周期长）：不判失败——保持
                # publishing 由 worker 对账收尾（600s 预算，超龄 15 分钟才 failed）
            else:
                workflows.finish_publish(version=version, engine_deploy_ref={"pending_worker": True})
            version.refresh_from_db()
            return Response(_version_json(version))
        except TeamDomainError as exc:
            return _error_response(exc)


class ProjectBindingsEndpoint(BaseAPIView):
    def get(self, request, slug, project_id):
        bindings = ProjectTeamBinding.objects.filter(
            project__workspace__slug=slug, project_id=project_id)
        return Response([_binding_json(b) for b in bindings])

    def post(self, request, slug, project_id):
        project = Project.objects.filter(workspace__slug=slug, id=project_id).first()
        if not project:
            return Response({"error": "not found"}, status=404)
        team = AgentTeam.objects.filter(workspace__slug=slug, id=request.data.get("teamId")).first()
        if not team:
            return Response({"error": "team not found", "code": "AGENT_TEAM_NOT_FOUND"}, status=404)
        # 两步绑定（成员收敛 §3.1）：workflowVersionId 可省（先绑团队后挂版本）
        version = None
        if request.data.get("workflowVersionId"):
            version = WorkflowVersion.objects.filter(id=request.data.get("workflowVersionId")).first()
            if not version:
                return Response({"error": "workflow version not found", "code": "WORKFLOW_VERSION_NOT_FOUND"}, status=404)
        try:
            binding = services.bind_project(
                project=project, team=team, user_id=request.user.id,
                is_admin=_is_workspace_admin(request.user, slug), workflow_version=version,
            )
            return Response(_binding_json(binding), status=201)
        except TeamDomainError as exc:
            return _error_response(exc)

    def patch(self, request, slug, project_id):
        """升级绑定到新流程版本。"""
        binding = ProjectTeamBinding.objects.filter(
            project__workspace__slug=slug, project_id=project_id,
            status=ProjectTeamBinding.Status.ACTIVE).first()
        if not binding:
            return Response({"error": "no active binding", "code": "PROJECT_TEAM_BINDING_NOT_FOUND"}, status=404)
        version = WorkflowVersion.objects.filter(id=request.data.get("workflowVersionId")).first()
        if not version:
            return Response({"error": "version not found", "code": "WORKFLOW_VERSION_NOT_FOUND"}, status=404)
        try:
            services.upgrade_binding(binding=binding, user_id=request.user.id,
                                     is_admin=_is_workspace_admin(request.user, slug), workflow_version=version)
            return Response(_binding_json(binding))
        except TeamDomainError as exc:
            return _error_response(exc)


# ---------------------------------------------------------------- 执行与审批


class ProjectTeamPanelEndpoint(BaseAPIView):
    """项目卡团队徽章（§12.2）：绑定的团队名 + 在岗/等待计数；未绑定返回 null。"""

    def get(self, request, slug, project_id):
        binding = ProjectTeamBinding.objects.filter(
            project__workspace__slug=slug, project_id=project_id,
            status=ProjectTeamBinding.Status.ACTIVE).select_related("team").first()
        if not binding:
            # 未绑定是正常态：204 空体（前端按 null 处理），不造 {"panel": null} 包装
            return Response(status=204)
        from .state_machine import TERMINAL_STATUSES
        active = WorkItemExecution.objects.filter(
            binding=binding).exclude(business_status__in=list(TERMINAL_STATUSES))
        return Response({
            "projectId": str(project_id),
            "teamId": binding.team_id,
            "teamName": binding.team.name,
            "activeAgentCount": active.filter(business_status="running").count(),
            "waitingDecisionCount": BusinessApproval.objects.filter(
                execution__binding=binding, result=BusinessApproval.Result.PENDING).count(),
        })


class ProjectExecutionsEndpoint(BaseAPIView):
    def get(self, request, slug, project_id):
        executions = WorkItemExecution.objects.filter(
            binding__project__workspace__slug=slug, binding__project_id=project_id,
        ).order_by("-updated_at")
        return Response([_execution_json(e) for e in executions])


class ApprovalsEndpoint(BaseAPIView):
    @staticmethod
    def _user_in_execution_team(user_id, approval) -> bool:
        """未指定审批人时：可答范围 = 执行冻结名册的 human 成员（§3.3）。

        冻结名册缺 userId（存量执行快照）→ 回退按绑定团队当前 enabled human 成员判。
        """
        members = ((approval.execution.frozen_context or {}).get("members") or [])
        frozen = [m for m in members if m.get("kind") == "human" and m.get("userId")]
        if frozen:
            return str(user_id) in {str(m.get("userId")) for m in frozen}
        return approval.execution.binding.team.members.filter(
            kind=AgentTeamMember.Kind.HUMAN, enabled=True, user_id=user_id).exists()

    def get(self, request, slug):
        """当前用户的待办/已办审批（跨项目）——列表自带详情面所需全部字段。

        可见性：指定审批人（assignee=request.user）或未指定时团队 human 成员（§3.3 收窄）。
        """
        from django.db.models import Q
        approvals = BusinessApproval.objects.filter(
            execution__binding__project__workspace__slug=slug,
        ).filter(Q(assignee=request.user) | Q(assignee__isnull=True)).select_related(
            "execution", "execution__issue", "execution__issue__project",
            "execution__binding", "execution__binding__team",
        ).order_by("-created_at")
        visible = [a for a in approvals
                   if a.assignee_id is not None or self._user_in_execution_team(request.user.id, a)]
        return Response([_approval_json(a) for a in visible])

    def post(self, request, slug, approval_id):
        """审批作答（approved/rejected + 理由）；恢复执行经 outbox 由 worker 投递。"""
        from django.db.models import Q
        approval = BusinessApproval.objects.filter(
            execution__binding__project__workspace__slug=slug, id=approval_id,
        ).filter(Q(assignee=request.user) | Q(assignee__isnull=True)).select_related(
            "execution", "execution__binding", "execution__binding__team").first()
        if not approval:
            return Response({"error": "not found"}, status=404)
        if approval.assignee_id is None and not self._user_in_execution_team(request.user.id, approval):
            return Response({"error": "not found"}, status=404)
        if approval.result != BusinessApproval.Result.PENDING:
            return Response({"error": "already answered", "code": "APPROVAL_ALREADY_SETTLED"}, status=409)
        decision = request.data.get("decision")
        if decision not in ("approved", "rejected"):
            return Response({"error": "decision must be approved/rejected"}, status=400)
        approval.result = decision
        approval.reason = request.data.get("reason", "")
        approval.answered_at = timezone.now()
        approval.save(update_fields=["result", "reason", "answered_at"])
        from . import execution as execution_svc
        if decision == BusinessApproval.Result.REJECTED:
            # 驳回/终止选项（等价旧链 reject terminal 语义）：答复即取消执行，
            # 不恢复流程——作废其余待审批并转投引擎取消
            try:
                execution_svc.cancel_execution(
                    execution=approval.execution, event_id=f"approval:{approval.id}")
            except Exception:
                pass  # 执行已终态/冲突时审批记录仍成立
        else:
            # 人工恢复事件入 outbox（worker 转投引擎；本地无 worker 时由
            # 过渡内联处理执行状态）
            from .models import OrchestrationOutbox
            import hashlib, json as _json
            payload = {"executionId": approval.execution_id, "approvalId": approval.id, "decision": decision}
            OrchestrationOutbox.objects.get_or_create(
                idempotency_key=f"approval:{approval.id}",
                defaults={
                    "command_type": "engine.human_resume", "payload": payload,
                    "payload_hash": hashlib.sha256(_json.dumps(payload, sort_keys=True).encode()).hexdigest(),
                },
            )
            # 过渡：本地直接推进执行状态（终局删此段，由 worker 消费 outbox）
            try:
                execution_svc.on_human_resume(execution_id=approval.execution_id, event_id=f"approval:{approval.id}")
            except Exception:
                pass  # 执行未在等待态（终态/冲突）时审批仍成立
        return Response({"id": approval.id, "result": approval.result})


class ConnectionsEndpoint(BaseAPIView):
    """连接列表/创建（设计 §4；权限：管理员建改删、成员可读）。"""

    def get(self, request, slug):
        from .models import ExternalConnection
        from . import connections as conn_svc
        qs = ExternalConnection.objects.filter(workspace__slug=slug, deleted_at__isnull=True)
        type_filter = request.GET.get("type")
        if type_filter:
            qs = qs.filter(type=type_filter)
        return Response([conn_svc.connection_json(c) for c in qs.order_by("name")])

    def post(self, request, slug):
        from . import connections as conn_svc
        if not _is_workspace_admin(request.user, slug):
            return Response({"error": "需要工作区管理员权限", "code": "CONNECTION_FORBIDDEN"}, status=403)
        try:
            conn = conn_svc.create_connection(
                workspace_slug=slug, user_id=request.user.id,
                name=request.data.get("name", ""),
                type_=request.data.get("type", ""),
                config=request.data.get("config") or {})
            return Response(conn_svc.connection_json(conn), status=201)
        except TeamDomainError as exc:
            return _error_response(exc)


class ConnectionDetailEndpoint(BaseAPIView):
    """编辑/删除（凭据留空=不修改；删除即失效，被引用则 409 带清单）。"""

    def _get(self, slug, conn_id):
        from .models import ExternalConnection
        return ExternalConnection.objects.filter(
            workspace__slug=slug, id=conn_id, deleted_at__isnull=True).first()

    def patch(self, request, slug, conn_id):
        from . import connections as conn_svc
        if not _is_workspace_admin(request.user, slug):
            return Response({"error": "需要工作区管理员权限", "code": "CONNECTION_FORBIDDEN"}, status=403)
        conn = self._get(slug, conn_id)
        if not conn:
            return Response({"error": "连接不存在"}, status=404)
        try:
            updated = conn_svc.update_connection(
                conn=conn, name=request.data.get("name"),
                config_patch=request.data.get("config") or {})
            return Response(conn_svc.connection_json(updated))
        except TeamDomainError as exc:
            return _error_response(exc)

    def delete(self, request, slug, conn_id):
        from . import connections as conn_svc
        if not _is_workspace_admin(request.user, slug):
            return Response({"error": "需要工作区管理员权限", "code": "CONNECTION_FORBIDDEN"}, status=403)
        conn = self._get(slug, conn_id)
        if not conn:
            return Response({"error": "连接不存在"}, status=404)
        try:
            conn_svc.delete_connection(conn=conn)
            return Response(status=204)
        except TeamDomainError as exc:
            return _error_response(exc)


class ConnectionTestEndpoint(BaseAPIView):
    """独立测试（不改内容）。"""

    def post(self, request, slug, conn_id):
        from . import connections as conn_svc
        from .models import ExternalConnection
        if not _is_workspace_admin(request.user, slug):
            return Response({"error": "需要工作区管理员权限", "code": "CONNECTION_FORBIDDEN"}, status=403)
        conn = ExternalConnection.objects.filter(
            workspace__slug=slug, id=conn_id, deleted_at__isnull=True).first()
        if not conn:
            return Response({"error": "连接不存在"}, status=404)
        updated = conn_svc._apply_test(conn)
        return Response({"status": updated.status, "statusNote": updated.status_note})


class ConnectionResolveEndpoint(BaseAPIView):
    """内部回调：工具服务/worker 按名称取解密凭据（服务令牌鉴权）。"""

    permission_classes = []
    throttle_classes = []

    def post(self, request):
        import os, secrets
        expected = os.environ.get("ORCHESTRATION_INTERNAL_TOKEN", "")
        provided = request.headers.get("X-Orchestration-Token", "")
        if not expected or not secrets.compare_digest(expected, provided):
            return Response({"error": "unauthorized"}, status=401)
        from . import connections as conn_svc
        config = conn_svc.resolve_connection(
            workspace_id=request.data.get("workspaceId"),
            name=request.data.get("name", ""))
        if config is None:
            return Response({"error": "connection not found"}, status=404)
        return Response({"config": config})


class ProjectRuntimeOverviewEndpoint(BaseAPIView):
    """项目概览运行时区块：绑定 + 计数 + 最近运行动态。"""

    def get(self, request, slug, project_id):
        from .state_machine import TERMINAL_STATUSES
        binding = ProjectTeamBinding.objects.filter(
            project__workspace__slug=slug, project_id=project_id,
            status=ProjectTeamBinding.Status.ACTIVE).select_related("team", "workflow_version", "workflow_version__workflow").first()
        binding_json = None
        if binding:
            version = binding.workflow_version
            binding_json = {
                "id": binding.id, "teamId": binding.team_id, "teamName": binding.team.name,
                "workflowName": version.workflow.name if version else None,
                "workflowId": str(version.workflow_id) if version else None,
                "workflowVersion": version.version if version else None,
                "workflowVersionId": str(version.id) if version else None,
                "updatedAt": binding.updated_at.isoformat(),
            }
        executions = WorkItemExecution.objects.filter(
            binding__project__workspace__slug=slug, binding__project_id=project_id,
        ).select_related("issue", "issue__state").order_by("-updated_at")
        active = [e for e in executions if e.business_status not in TERMINAL_STATUSES]
        runs = [{
            "runId": e.id, "taskId": e.issue_id, "taskTitle": e.issue.name,
            "status": e.business_status,
            "stateName": e.issue.state.name if e.issue.state_id else None,
            "stateColor": e.issue.state.color if e.issue.state_id else None,
            "stateGroup": e.issue.state.group if e.issue.state_id else None,
            "startedAt": e.created_at.isoformat(),
            "finishedAt": e.completed_at.isoformat() if e.completed_at else None,
        } for e in executions[:10]]
        return Response({
            "binding": binding_json,
            "counts": {
                "activeTasks": len(active),
                "waitingHuman": BusinessApproval.objects.filter(
                    execution__binding__project_id=project_id,
                    result=BusinessApproval.Result.PENDING).count(),
                "runningAgents": sum(1 for e in active if e.business_status == "running"),
            },
            # 最近工作项的运行时标记（进行中执行 → issue 打标）
            "tasks": [{
                "issueId": e.issue_id, "externalItemId": str(e.issue_id),
                "controlStatus": e.business_status,
            } for e in active],
            "recentRuns": runs,
        })


class WorkItemRuntimeEndpoint(BaseAPIView):
    """工作项详情运行时面板（§12.3）：执行摘要 + 结构化时间线，一次给全。

    时间线给结构化事件（kind + 上下文），文案归前端 i18n——修复旧链
    服务端中文硬编码的 i18n 缺口。未绑定（无执行记录）204。
    """

    def get(self, request, slug, project_id, issue_id):
        from .state_machine import TERMINAL_STATUSES
        from django.utils import timezone as dj_tz
        execution = WorkItemExecution.objects.filter(
            binding__project__workspace__slug=slug, binding__project_id=project_id,
            issue_id=issue_id,
        ).select_related("binding", "binding__team", "issue__state",
                         "current_member", "current_member__user").order_by("-created_at").first()
        if not execution:
            # 已绑定但无执行（历史卡/自动启动失败）：给启动信号而非静默 204
            if ProjectTeamBinding.objects.filter(
                    project_id=project_id, status=ProjectTeamBinding.Status.ACTIVE).exists():
                return Response({"pendingStart": True})
            return Response(status=204)

        team = execution.binding.team
        names = _agent_names_for(team)
        member_name = None
        if execution.current_member is not None:
            if execution.current_member.kind == "human":
                member_name = execution.current_member.user.display_name if execution.current_member.user else None
            else:
                member_name = names.get(execution.current_member.agent_definition_id)

        # 节点名映射：优先执行冻结的版本快照（版本切换后旧执行仍按其启动
        # 版本呈现，机器 key 不上界面），快照缺失回退绑定当前版本
        frozen_version_id = (execution.frozen_context or {}).get("workflowVersionId")
        definition = None
        if frozen_version_id:
            from .models import WorkflowVersion
            definition = WorkflowVersion.objects.filter(
                id=frozen_version_id).values_list("definition", flat=True).first()
        if definition is None:
            definition = execution.binding.workflow_version.definition or {}
        node_names = {n.get("key"): (n.get("name") or n.get("key"))
                      for n in ((definition or {}).get("nodes") or [])}

        # 当前步骤：最新 running 节点，缺省回执行状态
        step = None
        running_node = execution.node_records.exclude(
            status__in=["success", "failed", "skipped", "cancelled"]).order_by("-updated_at").first()
        if running_node is not None:
            step = node_names.get(running_node.node_key, running_node.node_key)
        elif execution.business_status == "waiting_human":
            pending_node = execution.node_records.filter(status="success").order_by("-updated_at").first()
            step = "human"

        # 节点名映射（definition 快照）：时间线/工件呈现用节点名而非机器 key
        artifacts = [{
            "id": a.id,
            "nodeKey": a.storage_ref.rsplit("/", 1)[-1],
            "name": (node_names.get(a.storage_ref.rsplit("/", 1)[-1]) or a.storage_ref.rsplit("/", 1)[-1]
                     or a.content_hash[:12]),
            "version": a.version, "sizeBytes": None,
            "contentUrl": a.storage_ref,
            # 正文即节点输出（orchestration:// 是逻辑引用非下载 URL——页内直接可看）
            "content": ((execution.node_records.filter(
                node_key=a.storage_ref.rsplit("/", 1)[-1]).first().result or {}).get("output") or "")[:50000],
        } for a in execution.artifacts.order_by("version")]

        from django.db.models import Q
        pending = execution.approvals.filter(
            result=BusinessApproval.Result.PENDING).filter(
            Q(assignee=request.user) | Q(assignee__isnull=True)).first()

        # 时间线：执行创建 → 节点记录 → 审批 → 终态（按时间归并）
        # memberName = 该步执行者（叙事流步骤行「节点 — 执行者」的「谁在做」；
        # 2026-11-04 #3：此前误用全局 current_member，每步显示同一人）
        definition_nodes = {
            n.get("key"): n for n in ((execution.binding.workflow_version.definition or {}).get("nodes") or [])}
        frozen_members = (execution.frozen_context or {}).get("members") or []
        # frozen 快照不存 role（成员收敛 §3.3 只钉 id/kind/userId）——AI 步骤
        # 执行者用 agent 目录显示名（names，与成员页同源），不读快照 role
        agent_role_by_def = {
            str(m.get("agentDefinitionId")): names.get(str(m.get("agentDefinitionId")))
            for m in frozen_members if m.get("kind") == "agent"}
        human_ids = {m.get("userId") for m in frozen_members if m.get("kind") == "human" and m.get("userId")}
        human_names = {}  # 指定审批人 → 显示名（人工步骤的「谁在做」）
        if human_ids:
            from plane.db.models import User as _User
            human_names = {str(u.id): (u.display_name or u.email) for u in _User.objects.filter(id__in=human_ids)}

        def _node_member_name(node_key: str) -> str | None:
            node = definition_nodes.get(node_key) or {}
            if node.get("type") in ("ai", "condition"):
                return agent_role_by_def.get(str(node.get("expertId") or ""))
            if node.get("type") == "human_approval":
                return human_names.get(str(node.get("approverUserId") or ""))
            return None

        events = [{
            "id": f"start:{execution.id}", "kind": "execution",
            "status": "queued", "memberName": None, "nodeKey": None, "nodeName": None,
            "createdAt": execution.created_at.isoformat(),
        }]
        for n in execution.node_records.order_by("updated_at"):
            events.append({
                "id": f"node:{n.id}:{n.status}", "kind": "node",
                "status": n.status, "nodeKey": n.node_key,
                "nodeName": node_names.get(n.node_key, n.node_key),
                "memberName": _node_member_name(n.node_key),
                "createdAt": n.updated_at.isoformat(),
            })
        for a in execution.approvals.order_by("created_at"):
            events.append({
                "id": f"approval:{a.id}:{a.result}", "kind": "approval",
                "status": a.result, "nodeKey": a.node_ref,
                "nodeName": node_names.get(a.node_ref, a.node_ref), "memberName": None,
                "createdAt": (a.answered_at or a.created_at).isoformat(),
            })
        if execution.business_status in TERMINAL_STATUSES and execution.completed_at:
            events.append({
                "id": f"terminal:{execution.id}", "kind": "execution",
                "status": execution.business_status, "memberName": None,
                "nodeKey": None, "nodeName": None,
                "createdAt": execution.completed_at.isoformat(),
            })
        events.sort(key=lambda e: e["createdAt"])

        duration = None
        if execution.completed_at:
            duration = (execution.completed_at - execution.created_at).total_seconds()
        elif execution.business_status != "queued":
            duration = (dj_tz.now() - execution.created_at).total_seconds()

        return Response({
            "executionId": execution.id,
            "businessStatus": execution.business_status,
            # 工作项状态徽章（与工作项列表同源）
            "issueState": ({"name": execution.issue.state.name, "color": execution.issue.state.color,
                            "group": execution.issue.state.group}
                           if execution.issue.state_id else None),
            "teamId": team.id, "teamName": team.name,
            "currentMemberName": member_name,
            "workflowStep": step,
            "durationSeconds": duration,
            "engineRunRef": execution.engine_run_ref,
            "retryable": execution.business_status in TERMINAL_STATUSES,
            "artifacts": artifacts,
            "pendingApproval": _approval_json(pending) if pending else None,
            "timeline": events,
            # 叙事流「排队中」的未来步骤（#3）：流程定义中尚未开始的节点名，
            # 剪枝感知——条件已选淘汰的分支不出现
            "upcomingSteps": _upcoming_steps(execution),
        })

    def post(self, request, slug, project_id, issue_id):
        """取消当前执行（非终态）：置 cancelled + outbox engine.cancel（worker 转投引擎）。"""
        from .state_machine import TERMINAL_STATUSES
        from . import execution as execution_svc
        execution = WorkItemExecution.objects.filter(
            binding__project__workspace__slug=slug, binding__project_id=project_id,
            issue_id=issue_id).order_by("-created_at").first()
        if not execution:
            return Response({"error": "not found"}, status=404)
        if execution.business_status in TERMINAL_STATUSES:
            return Response({"error": "already terminal", "code": "EXECUTION_ALREADY_TERMINAL"}, status=409)
        execution = execution_svc.cancel_execution(execution=execution)
        return Response({"executionId": execution.id, "businessStatus": execution.business_status})


class StartExecutionEndpoint(BaseAPIView):
    def post(self, request, slug, project_id):
        """受控启动：校验 + 冻结上下文 + outbox 启动命令。"""
        from plane.db.models.issue import Issue
        from .models import ProjectTeamBinding
        from . import execution as execution_svc
        issue = Issue.objects.filter(
            project__workspace__slug=slug, project_id=project_id, id=request.data.get("issueId")).first()
        binding = ProjectTeamBinding.objects.filter(
            project__workspace__slug=slug, project_id=project_id,
            status=ProjectTeamBinding.Status.ACTIVE).first()
        if not issue or not binding:
            return Response({"error": "issue or binding not found"}, status=404)
        try:
            execution = execution_svc.start_execution(issue=issue, binding=binding, user_id=request.user.id)
            return Response(_execution_json(execution), status=201)
        except TeamDomainError as exc:
            return _error_response(exc)


class EngineEventEndpoint(BaseAPIView):
    """worker → Plane 引擎事件入口（服务令牌鉴权，worker 专用）。"""

    permission_classes = []
    throttle_classes = []

    def post(self, request):
        import os, secrets
        expected = os.environ.get("ORCHESTRATION_INTERNAL_TOKEN", "")
        provided = request.headers.get("X-Orchestration-Token", "")
        if not expected or not secrets.compare_digest(expected, provided):
            return Response({"error": "unauthorized"}, status=401)
        from . import execution as execution_svc
        result = execution_svc.process_event(
            external_event_id=request.data.get("externalEventId", ""),
            event_type=request.data.get("eventType", ""),
            payload=request.data.get("payload", {}),
        )
        return Response(result)


class DagNodeRuntimeBase(BaseAPIView):
    """DAG 运行时回调（令牌鉴权同 EngineEventEndpoint）。"""

    permission_classes = []
    throttle_classes = []

    def _auth(self, request):
        import os, secrets
        expected = os.environ.get("ORCHESTRATION_INTERNAL_TOKEN", "")
        return expected and secrets.compare_digest(expected, request.headers.get("X-Orchestration-Token", ""))

    def _execution(self, run_ref: str):
        return WorkItemExecution.objects.filter(engine_run_ref=run_ref).first()

    def _denied(self):
        return Response({"error": "unauthorized"}, status=401)

    def _prune_if_unreachable(self, execution, definition: dict, node_key: str) -> bool:
        """剪枝闸门（权威判定在后端，Airflow 只镜像）。

        传感器可能先于 worker 的 PENDING→SKIPPED 剪枝把死分支节点拉起
        （running + 人工节点已建审批）——start/observe 时按已记录分支选择
        复核可达性：不可达则后端直接置 skipped 并作废该节点待审批，
        DAG 轮询到 skipped 走 AirflowSkip 传播。
        """
        from .node_runtime import NodeRuntimeRecord
        from .execution_context import pruned_node_keys
        choices = dict(NodeRuntimeRecord.objects.filter(
            execution=execution, status=NodeRuntimeRecord.Status.SUCCESS,
        ).values_list("node_key", "result__chosenBranch"))
        choices = {k: v for k, v in choices.items() if v}
        if node_key not in pruned_node_keys(definition, choices):
            return False
        NodeRuntimeRecord.objects.filter(
            execution=execution, node_key=node_key,
        ).exclude(status=NodeRuntimeRecord.Status.SUCCESS).update(
            status=NodeRuntimeRecord.Status.SKIPPED)
        from .models import BusinessApproval
        from django.utils import timezone
        BusinessApproval.objects.filter(
            execution=execution, node_ref=node_key,
            result=BusinessApproval.Result.PENDING,
        ).update(result=BusinessApproval.Result.REJECTED,
                 reason="该分支已被条件节点剪枝，审批自动作废",
                 answered_at=timezone.now())
        return True


class DagNodeView(DagNodeRuntimeBase):
    def get(self, request, run_ref, node_key):
        if not self._auth(request):
            return self._denied()
        from .node_runtime import NodeRuntimeRecord
        execution = self._execution(run_ref)
        if not execution:
            return Response({"error": "run not found"}, status=404)
        record, _ = NodeRuntimeRecord.objects.get_or_create(execution=execution, node_key=node_key)
        definition = (execution.binding.workflow_version.definition or {})
        # 剪枝闸门前置：死分支节点（含已被拉起的竞态残留）observe 即判 skipped
        if self._prune_if_unreachable(execution, definition, node_key):
            record.refresh_from_db()
            return Response(record.view())
        # 人工节点自愈：start 期 handoff 失败遗留（RUNNING 且执行未进等待态）
        # 时在 observe 补投——审批建单不可静默丢失（幂等：已等待仅补单）
        node_type = next((n.get("type") for n in (definition.get("nodes") or [])
                          if n.get("key") == node_key), None)
        if (node_type == "human_approval"
                and record.status == NodeRuntimeRecord.Status.RUNNING
                and execution.business_status == "running"):
            from . import execution as execution_svc
            execution_svc.on_human_handoff(
                execution_id=execution.id, event_id=f"observe:{node_key}:{record.id}",
                member=None, node_ref=node_key)
            execution.refresh_from_db()
            record.refresh_from_db()
        return Response(record.view())


class DagNodeStartView(DagNodeRuntimeBase):
    def post(self, request, run_ref, node_key):
        from .node_runtime import NodeRuntimeRecord
        from .models import OrchestrationOutbox
        import hashlib, json as _json
        if not self._auth(request):
            return self._denied()
        execution = self._execution(run_ref)
        if not execution:
            return Response({"error": "run not found"}, status=404)
        record, _ = NodeRuntimeRecord.objects.get_or_create(execution=execution, node_key=node_key)
        definition = (execution.binding.workflow_version.definition or {})
        # 剪枝闸门：条件已选别的分支时 start 直接判 skipped（handoff/命令都不发）
        if self._prune_if_unreachable(execution, definition, node_key):
            record.refresh_from_db()
            return Response({"accepted": True, "status": record.status})
        record.status = NodeRuntimeRecord.Status.RUNNING
        record.attempt = int(request.data.get("attempt", 1))
        record.last_event_id = request.data.get("eventId", "")
        record.save()
        # 按发布版本 definition 的节点类型分派：人工节点 → handoff（waiting_human
        # + 建待审批）；AI/条件节点 → agent.invoke 命令（worker 真调 agwmngr）
        node_type = next((n.get("type") for n in (definition.get("nodes") or [])
                          if n.get("key") == node_key), None)
        if node_type == "human_approval":
            from . import execution as execution_svc
            execution_svc.on_human_handoff(
                execution_id=execution.id,
                event_id=request.data.get("eventId") or f"node:{node_key}:{record.attempt}",
                member=None, node_ref=node_key)
        elif node_type in ("ai", "condition"):
            # agent 上牌（§7.3）：AI 节点开始 → 当前执行成员=团队 agent 成员 +
            # 卡片指派 bot（投影失败不阻塞节点执行）
            try:
                from .models import AgentTeamMember
                from .bot_provisioning import sync_issue_assignee
                agent_member = AgentTeamMember.objects.filter(
                    team=execution.binding.team, kind="agent", enabled=True,
                ).order_by("-sequence").first()
                if agent_member is not None:
                    prev_member = execution.current_member
                    WorkItemExecution.objects.filter(id=execution.id).update(
                        current_member=agent_member, updated_at=timezone.now())
                    execution.refresh_from_db()
                    sync_issue_assignee(issue=execution.issue, previous_member=prev_member,
                                        next_member=agent_member,
                                        workspace_id=str(execution.issue.workspace_id))
            except Exception:
                pass
            payload = {"executionId": execution.id, "nodeKey": node_key, "attempt": record.attempt}
            OrchestrationOutbox.objects.get_or_create(
                idempotency_key=f"agent_call:{execution.id}:{node_key}:{record.attempt}",
                defaults={"command_type": "agent.invoke", "payload": payload,
                          "payload_hash": hashlib.sha256(_json.dumps(payload, sort_keys=True).encode()).hexdigest()})
        return Response({"accepted": True, "status": record.status})


class DagNodeFinishView(DagNodeRuntimeBase):
    def post(self, request, run_ref, node_key):
        from .node_runtime import NodeRuntimeRecord
        from . import execution as execution_svc
        if not self._auth(request):
            return self._denied()
        execution = self._execution(run_ref)
        if not execution:
            return Response({"error": "run not found"}, status=404)
        record = NodeRuntimeRecord.objects.filter(execution=execution, node_key=node_key).first()
        skipped = (request.data.get("result") or {}).get("status") == "skipped"
        status = NodeRuntimeRecord.Status.SKIPPED if skipped else NodeRuntimeRecord.Status.SUCCESS
        if record:
            record.status = status
            record.result = request.data.get("result") or {}
            record.save()
        if node_key == "human" or skipped:
            return Response({"accepted": True, "status": status})
        # 无更多待跑节点时的运行终态由引擎 terminal 事件结算（worker 投递），
        # 此处仅登记节点事实——与旧系统「节点事件→运行聚合」分工一致。
        return Response({"accepted": True, "status": status})


class DagNodeFailView(DagNodeRuntimeBase):
    def post(self, request, run_ref, node_key):
        from .node_runtime import NodeRuntimeRecord
        from . import execution as execution_svc
        if not self._auth(request):
            return self._denied()
        execution = self._execution(run_ref)
        if not execution:
            return Response({"error": "run not found"}, status=404)
        record, _ = NodeRuntimeRecord.objects.get_or_create(execution=execution, node_key=node_key)
        record.status = NodeRuntimeRecord.Status.FAILED
        record.result = request.data.get("result") or {"error": "node failed"}
        record.save()
        try:
            execution_svc.on_engine_terminal(
                execution_id=execution.id,
                event_id=request.data.get("eventId") or f"nodefail:{run_ref}:{node_key}",
                engine_status="failed")
        except Exception:
            pass  # 已终态时节点失败仅登记
        return Response({"accepted": True, "status": record.status})
