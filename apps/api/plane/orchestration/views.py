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
from .execution_context import answer_attachment_results
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


def _artifacts_json(execution):
    """执行已产出工件列表（预览内容=节点输出正文）。

    侧板工件引用、审批卡「依据」两处共用——审批问句只保留画布配置文案，
    上下文以工件引用呈现，不再把前置节点输出原文注入问句。
    """
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
    return [{
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


def _approval_json(a: BusinessApproval):
    """审批列表/详情一体（旧收件箱列表+详情两次取数，新域一次给全）。"""
    e = a.execution
    # 已挂载答复附件（C7）：刷新后面板按此恢复附件列表
    from plane.db.models import FileAsset
    attachments = []
    if a.attachment_ids:
        for asset in FileAsset.objects.filter(id__in=a.attachment_ids):
            attachments.append({
                "id": str(asset.id),
                "name": (asset.attributes or {}).get("name") or asset.asset.name.rsplit("/", 1)[-1],
            })
    return {
        "id": a.id, "executionId": a.execution_id, "nodeRef": a.node_ref,
        "question": a.question, "options": a.options, "freeText": a.free_text,
        "result": a.result, "reason": a.reason,
        "answeredAt": a.answered_at.isoformat() if a.answered_at else None,
        "createdAt": a.created_at.isoformat(),
        "attachments": attachments,
        # 作答形态依据：人工审批节点纯按钮（通过/驳回无下游资料消费），
        # agent 问询节点允许文字/附件组合补充（C6 边界，11-15 修正）
        "humanNode": a.node_ref in {
            n.get("key") for n in (
                (e.binding.workflow_version.definition or {}).get("nodes") or [])
            if n.get("type") == "human_approval"},
        # 画布自定义选项的人工节点：驳回维持「终止」语义（v2 定案）；
        # 默认形态驳回=重做。前端据此区分按钮形态
        "customOptions": bool(next(
            (n.get("options") for n in (
                (e.binding.workflow_version.definition or {}).get("nodes") or [])
            if n.get("key") == a.node_ref and n.get("type") == "human_approval"), None)),
        # 消费面（卡片列表/详情头）：团队与工作项上下文
        "teamId": e.binding.team_id, "teamName": e.binding.team.name,
        "projectId": str(e.issue.project_id), "issueId": e.issue_id, "taskTitle": e.issue.name,
        # 审批依据：执行已产出工件（引用式上下文，问句保持简明）
        "contextArtifacts": _artifacts_json(e),
    }


def _reclaim_approval_assets(approval, *, keep_asset_ids=()):
    """回收未认领的挂载附件（C7）——实现见 execution_context（execution.py 复用）。"""
    from .execution_context import reclaim_approval_assets
    reclaim_approval_assets(approval, keep_asset_ids=keep_asset_ids)


def _reclaim_unlinked(approval, merged_ids):
    """作答后回收未认领挂载附件：没挂上评论的直接删（评论认领的从挂载列表摘除）。"""
    from plane.db.models import FileAsset
    claimed = set(FileAsset.objects.filter(
        id__in=merged_ids, comment__isnull=False).values_list("id", flat=True)) if merged_ids else set()
    _reclaim_approval_assets(approval, keep_asset_ids={str(i) for i in claimed})


def _write_answer_comment(approval, user, asset_ids, blocks):
    """作答内容以答者身份回写卡片评论（文字 + 附件节点 + 附件挂载）。投影非事实源。"""
    try:
        from django.utils.html import escape
        from plane.db.models import IssueComment, FileAsset
        issue = approval.execution.issue
        rows = FileAsset.objects.filter(
            id__in=asset_ids, workspace_id=issue.workspace_id, is_uploaded=True) if asset_ids else []
        nodes = "".join(
            f'<attachment-component id="{a.id}" '
            f'name="{escape((a.attributes or {}).get("name") or a.asset.name.rsplit("/", 1)[-1])}" '
            f'url="{a.id}" status="uploaded"></attachment-component>'
            for a in rows)
        text = (approval.reason or "").strip() or ("（附件补充）" if rows else "")
        comment = IssueComment.objects.create(
            workspace_id=issue.workspace_id, project_id=issue.project_id,
            issue=issue, actor=user, created_by=user,
            comment_html=f"<p>{escape(text)}</p>{nodes}")
        if asset_ids:
            FileAsset.objects.filter(
                id__in=asset_ids, workspace_id=issue.workspace_id,
                is_uploaded=True, comment__isnull=True,
            ).update(comment_id=comment.id, entity_identifier=str(comment.id),
                     entity_type="COMMENT_DESCRIPTION")
    except Exception:
        pass


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


class TeamShareableIssuesEndpoint(BaseAPIView):
    """团队可分享卡列表（贴回卡片弹层数据源，2026-11-18）。

    - 范围：团队绑定项目下的**全部**卡（含终态——评论留痕不限对象状态，
      执行中的卡仅是「贴上去会被员工自取」的加成，非准入门槛）
    - 搜索：`?q=` 后端检索（卡名/项目名/负责人，icontains）；无 q 返回最近 50 张
    - 字段：卡名 / 项目名 / 执行状态（进行中/排队/已完成/失败/取消/未执行）/
      负责人（最近执行的当前成员，human 取显示名、agent 走目录名）
    """

    def get(self, request, slug, team_id):
        from django.db.models import Q, OuterRef, Subquery
        from plane.db.models.issue import Issue
        from .models import WorkItemExecution
        from .agent_directory import resolve_agent_names

        project_ids = ProjectTeamBinding.objects.filter(
            team__workspace__slug=slug, team_id=team_id,
        ).values_list("project_id", flat=True)

        issues = Issue.objects.filter(project_id__in=list(project_ids))
        q = (request.GET.get("q") or "").strip()
        if q:
            issues = issues.filter(
                Q(name__icontains=q)
                | Q(project__name__icontains=q)
                | Q(assignees__display_name__icontains=q)
            ).distinct()
        # 每 issue 最近一条执行（决定执行状态与负责人）
        latest_execution = WorkItemExecution.objects.filter(
            issue_id=OuterRef("pk")
        ).order_by("-created_at").values("id")[:1]
        issues = issues.annotate(
            latest_execution_id=Subquery(latest_execution)
        ).select_related("project", "state").prefetch_related("assignees").order_by("-updated_at", "-id")

        # 游标分页（keyset：按 -updated_at,-id 排序，游标=上一页末条的 updated_at|id）
        limit = min(int(request.GET.get("limit") or 20), 50)
        cursor = (request.GET.get("cursor") or "").strip()
        if cursor:
            try:
                cur_updated, cur_id = cursor.split("|", 1)
            except ValueError:
                cur_updated, cur_id = cursor, ""
            from django.utils.dateparse import parse_datetime
            cur_dt = parse_datetime(cur_updated)
            if cur_dt is not None:
                issues = issues.filter(
                    Q(updated_at__lt=cur_dt) | Q(updated_at=cur_dt, id__lt=cur_id)
                )
        page = list(issues[: limit + 1])
        has_more = len(page) > limit
        result = page[:limit]
        next_cursor = ""
        if has_more and result:
            last = result[-1]
            next_cursor = f"{last.updated_at.isoformat()}|{last.id}"

        # 批量取执行 + 成员
        exec_map = {
            e.issue_id: e for e in WorkItemExecution.objects.filter(
                id__in=[i.latest_execution_id for i in result if i.latest_execution_id]
            ).select_related("current_member", "current_member__user")
        }
        agent_defs = {
            e.current_member.agent_definition_id
            for e in exec_map.values()
            if e.current_member and e.current_member.kind == "agent"
        }
        agent_names = resolve_agent_names(agent_defs)

        items = []
        for issue in result:
            ex = exec_map.get(issue.id)
            member = ex.current_member if ex else None
            if member is not None and member.kind == "human":
                member_name = member.user.display_name if member.user else None
            elif member is not None:
                member_name = agent_names.get(member.agent_definition_id)
            else:
                member_name = None
            items.append({
                "issueId": str(issue.id),
                "taskName": issue.name,
                "sequenceId": issue.sequence_id,
                "projectIdentifier": issue.project.identifier,
                "externalProjectId": str(issue.project_id),
                "externalItemId": str(issue.id),
                # 工作项状态（与工作项列表显示同源：名+色徽章，StateGroupIcon 消费）
                "stateName": issue.state.name if issue.state_id else None,
                "stateColor": issue.state.color if issue.state_id else None,
                "stateGroup": issue.state.group if issue.state_id else None,
                "projectName": issue.project.name,
                "activeMemberName": member_name,
                # 执行状态（贴回卡片的「执行中自取」加成徽标）
                "controlStatus": ex.business_status if ex else None,
            })
        return Response({"items": items, "nextCursor": next_cursor, "hasMore": has_more})


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
        # agent 求助单（AI 节点发起，能力化人工介入）：答复 = 补充资料 →
        # 同节点重跑（attempt+1，prompt 注入答复）；拒绝 = 终止执行。
        # 通过且无原因时给「确认继续」兜底，避免空重跑让 agent 重复问 NEED_INPUT。
        _definition = approval.execution.binding.workflow_version.definition or {}
        _node_type = next((n.get("type") for n in (_definition.get("nodes") or [])
                           if n.get("key") == approval.node_ref), None)
        if _node_type in ("ai", "condition"):
            if decision == BusinessApproval.Result.REJECTED:
                try:
                    execution_svc.cancel_execution(
                        execution=approval.execution, event_id=f"approval:{approval.id}")
                except Exception:
                    pass
                return Response({"id": str(approval.id), "result": decision})
            execution_svc.on_ask_answered(
                execution_id=approval.execution_id, event_id=f"approval:{approval.id}")
            from .node_runtime import NodeRuntimeRecord
            record = NodeRuntimeRecord.objects.filter(
                execution=approval.execution, node_key=approval.node_ref).first()
            attempt = (record.attempt + 1) if record else 1
            human_answer = (approval.reason or "").strip() or "已确认，按你的判断继续。"
            # 答复附件（2026-11-14）：agent 问「要文档」而文本框答不了——答复面板
            # 可传附件，服务端用评论附件同源管线解析成文本并入重跑 prompt。
            # approval.reason 保持纯手输文本（展示面不掺解析内容）。
            # C7：请求附件 ∪ 审批挂载附件（刷新后面板从挂载恢复）去重合并——
            # 挂载过又没随本次提交的也不会漏带。
            _merged_asset_ids = list(dict.fromkeys(
                [str(a) for a in (request.data.get("attachment_ids") or [])]
                + [str(a) for a in (approval.attachment_ids or [])]))
            _attachment_blocks, _attachment_results = answer_attachment_results(
                _merged_asset_ids,
                workspace_id=approval.execution.binding.project.workspace_id)
            if _attachment_blocks:
                human_answer = human_answer + "\n\n" + "\n".join(_attachment_blocks)
            if record:
                # 答复 → 节点从 waiting_human 回到 running（重跑），观察循环继续等其
                # 终态。B1（2026-11-14）：人工答复=新一轮——failure_retries 清零
                #（失败重派预算不与问询-答答复共线），答复落 human_answer 供后续
                # 失败自动重派随行携带。
                NodeRuntimeRecord.objects.filter(id=record.id).update(
                    status=NodeRuntimeRecord.Status.RUNNING, attempt=attempt,
                    failure_retries=0, human_answer=human_answer)
            payload = {
                "executionId": approval.execution_id, "nodeKey": approval.node_ref,
                "attempt": attempt,
                "humanAnswer": human_answer,
            }
            from .tasks import defer_command, execution_lock
            defer_command(
                idempotency_key=f"agent_call:{approval.execution_id}:{approval.node_ref}:{attempt}",
                task_name="orchestration.agent_invoke",
                payload=payload, lock=execution_lock(approval.execution_id))
            # 答答回写卡评论（C2，2026-11-15）：补料内容以答者身份落到动态流
            # ——团队可见、事后可追溯；附件挂到该评论（UI 按评论附件渲染，
            # 后续 prompt 组装经评论附件管线同样可见）。失败不阻断作答
            #（回写非事实源，重跑注入以 humanAnswer 为权威通道）。
            _reason_text = (approval.reason or "").strip()
            _answer_asset_ids = _merged_asset_ids
            if _reason_text or _answer_asset_ids:
                try:
                    from django.utils.html import escape
                    from plane.db.models import IssueComment, FileAsset
                    _issue = approval.execution.issue
                    # 附件以编辑器附件节点嵌入正文（实证：UI 渲染评论附件走
                    # comment_html 里的 attachment-component 节点，url=资产id）
                    _asset_rows = FileAsset.objects.filter(
                        id__in=_answer_asset_ids,
                        workspace_id=_issue.workspace_id, is_uploaded=True)
                    _nodes = "".join(
                        f'<attachment-component id="{a.id}" '
                        f'name="{escape((a.attributes or {}).get("name") or a.asset.name.rsplit("/", 1)[-1])}" '
                        f'url="{a.id}" status="uploaded"></attachment-component>'
                        for a in _asset_rows)
                    _comment = IssueComment.objects.create(
                        workspace_id=_issue.workspace_id, project_id=_issue.project_id,
                        issue=_issue, actor=request.user, created_by=request.user,
                        comment_html=f"<p>{escape(_reason_text) or '（附件补充）'}</p>{_nodes}")
                    if _answer_asset_ids:
                        # 挂评论必须同时写 entity_identifier=评论id：UI 按该字段
                        # 渲染评论附件（仅 comment FK 不显示，C2 上线即缺，11-15 补）
                        FileAsset.objects.filter(
                            id__in=_answer_asset_ids,
                            workspace_id=_issue.workspace_id, is_uploaded=True, comment__isnull=True,
                        ).update(comment_id=_comment.id, entity_identifier=str(_comment.id),
                                 entity_type="COMMENT_DESCRIPTION")
                except Exception:
                    pass
            # C7：作答后回收未认领附件——挂载过但没进本次评论的直接删除
            #（评论认领的即归评论，从挂载列表摘除）。
            _claimed = set(FileAsset.objects.filter(
                id__in=_answer_asset_ids, comment__isnull=False
            ).values_list("id", flat=True)) if _answer_asset_ids else set()
            _reclaim_approval_assets(approval, keep_asset_ids={str(i) for i in _claimed})
            # C4：附件解析结果随作答响应回告（前端汇总提示「哪些能读/哪些要人工看/
            # 哪些没带上」），作答人不再对解析失败无感知。
            return Response({"id": str(approval.id), "result": decision,
                             "attachmentResults": _attachment_results})
        if decision == BusinessApproval.Result.REJECTED:
            _node_def = next((n for n in (_definition.get("nodes") or [])
                              if n.get("key") == approval.node_ref), {})
            if _node_def.get("options"):
                # 画布自定义选项：维持「终止」语义（v2 定案——自定义流程不被动改）
                try:
                    execution_svc.cancel_execution(
                        execution=approval.execution, event_id=f"approval:{approval.id}")
                except Exception:
                    pass  # 执行已终态/冲突时审批记录仍成立
                return Response({"id": str(approval.id), "result": decision})
            # 默认形态驳回 = 重做（v2 定案 2026-11-15）：意见+附件作为修改
            # 要求注入上游最近 AI 节点重跑，跑完自动重新进入确认
            _merged = list(dict.fromkeys(
                [str(a) for a in (request.data.get("attachment_ids") or [])]
                + [str(a) for a in (approval.attachment_ids or [])]))
            _blocks, _results = answer_attachment_results(
                _merged, workspace_id=approval.execution.binding.project.workspace_id)
            _feedback = (approval.reason or "").strip() or "请重新核对并修正。"
            if _blocks:
                _feedback = _feedback + "\n\n" + "\n".join(_blocks)
            try:
                _, _target_def = execution_svc.on_human_redo(
                    execution_id=approval.execution_id, node_ref=approval.node_ref,
                    feedback=_feedback, event_id=f"approval:{approval.id}")
                # 用户回执（投影非事实源）：驳回去向一目了然——署名按上游
                # AI 节点 expertId 对应的负责员工（非在牌/首个成员）
                try:
                    from django.utils.html import escape
                    from plane.db.models import IssueComment
                    from .bot_provisioning import ensure_bot_for_agent
                    from .models import AgentTeamMember
                    issue = approval.execution.issue
                    member = AgentTeamMember.objects.filter(
                        team=approval.execution.binding.team, kind="agent", enabled=True,
                        agent_definition_id=_target_def.get("expertId")).first()
                    if member is None:
                        member = AgentTeamMember.objects.filter(
                            team=approval.execution.binding.team, kind="agent", enabled=True).first()
                    if member:
                        bot = ensure_bot_for_agent(
                            agent_definition_id=member.agent_definition_id,
                            workspace_id=str(issue.workspace_id))
                        if bot:
                            IssueComment.objects.create(
                                project=issue.project, workspace=issue.project.workspace,
                                issue=issue, actor=bot, created_by=bot, access="INTERNAL",
                                comment_html=f"<p>已驳回，{escape(bot.display_name)}将按修改要求重新处理："
                                             f"{escape((approval.reason or '').strip())}</p>")
                except Exception:
                    pass
            except Exception:
                pass  # 无上游 AI 节点等异常：审批记录仍成立，前端按钮已按先验隐藏
            _reclaim_unlinked(approval, _merged)
            return Response({"id": str(approval.id), "result": decision,
                             "attachmentResults": _results})
        else:
            # 人工节点通过（v2）：拍板备注 + 附件内容落节点 output——下游节点
            # prompt 经 prior_outputs 携带（确认人说的「按 480 确认」下一段可见）
            _merged = list(dict.fromkeys(
                [str(a) for a in (request.data.get("attachment_ids") or [])]
                + [str(a) for a in (approval.attachment_ids or [])]))
            _blocks, _results = answer_attachment_results(
                _merged, workspace_id=approval.execution.binding.project.workspace_id)
            from .node_runtime import NodeRuntimeRecord
            NodeRuntimeRecord.objects.filter(
                execution=approval.execution, node_key=approval.node_ref
            ).update(result={"output": ((approval.reason or "").strip()
                                        + ("\n" + "\n".join(_blocks) if _blocks else "")),
                             "choice": decision})
            _write_answer_comment(approval, request.user, _merged, _blocks)
            _reclaim_unlinked(approval, _merged)
            # 人工恢复命令（worker 兜底推进；本地无 worker 时由过渡内联处理）
            from .tasks import defer_command, execution_lock
            defer_command(
                idempotency_key=f"approval:{approval.id}",
                task_name="orchestration.human_resume",
                payload={"executionId": approval.execution_id, "approvalId": approval.id},
                lock=execution_lock(approval.execution_id))
            # 双保险之一：作答即内联推进执行状态（即时生效，无 worker 环境也可用）；
            # 另一道是 worker 对该命令的幂等消费（已推进过按 409 视为已办）。
            # 勿删此段——删后无 worker 环境人工确认推不动，且要吃轮询延迟。

            try:
                execution_svc.on_human_resume(execution_id=approval.execution_id, event_id=f"approval:{approval.id}")
            except Exception:
                pass  # 执行未在等待态（终态/冲突）时审批仍成立
        return Response({"id": approval.id, "result": approval.result})


class ApprovalAttachmentsEndpoint(BaseAPIView):
    """审批答复附件挂载（C7）：作答前随传随挂——刷新/换人不丢，作答时与请求合并。

    POST {asset_id} 幂等挂载；DELETE ?asset_id= 卸载。可见性/可答范围与作答端点一致
    （指定审批人或团队 human 成员）；仅 PENDING 期可改。
    """

    def _load(self, request, slug, approval_id):
        from django.db.models import Q
        approval = BusinessApproval.objects.filter(
            execution__binding__project__workspace__slug=slug, id=approval_id,
        ).filter(Q(assignee=request.user) | Q(assignee__isnull=True)).select_related(
            "execution", "execution__binding__team").first()
        if approval and approval.assignee_id is None and not ApprovalsEndpoint._user_in_execution_team(
                request.user.id, approval):
            return None
        return approval

    def post(self, request, slug, approval_id):
        from plane.db.models import FileAsset
        approval = self._load(request, slug, approval_id)
        if not approval:
            return Response({"error": "not found"}, status=404)
        if approval.result != BusinessApproval.Result.PENDING:
            return Response({"error": "already answered"}, status=409)
        asset_id = str(request.data.get("asset_id") or "")
        if not FileAsset.objects.filter(
                id=asset_id, workspace_id=approval.execution.binding.project.workspace_id,
                is_uploaded=True).exists():
            return Response({"error": "asset not found in workspace"}, status=400)
        ids = list(approval.attachment_ids or [])
        if asset_id not in ids:
            ids.append(asset_id)
            approval.attachment_ids = ids
            approval.save(update_fields=["attachment_ids", "updated_at"])
        return Response({"attachments": ids})

    def delete(self, request, slug, approval_id):
        approval = self._load(request, slug, approval_id)
        if not approval:
            return Response({"error": "not found"}, status=404)
        if approval.result != BusinessApproval.Result.PENDING:
            return Response({"error": "already answered"}, status=409)
        asset_id = str(request.query_params.get("asset_id") or "")
        ids = [i for i in (approval.attachment_ids or []) if str(i) != asset_id]
        approval.attachment_ids = ids
        approval.save(update_fields=["attachment_ids", "updated_at"])
        return Response({"attachments": ids})


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
        import os
        import secrets
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
        ).select_related("issue").order_by("-updated_at")
        active = [e for e in executions if e.business_status not in TERMINAL_STATUSES]
        runs = [{
            "runId": e.id, "taskId": e.issue_id, "taskTitle": e.issue.name,
            "status": e.business_status,
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

        # 工件列表：与审批「依据」同一 helper（节点名映射在 helper 内按冻结快照解析）
        artifacts = _artifacts_json(execution)

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
            # output：节点输出正文（叙事流每步结论行；失败节点回退 error）。
            # 截断 4000——页内展开看全文，预览弹层仍走 artifact.content
            raw_result = n.result or {}
            normalized_error = raw_result.get("error_normalized") or {}
            error_code = normalized_error.get("code") if isinstance(normalized_error, dict) else None
            error_detail = normalized_error.get("detail") if isinstance(normalized_error, dict) else None
            node_output = raw_result.get("output") or ("" if error_code else raw_result.get("error")) or ""
            events.append({
                "id": f"node:{n.id}:{n.status}", "kind": "node",
                "status": n.status, "nodeKey": n.node_key,
                "nodeName": node_names.get(n.node_key, n.node_key),
                "memberName": _node_member_name(n.node_key),
                "createdAt": n.updated_at.isoformat(),
                "output": node_output[:4000] or None,
                "errorCode": error_code,
                "errorDetail": (error_detail or "")[:4000] or None,
            })
        for a in execution.approvals.order_by("created_at"):
            events.append({
                "id": f"approval:{a.id}:{a.result}", "kind": "approval",
                "status": a.result, "nodeKey": a.node_ref,
                "nodeName": node_names.get(a.node_ref, a.node_ref), "memberName": None,
                "createdAt": (a.answered_at or a.created_at).isoformat(),
                # 已作答时 reason=所选选项文案（叙事流状态位显示它而非裸枚举）
                "output": (a.reason if a.result != "pending" else None),
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
        import os
        import secrets
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
        import os
        import secrets
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
        if not self._auth(request):
            return self._denied()
        execution = self._execution(run_ref)
        if not execution:
            return Response({"error": "run not found"}, status=404)
        record, _ = NodeRuntimeRecord.objects.get_or_create(execution=execution, node_key=node_key)
        # start 幂等守卫：SUCCESS/CANCELLED 不可复活（终局后 sensor 重试曾把
        # 记录拉回 RUNNING 造成僵尸）。FAILED 允许重试重驱——Airflow
        # RetryPolicy 重打 start 即引擎的重试意志；attempt 用记录级单调自增
        # （不信 Airflow try_number：答复路径旁路重跑与其编号撞车——WB-4004
        # 双线竞态实证），确保每次入队都是全新 pending 命令
        if record.status in (NodeRuntimeRecord.Status.SUCCESS,
                             NodeRuntimeRecord.Status.CANCELLED):
            return Response({"accepted": True, "status": record.status})
        definition = (execution.binding.workflow_version.definition or {})
        # 重试上限（B1 2026-11-14 语义分离）：上限只看 failure_retries（失败
        # 自动重派的专用预算）；attempt 是总运行序号（幂等键/线程保鲜），
        # 「提问→答复」重跑推进 attempt 但不占预算、无限次。sensor 收到
        # status=failed 会 raise 结束 run，终结「失败→重试」循环。
        _node_def = next((n for n in (definition.get("nodes") or []) if n.get("key") == node_key), {})
        _retries = _node_def.get("retries") if _node_def.get("retries") is not None else 1
        if record.status == NodeRuntimeRecord.Status.FAILED and record.failure_retries >= _retries:
            return Response({"accepted": True, "status": record.status, "error": "retries exhausted"})
        # 当前 attempt 的命令是否已投递（任意状态——等价旧 outbox 键存在判据，
        # 改查 procrastinate job 表：行完成后仍保留）
        from .tasks import command_exists
        _key_exists = command_exists(f"agent_call:{execution.id}:{node_key}:{record.attempt}")
        if record.status == NodeRuntimeRecord.Status.FAILED or _key_exists:
            if record.status == NodeRuntimeRecord.Status.FAILED:
                record.failure_retries += 1
            record.attempt = record.attempt + 1
        # 剪枝闸门：条件已选别的分支时 start 直接判 skipped（handoff/命令都不发）
        if self._prune_if_unreachable(execution, definition, node_key):
            record.refresh_from_db()
            return Response({"accepted": True, "status": record.status})
        record.status = NodeRuntimeRecord.Status.RUNNING
        record.last_event_id = request.data.get("eventId", "")
        record.save()
        # 按发布版本 definition 的节点类型分派：人工节点 → handoff（waiting_human
        # + 建待审批）；AI/条件节点 → agent.invoke 命令（worker 真调 agwmngr）
        node = next((n for n in (definition.get("nodes") or [])
                     if n.get("key") == node_key), {})
        node_type = node.get("type")
        if node_type == "human_approval":
            # 驳回重做期间（上游 AI 节点在跑）不重建审批——否则新审批的
            # 确认内容是旧产出；等上游完成后的下一 poke 再 handoff
            from .node_runtime import NodeRuntimeRecord as _NRR
            _anc, _frontier = set(), {node_key}
            while _frontier:
                _frontier = {e.get("source") for e in (definition.get("edges") or [])
                             if e.get("target") in _frontier}
                _anc |= _frontier
            if _NRR.objects.filter(execution=execution, node_key__in=_anc,
                                   status=_NRR.Status.RUNNING).exists():
                # 回 PENDING：上游完成后 sensor 下一 poke 会重新 POST start
                record.status = NodeRuntimeRecord.Status.PENDING
                record.save(update_fields=["status", "updated_at"])
                return Response({"accepted": True, "status": "pending"})
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
                # 按节点 expertId 对应团队成员（曾误取「任一启用 agent」——
                # 每个节点上牌都是同一个人，WB-2005 审单节点上了录入员）
                _expert = node.get("expertId")
                agent_member = AgentTeamMember.objects.filter(
                    team=execution.binding.team, kind="agent", enabled=True,
                    agent_definition_id=_expert,
                ).first() if _expert else None
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
            # 人工答复随行（B1）：失败自动重派也带上最近答复——防「答复后偶发
            # 空回复→重派把用户答复丢了」；为空则不带（worker 按无答复处理）。
            if record.human_answer:
                payload["humanAnswer"] = record.human_answer
            from .tasks import defer_command, execution_lock
            defer_command(
                idempotency_key=f"agent_call:{execution.id}:{node_key}:{record.attempt}",
                task_name="orchestration.agent_invoke",
                payload=payload, lock=execution_lock(execution.id))
        return Response({"accepted": True, "status": record.status})


class DagNodeFinishView(DagNodeRuntimeBase):
    def post(self, request, run_ref, node_key):
        from .node_runtime import NodeRuntimeRecord
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
    def _comment_failure(self, *, execution, node_key: str, result: dict | None):
        from .execution_context import comment_failure
        comment_failure(execution=execution, node_key=node_key, result=result)

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
        # 失败原因上卡片（C5 一期）：以当前在牌团队助手身份落到动态流，
        # 终结不再「悄悄失败」。投影非事实源，回写失败不阻断登记。
        self._comment_failure(execution=execution, node_key=node_key, result=record.result)
        # 11-23 修正（112102 事故）：节点失败 ≠ 执行终态——引擎（Airflow）
        # 可能还在重试该节点。执行终态唯一由 DAG run 终局决定（DAG 级回调
        # 推送 + 对账循环兜底），此前这里直接 on_engine_terminal(failed)
        # 把重试窗口内的执行钉死为失败，重试成功也翻不回来。
        return Response({"accepted": True, "status": record.status})


class ExecutionSupplementsView(BaseAPIView):
    """执行中补料自取接口（C8-B，steering 一期）。

    permission_classes/throttle_classes 置空——签名即鉴权（调用方是
    agent，无会话）。

    `GET /api/internal/executions/{execution_id}/supplements/?after=<ISO>&exp=<unix>&sig=<hmac>`

    - 鉴权：短期签名（supplement_access.verify，共享 token 不出平台）；
      不用 X-Orchestration-Token——那个是 worker↔API 的固定凭证，不能进
      prompt 交给模型（G4）。
    - 返回 after 之后的人工补充（结构化单条；防注入语义由 prompt 纪律承担）。
    - after 缺省为执行创建时刻（首次自取即全量节点期内补充）。
    """

    permission_classes = []
    throttle_classes = []

    def get(self, request, execution_id):
        from .supplement_access import verify_supplement_access, supplement_entries
        if not verify_supplement_access(
                execution_id, request.GET.get("exp"), request.GET.get("sig")):
            return Response({"error": "invalid or expired signature"}, status=403)
        execution = WorkItemExecution.objects.filter(id=execution_id).select_related("issue").first()
        if not execution:
            return Response({"error": "execution not found"}, status=404)
        after = None
        raw_after = (request.GET.get("after") or "").strip()
        if raw_after:
            from django.utils.dateparse import parse_datetime
            # 时区偏移的 '+' 在 query 里会裸传成空格（未编码形态），先还原
            after = parse_datetime(raw_after.replace(" ", "+"))
            if after is None:
                return Response({"error": "invalid after (ISO 8601 expected)"}, status=400)
        items = supplement_entries(execution.issue, after_dt=after)
        return Response({"supplements": items, "hasNew": bool(items)})
