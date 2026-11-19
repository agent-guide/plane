# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""数字员工会话 API（P2 一期，设计 v2/team-assistant-chat-design.md §2/§3）。

端点（挂 /api/workspaces/<slug>/agent-teams/ 域）：
- GET/POST   conversations/                    会话列表 / 创建（team+member）
- PATCH/DELETE conversations/{id}/             改名 / 软删（整会话）
- GET        conversations/{id}/messages/      历史（before 游标分页）
- POST       conversations/{id}/messages/      发消息 → SSE 流式返回员工回复
                                             （写库+流式透传一体；断线走 stream 续传）
- GET        conversations/{id}/stream/        断线续传（?message= 回复消息 id）

权限（一期私有）：workspace 成员 + 会话发起人；成员行「对话」入口对
团队成员开放创建。
"""

from __future__ import annotations

import json

from django.db import IntegrityError
from django.http import StreamingHttpResponse
from django.utils import timezone as dj_tz
from rest_framework.response import Response

from plane.app.views.base import BaseAPIView

from .models import AgentConversation, AgentMessage, AgentTeam
from .services import TeamDomainError


def _error_response(exc: TeamDomainError):
    return Response({"error": exc.message, "code": exc.code}, status=exc.status)


def _unread_flag(c: AgentConversation) -> bool:
    """未读=存在员工（agent）消息晚于已读游标——微信模型：对方消息才算
    未读，用户自己发的不算。调用方可传 annotate 结果避免 N+1。"""
    unread = getattr(c, "unread_annotated", None)
    if unread is not None:
        return bool(unread)
    from django.utils import timezone as dj_tz
    import datetime as _dt
    # 未读过（last_read_at 为空）→ 从头算；gt NULL 在 SQL 恒假，须兜底
    since = c.last_read_at or dj_tz.make_aware(_dt.datetime(1970, 1, 1))
    # 排除空占位行（text 型且文本为空——流式回复的占位）；确认卡/流程卡值得看
    return (c.messages.filter(role=AgentMessage.Role.AGENT, created_at__gt=since)
            .exclude(kind=AgentMessage.Kind.TEXT, content__text="").exists())


def _conversation_json(c: AgentConversation, last_message: str = "",
                       last_error: dict | None = None) -> dict:
    from .agent_directory import resolve_agent_names
    names = resolve_agent_names([c.agent_member.agent_definition_id])
    agent_name = names.get(c.agent_member.agent_definition_id) or c.agent_member.role
    return {
        "id": c.id,
        "teamId": str(c.team_id),
        "teamName": c.team.name,
        "agentMemberId": str(c.agent_member_id),
        "agentDefinitionId": c.agent_member.agent_definition_id,
        "agentName": agent_name,
        "agentRole": c.agent_member.role,
        "title": c.title or agent_name,
        "summaryCompacted": bool(c.summary),
        "lastMessageAt": c.last_message_at.isoformat() if c.last_message_at else None,
        "lastMessagePreview": last_message[:80],
        # 最后一条消息的错误结构（text 为空的错误轮次，预览文案由前端
        # displayErrorDetail 与会话页同源渲染；detail 归一化时已是人话）
        "lastMessageError": last_error,
        "unread": _unread_flag(c),
        # 成员摘要（前端复用 MemberAvatar 头像渲染）
        "member": {"kind": c.agent_member.kind, "role": c.agent_member.role,
                   "displayName": agent_name, "enabled": c.agent_member.enabled},
    }


def _attachment_objects(ids: list, name_map: dict | None = None) -> list[dict]:
    """附件 id 列表 → [{id, name}]。name_map 缺省时查 FileAsset（单条消息场景）。"""
    if not ids:
        return []
    if name_map is None:
        from plane.db.models import FileAsset
        assets = FileAsset.objects.filter(id__in=ids)
        name_map = {str(a.id): (a.attributes or {}).get("name") or str(a.id) for a in assets}
    return [{"id": str(aid), "name": name_map.get(str(aid), str(aid))} for aid in ids]


def _message_json(m: AgentMessage, name_map: dict | None = None) -> dict:
    return {
        "id": m.id,
        "role": m.role,
        "kind": m.kind,
        "content": m.content,
        "attachments": _attachment_objects(m.attachments or [], name_map),
        "streamingOffset": m.streaming_offset,
        "createdAt": m.created_at.isoformat(),
    }


def _load_conversation(request, slug, conversation_id: str) -> AgentConversation | None:
    """加载会话并鉴权（workspace 匹配 + 发起人本人；一期私有口径）。"""
    conv = AgentConversation.objects.select_related(
        "team", "agent_member", "workspace").filter(
        workspace__slug=slug, id=conversation_id, deleted_at__isnull=True).first()
    if conv is None or conv.created_by_id != request.user.id:
        return None  # 一期私有：非发起人视同不存在（404 语义）
    return conv


class ConversationsEndpoint(BaseAPIView):
    """会话列表 / 创建。"""

    def get(self, request, slug):
        # 归档视图（?archived=1）：软删会话；默认活跃视图
        archived = request.GET.get("archived") == "1"
        from django.db.models import Exists, OuterRef, Value
        from django.db.models.functions import Coalesce
        from django.db.models import DateTimeField
        import datetime as _dt
        from django.utils import timezone as _tz
        epoch = _tz.make_aware(_dt.datetime(1970, 1, 1))
        agent_unread = AgentMessage.objects.filter(
            conversation=OuterRef("pk"), role=AgentMessage.Role.AGENT,
            created_at__gt=Coalesce(OuterRef("last_read_at"), Value(epoch, output_field=DateTimeField()))
        ).exclude(kind=AgentMessage.Kind.TEXT, content__text="")
        convs = (AgentConversation.objects.filter(
            workspace__slug=slug, created_by=request.user,
            deleted_at__isnull=not archived)
            .annotate(unread_annotated=Exists(agent_unread))
            .select_related("team", "agent_member").order_by("-last_message_at", "-created_at"))
        result = []
        for c in convs[:100]:
            last = c.messages.exclude(role="system").order_by("-created_at").first()
            content = (last.content or {}) if last else {}
            # 预览只回原始结构（text/error），显示文案由前端与会话页共用同一套
            # 逻辑渲染（displayErrorDetail）——后端不另造第二套摘要规则（单一来源）
            result.append(_conversation_json(
                c,
                last_message=str(content.get("text") or ""),
                last_error=(content.get("error") if isinstance(content.get("error"), dict) else None),
            ))
        return Response(result)

    def post(self, request, slug):
        team = AgentTeam.objects.filter(
            workspace__slug=slug, id=request.data.get("teamId")).first()
        if team is None:
            return Response({"error": "team not found", "code": "TEAM_NOT_FOUND"}, status=404)
        member = team.members.filter(
            id=request.data.get("agentMemberId"), kind="agent", enabled=True).first()
        if member is None:
            return Response({"error": "agent member not found or not enabled",
                             "code": "MEMBER_NOT_FOUND"}, status=404)
        # 单会话模型（Slack DM/微信同构，2026-11-17 定案）：同一（团队,成员,
        # 发起人）活跃会话唯一——重复发起幂等返回已有；删除会话后可再开新的
        existing = AgentConversation.objects.filter(
            team=team, agent_member=member, created_by=request.user,
            deleted_at__isnull=True).first()
        if existing is not None:
            return Response(_conversation_json(existing), status=200)
        try:
            conv = AgentConversation.objects.create(
                team=team, agent_member=member,
                workspace=team.workspace, created_by=request.user,
                title=request.data.get("title") or "")
        except IntegrityError:
            # 并发创建撞唯一约束（双击/双请求同秒）——重查返回已有，幂等收敛
            conv = AgentConversation.objects.filter(
                team=team, agent_member=member, created_by=request.user,
                deleted_at__isnull=True).first()
            if conv is None:
                raise
            return Response(_conversation_json(conv), status=200)
        return Response(_conversation_json(conv), status=201)


class ConversationDetailEndpoint(BaseAPIView):
    """改名（PATCH）/ 软删（DELETE，审计口径：仅整会话可删）。"""

    def patch(self, request, slug, conversation_id):
        """标记已读 / 恢复归档。会话名=员工名（管理端权威数据），不可重命名
        （单会话 DM 模型，微信同构；备注名属成员级偏好，留二期评估）。"""
        conv = _load_conversation(request, slug, conversation_id)
        if conv is None:
            return Response({"error": "conversation not found"}, status=404)
        if request.data.get("restore"):
            conv.deleted_at = None
            conv.save(update_fields=["deleted_at", "updated_at"])
        if request.data.get("markRead"):
            conv.last_read_at = dj_tz.now()
            conv.save(update_fields=["last_read_at", "updated_at"])
        return Response(_conversation_json(conv))

    def delete(self, request, slug, conversation_id):
        conv = _load_conversation(request, slug, conversation_id)
        if conv is None:
            return Response({"error": "conversation not found"}, status=404)
        conv.deleted_at = dj_tz.now()
        conv.save(update_fields=["deleted_at", "updated_at"])
        return Response({"id": conv.id, "deleted": True})


class ConversationMessagesEndpoint(BaseAPIView):
    """历史（GET，before 游标分页）/ 发消息（POST，SSE 流式响应）。"""

    def get(self, request, slug, conversation_id):
        conv = _load_conversation(request, slug, conversation_id)
        if conv is None:
            return Response({"error": "conversation not found"}, status=404)
        qs = conv.messages.all().order_by("-created_at")
        before = request.GET.get("before")
        if before:
            anchor = conv.messages.filter(id=before).first()
            if anchor:
                qs = qs.filter(created_at__lt=anchor.created_at)
        messages = list(qs[:50])
        # 批量查附件名，避免逐条 N+1（历史消息 attachments 只存 id）
        name_map = None
        all_ids = [aid for m in messages for aid in (m.attachments or [])]
        if all_ids:
            from plane.db.models import FileAsset
            assets = FileAsset.objects.filter(id__in=all_ids)
            name_map = {str(a.id): (a.attributes or {}).get("name") or str(a.id) for a in assets}
        return Response([_message_json(m, name_map) for m in messages][::-1])

    def post(self, request, slug, conversation_id):
        conv = _load_conversation(request, slug, conversation_id)
        if conv is None:
            return Response({"error": "conversation not found"}, status=404)
        text = str(request.data.get("text") or "").strip()
        attachment_ids = [str(a) for a in (request.data.get("attachment_ids") or [])]
        if not text and not attachment_ids:
            return Response({"error": "empty message"}, status=400)
        # 用户消息落库（先于 turn——对话历史与全量重传语义的锚点）
        user_msg = AgentMessage.objects.create(
            conversation=conv, role=AgentMessage.Role.USER, kind=AgentMessage.Kind.TEXT,
            content={"text": text}, attachments=attachment_ids)
        conv.last_message_at = dj_tz.now()
        conv.save(update_fields=["last_message_at", "updated_at"])
        return _stream_agent_reply(conv, text, attachment_ids,
                                   user_message_id=str(user_msg.id),
                                   web_search=bool(request.data.get("web_search")))


_REPLY_PERSIST_EVERY = 8  # 增量落库节流（每 N 个 delta 刷一次游标）


def _stream_agent_reply(conv: AgentConversation, text: str, attachment_ids: list[str],
                        user_message_id: str = "", web_search: bool = False):
    """拉起员工 turn 并 SSE 流式返回；回复增量写库（断线续传锚点）。"""
    from .chat import build_chat_prompt, stream_agent_turn, maybe_compact_history
    from .execution_context import answer_attachment_results

    # 附件解析（C1/C4 管线同源）：解析文本注入 prompt
    blocks, _results = (answer_attachment_results(attachment_ids, workspace_id=conv.workspace_id)
                        if attachment_ids else ([], []))
    prompt = build_chat_prompt(conversation=conv, user_text=text, attachment_blocks=blocks,
                               web_search=web_search)

    reply = AgentMessage.objects.create(
        conversation=conv, role=AgentMessage.Role.AGENT, kind=AgentMessage.Kind.TEXT,
        content={"text": ""})

    def sse():
        from .worker import AgentTurnError, _normalize_agent_error
        chunks: list[str] = []
        try:
            stream = stream_agent_turn(
                agent_definition_id=conv.agent_member.agent_definition_id,
                prompt=prompt, session_hint=f"chat:{conv.id}")
            for event in stream:
                if event["type"] == "delta":
                    chunks.append(event["text"])
                    _persist_reply(reply, chunks)
                    yield _sse_frame("delta", {"v": 2, "text": event["text"], "messageId": reply.id})
                elif event["type"] == "stage":
                    yield _sse_frame("stage", {"v": 2, "phase": event.get("phase", "tool"), "label": event.get("label", "")})
                elif event["type"] == "done":
                    final_text = "".join(chunks)
                    # 确认卡识别（L1：建卡预览 JSON 独占回复）
                    card = _parse_confirm_card(final_text)
                    if card:
                        reply.kind = AgentMessage.Kind.CONFIRM_CARD
                        reply.content = {"text": "", "confirm": card}
                    else:
                        reply.content = {"text": final_text}
                    reply.streaming_offset = len(chunks)
                    reply.save(update_fields=["kind", "content", "streaming_offset", "updated_at"])
                    maybe_compact_history(conv)
                    # 协议 v2 §四：done 带定稿快照（含 user 消息真实 id，供前端
                    # 替换乐观占位），前端据此定稿、不再回拉
                    yield _sse_frame("done", {
                        "v": 2, "messageId": reply.id, "userMessageId": user_message_id,
                        "kind": reply.kind,
                        "content": {"text": final_text}, "stopReason": event.get("stopReason", ""),
                    })
        except GeneratorExit:
            # 客户端断开（刷新/切走/停止）：已收增量必须落库收敛（节流阈值内
            # 的 chunks 原先丢在内存 → 占位行永远空 → 前端空气泡，01-25 实证）
            reply.content = {"text": "".join(chunks), "interrupted": True}
            reply.streaming_offset = len(chunks)
            reply.save(update_fields=["content", "streaming_offset", "updated_at"])
            raise
        except AgentTurnError as exc:
            normalized = _normalize_agent_error(exc)
            reply.content = {"text": "".join(chunks), "error": normalized}
            # T1 预算检查点（设计 §3.3 拍板 2）：超时不判死——partial 保留，
            # 前端渲染三选（继续=发下一条消息即可，员工上下文里有 partial；
            # 转流程卡=请员工出确认卡；停止=保留现状）
            if normalized.get("code") == "timeout" and chunks:
                reply.content["checkpoint"] = True
                normalized = {**normalized, "checkpoint": True,
                              "options": ["continue", "convert", "stop"]}
            reply.save(update_fields=["content", "updated_at"])
            yield _sse_frame("error", {"v": 2, **normalized})
        finally:
            conv.last_message_at = dj_tz.now()
            conv.save(update_fields=["last_message_at", "updated_at"])

    response = StreamingHttpResponse(sse(), content_type="text/event-stream")
    response["Cache-Control"] = "no-cache"
    response["X-Accel-Buffering"] = "no"
    return response


def _persist_reply(reply: AgentMessage, chunks: list[str]) -> None:
    """流式增量落库（断线续传锚点）。节流写库，避免每 delta 一次 DB。"""
    if len(chunks) % _REPLY_PERSIST_EVERY:
        return
    reply.content = {"text": "".join(chunks)}
    reply.streaming_offset = len(chunks)
    reply.save(update_fields=["content", "streaming_offset", "updated_at"])


def _parse_confirm_card(text: str) -> dict | None:
    """识别回复中的建卡确认卡 JSON（```json {"type":"create_card",...}```）。"""
    import re
    m = re.search(r"```json\s*(\{.*?\})\s*```", text, re.S)
    if not m:
        return None
    try:
        obj = json.loads(m.group(1))
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    if isinstance(obj, dict) and obj.get("type") == "create_card" and obj.get("title"):
        return {"title": str(obj["title"])[:200],
                "description": str(obj.get("description") or "")[:10000],
                "workflowHint": str(obj.get("workflow_hint") or "")[:200]}
    return None


def _sse_frame(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


class ConversationStreamEndpoint(BaseAPIView):
    """断线续传：取回复消息当前增量（streaming_offset 即游标——§3.2）。"""

    def get(self, request, slug, conversation_id):
        conv = _load_conversation(request, slug, conversation_id)
        if conv is None:
            return Response({"error": "conversation not found"}, status=404)
        m = conv.messages.filter(id=request.GET.get("message"),
                                 role=AgentMessage.Role.AGENT).first()
        if m is None:
            return Response({"error": "message not found"}, status=404)
        done = bool((m.content or {}).get("text")) or m.kind != AgentMessage.Kind.TEXT \
            or bool((m.content or {}).get("error"))
        return Response({"messageId": m.id, "kind": m.kind, "content": m.content,
                         "streamingOffset": m.streaming_offset, "done": done})


class ConversationConfirmEndpoint(BaseAPIView):
    """确认卡执行（L1 闭环，设计 §2.2.1/§3.4）。

    POST ?action=confirm：走既有建卡闸门（绑定+版本 fail-closed）→ 建卡 →
    signal 自动执行 → 流程卡消息回贴会话；partial（确认卡 description）随卡
    转移——接手员工不从零开始。
    POST ?action=cancel：确认卡作废。
    幂等：已决状态重复提交 → 409。
    """

    def post(self, request, slug, conversation_id, message_id):
        conv = _load_conversation(request, slug, conversation_id)
        if conv is None:
            return Response({"error": "conversation not found"}, status=404)
        m = conv.messages.filter(id=message_id, role=AgentMessage.Role.AGENT,
                                 kind=AgentMessage.Kind.CONFIRM_CARD).first()
        if m is None:
            return Response({"error": "confirm card not found"}, status=404)
        state = (m.content.get("confirm") or {}).get("state")
        if state in ("confirmed", "cancelled"):
            return Response({"error": f"already {state}", "code": "CONFIRM_SETTLED"},
                            status=409)
        action = request.data.get("action")
        if action == "cancel":
            m.content = {**m.content, "confirm": {**m.content["confirm"], "state": "cancelled"}}
            m.save(update_fields=["content", "updated_at"])
            # 协议 v2 §五：操作响应定点返回更新后的单条消息，前端定点更新不回拉
            return Response({"confirmedCard": _message_json(m), "state": "cancelled"})

        if action != "confirm":
            return Response({"error": "action must be confirm or cancel"}, status=400)

        # 建卡闸门（与 IssueViewSet.create 同判据，fail-closed）。
        # 用户友好：未指定 projectId 时取团队唯一活跃绑定项目（单项目团队主流，
        # 免去前端项目下拉）；多项目才要求显式指定。
        from .models import ProjectTeamBinding
        from plane.db.models.project import Project
        from plane.db.models.issue import Issue
        bound = Project.objects.filter(
            workspace__slug=slug, team_bindings__team=conv.team,
            team_bindings__status=ProjectTeamBinding.Status.ACTIVE,
            team_bindings__workflow_version__isnull=False).distinct()
        requested = request.data.get("projectId")
        if requested:
            project = bound.filter(id=requested).first()
        else:
            project = bound.first() if bound.count() == 1 else None
            if project is None and bound.count() > 1:
                return Response({"error": "团队绑定多个项目，请指定 projectId",
                                 "code": "PROJECT_AMBIGUOUS"}, status=409)
        if project is None:
            return Response({"error": "项目未绑定本团队或未配置流程",
                             "code": "PROJECT_NOT_BOUND"}, status=409)
        card = m.content["confirm"]
        issue = Issue.objects.create(
            project=project,
            name=card["title"][:255],
            description_html=f"<p>{card['description']}</p>"[:20000],
            created_by=request.user,
        )
        m.content = {**m.content, "confirm": {**card, "state": "confirmed",
                                              "issueId": str(issue.id)}}
        m.save(update_fields=["content", "updated_at"])
        flow_msg = AgentMessage.objects.create(
            conversation=conv, role=AgentMessage.Role.AGENT,
            kind=AgentMessage.Kind.FLOW_CARD,
            content={"text": "", "card": {"issueId": str(issue.id), "projectId": str(project.id),
                                          "title": issue.name, "status": "已自动开始执行"}})
        conv.last_message_at = dj_tz.now()
        conv.save(update_fields=["last_message_at", "updated_at"])
        # 协议 v2 §五：操作响应定点返回受影响消息快照（确认卡 + 新流程卡），
        # 前端定点更新不回拉
        return Response({"confirmedCard": _message_json(m), "flowCard": _message_json(flow_msg),
                         "state": "confirmed", "issueId": str(issue.id)})


class ConversationShareEndpoint(BaseAPIView):
    """贴回卡片（§1 #10 产物管理）：会话产出以发起人身份落目标卡评论。

    - 内容 = 来源行（来自与「员工名」的对话）+ markdown→HTML（tables 扩展，
      员工产出的报关草稿等表格保真渲染）
    - 贴到执行中的卡时获 C8-B 增益：agent 阶段间隙自取该卡新评论并采纳
    - actor/created_by = 发起人（用户分享，非 bot 代发）
    """

    def post(self, request, slug, conversation_id, message_id):
        conv = _load_conversation(request, slug, conversation_id)
        if conv is None:
            return Response({"error": "conversation not found"}, status=404)
        m = conv.messages.filter(id=message_id, role=AgentMessage.Role.AGENT).first()
        if m is None or not (m.content or {}).get("text"):
            return Response({"error": "message has no content to share"}, status=404)
        from plane.db.models.issue import Issue, IssueComment
        issue = Issue.objects.filter(
            workspace__slug=slug, id=request.data.get("issueId")).first()
        if issue is None:
            return Response({"error": "issue not found"}, status=404)
        import markdown as _md
        from django.utils.html import escape
        html_body = _md.markdown(m.content["text"], extensions=["tables", "fenced_code", "nl2br"])
        from .agent_directory import resolve_agent_names
        names = resolve_agent_names([conv.agent_member.agent_definition_id])
        agent_name = names.get(conv.agent_member.agent_definition_id) or conv.agent_member.role
        comment = IssueComment.objects.create(
            workspace_id=issue.workspace_id, project_id=issue.project_id,
            issue=issue, actor=request.user, created_by=request.user,
            comment_html=(f'<p>📌 来自与「{escape(agent_name)}」的对话</p>{html_body}'))
        # 回执挂载到原消息（Slack forwarded-to 模式，11-18 定案）：content.shared_to
        # 记录目标卡——原消息气泡底部渲染「已分享到《卡名》」标记，上下文清晰、
        # 不产生打断对话流的独立消息；同一条消息多次分享自然叠加
        from django.utils import timezone as _tz
        shared_to = list(m.content.get("sharedTo") or [])
        shared_to.append({"issueId": str(issue.id), "projectId": str(issue.project_id),
                          "title": issue.name, "at": _tz.now().isoformat()})
        m.content = {**m.content, "sharedTo": shared_to}
        m.save(update_fields=["content", "updated_at"])
        # 协议 v2 §五：操作响应定点返回更新后的原消息（含 sharedTo 回执），前端定点更新
        return Response({"commentId": str(comment.id), "issueId": str(issue.id),
                         "issueName": issue.name, "sharedMessage": _message_json(m)})
