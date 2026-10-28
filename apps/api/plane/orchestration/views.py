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


def _team_json(team: AgentTeam, with_members: bool = False):
    data = {
        "id": team.id, "name": team.name, "objective": team.objective,
        "status": team.status,
        "createdBy": User.objects.filter(id=team.created_by_id).values_list("username", flat=True).first(),
        "createdAt": team.created_at.isoformat(), "updatedAt": team.updated_at.isoformat(),
    }
    if with_members:
        data["members"] = [_member_json(m) for m in team.members.order_by("sequence", "created_at")]
    return data


def _member_json(m: AgentTeamMember):
    return {
        "id": m.id, "kind": m.kind,
        "userId": m.user_id, "agentDefinitionId": m.agent_definition_id,
        "role": m.role, "capabilities": m.capabilities, "sequence": m.sequence,
        "enabled": m.enabled, "updatedAt": m.updated_at.isoformat(),
    }


def _workflow_json(wf: WorkflowDefinition):
    return {
        "id": wf.id, "name": wf.name, "description": wf.description,
        "engineKind": wf.engine_kind, "draft": wf.draft,
        "createdAt": wf.created_at.isoformat(), "updatedAt": wf.updated_at.isoformat(),
    }


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
        teams = AgentTeam.objects.filter(workspace__slug=slug).order_by("-created_at")
        return Response([_team_json(t) for t in teams])

    def post(self, request, slug):
        try:
            team = services.create_team(
                workspace_id=Workspace.objects.get(slug=slug).id,
                user_id=request.user.id,
                is_admin=_is_workspace_admin(request.user, slug),
                name=request.data.get("name", ""),
                objective=request.data.get("objective", ""),
            )
            return Response(_team_json(team), status=201)
        except TeamDomainError as exc:
            return _error_response(exc)
        except Workspace.DoesNotExist:
            return Response({"error": "workspace not found"}, status=404)


class TeamDetailEndpoint(BaseAPIView):
    def _get(self, slug, team_id) -> AgentTeam | None:
        return AgentTeam.objects.filter(workspace__slug=slug, id=team_id).first()

    def get(self, request, slug, team_id):
        team = self._get(slug, team_id)
        if not team:
            return Response({"error": "not found"}, status=404)
        return Response(_team_json(team, with_members=True))

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
            return Response(_team_json(team))
        except TeamDomainError as exc:
            return _error_response(exc)


class TeamMembersEndpoint(BaseAPIView):
    def get(self, request, slug, team_id):
        team = AgentTeam.objects.filter(workspace__slug=slug, id=team_id).first()
        if not team:
            return Response({"error": "not found"}, status=404)
        return Response([_member_json(m) for m in team.members.order_by("sequence", "created_at")])

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
            return Response(_member_json(member), status=201)
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


# ---------------------------------------------------------------- 流程与绑定


class ProjectWorkflowsEndpoint(BaseAPIView):
    def get(self, request, slug, project_id):
        wfs = WorkflowDefinition.objects.filter(project__workspace__slug=slug, project_id=project_id)
        return Response([_workflow_json(w) for w in wfs])

    def post(self, request, slug, project_id):
        project = Project.objects.filter(workspace__slug=slug, id=project_id).first()
        if not project:
            return Response({"error": "not found"}, status=404)
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
                wf.name = request.data["name"].strip(); wf.save(update_fields=["name", "updated_at"])
            return Response(_workflow_json(wf))
        except TeamDomainError as exc:
            return _error_response(exc)


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
            # worker 上线前的过渡：无引擎时直接完成发布（engine_deploy_ref 占位）
            # 终局由 worker 轮询后调 finish_publish。
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
        version = WorkflowVersion.objects.filter(id=request.data.get("workflowVersionId")).first()
        if not team or not version:
            return Response({"error": "team or workflow version not found",
                             "code": "AGENT_TEAM_NOT_FOUND" if not team else "WORKFLOW_VERSION_NOT_FOUND"}, status=404)
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


class ProjectExecutionsEndpoint(BaseAPIView):
    def get(self, request, slug, project_id):
        executions = WorkItemExecution.objects.filter(
            binding__project__workspace__slug=slug, binding__project_id=project_id,
        ).order_by("-updated_at")
        return Response([_execution_json(e) for e in executions])


class ApprovalsEndpoint(BaseAPIView):
    def get(self, request, slug):
        """当前用户的待办/已办审批（跨项目）。"""
        approvals = BusinessApproval.objects.filter(
            execution__binding__project__workspace__slug=slug, assignee=request.user,
        ).order_by("-created_at")
        return Response([{
            "id": a.id, "executionId": a.execution_id, "nodeRef": a.node_ref,
            "options": a.options, "result": a.result, "reason": a.reason,
            "answeredAt": a.answered_at.isoformat() if a.answered_at else None,
        } for a in approvals])

    def post(self, request, slug, approval_id):
        """审批作答（approved/rejected + 理由）；恢复执行经 outbox 由 worker 投递。"""
        approval = BusinessApproval.objects.filter(
            execution__binding__project__workspace__slug=slug, id=approval_id,
            assignee=request.user).first()
        if not approval:
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
        from . import execution as execution_svc
        try:
            execution_svc.on_human_resume(execution_id=approval.execution_id, event_id=f"approval:{approval.id}")
        except Exception:
            pass  # 执行未在等待态（终态/冲突）时审批仍成立
        return Response({"id": approval.id, "result": approval.result})


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
