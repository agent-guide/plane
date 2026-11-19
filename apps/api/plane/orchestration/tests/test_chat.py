# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""数字员工会话 API 测试（P2 一期批次 1：模型/CRUD/发消息/流式/确认卡/摘要）。"""

from django.contrib.auth import get_user_model
from django.test import TestCase

from plane.db.models.workspace import Workspace
from plane.db.models.workspace import WorkspaceMember

from plane.orchestration import services
from plane.orchestration.models import AgentConversation, AgentMessage

User = get_user_model()


def _fake_stream(events):
    def _stream(**kwargs):
        yield from events
    return _stream


class ChatTestBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user(email="chat-o@test.io", username="chat-o")
        cls.other = User.objects.create_user(email="chat-x@test.io", username="chat-x")
        cls.ws = Workspace.objects.create(name="chatws", slug="chatws-orch", owner=cls.owner)
        WorkspaceMember.objects.create(workspace=cls.ws, member=cls.owner, role=20)
        WorkspaceMember.objects.create(workspace=cls.ws, member=cls.other, role=15)
        cls.team = services.create_team(workspace_id=cls.ws.id, user_id=cls.owner.id,
                                        is_admin=True, name="会话团队")
        cls.agent_member = services.add_member(
            team=cls.team, user_id=cls.owner.id, is_admin=True, kind="agent",
            role="录入员", agent_definition_id="agent:t1:analyst",
            capabilities=["报关单录入", "毛重核对"])
        services.activate_team(team=cls.team, user_id=cls.owner.id, is_admin=True)

    def _create_conversation(self, as_user=None):
        from django.test import Client
        client = Client()
        client.force_login(as_user or self.owner)
        r = client.post("/api/workspaces/chatws-orch/agent-teams/conversations/",
                        {"teamId": str(self.team.id), "agentMemberId": str(self.agent_member.id)},
                        content_type="application/json")
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()["id"]


class ConversationCrudTests(ChatTestBase):
    def test_create_list_and_rename(self):
        cid = self._create_conversation()
        # 列表（发起人）
        from django.test import Client
        client = Client()
        client.force_login(self.owner)
        r = client.get("/api/workspaces/chatws-orch/agent-teams/conversations/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()), 1)
        # 会话名不可改（员工名=管理端权威数据；PATCH 仅已读/恢复）
        r = client.patch(f"/api/workspaces/chatws-orch/agent-teams/conversations/{cid}/",
                         {"title": "擅自改名"}, content_type="application/json")
        self.assertEqual(r.status_code, 200)
        conv = AgentConversation.objects.get(id=cid)
        self.assertNotEqual(conv.title, "擅自改名")

    def test_private_to_owner(self):
        """一期私有：非发起人视同不存在（404）。"""
        cid = self._create_conversation()
        from django.test import Client
        client = Client()
        client.force_login(self.other)
        r = client.get(f"/api/workspaces/chatws-orch/agent-teams/conversations/{cid}/messages/")
        self.assertEqual(r.status_code, 404)
        r = client.delete(f"/api/workspaces/chatws-orch/agent-teams/conversations/{cid}/")
        self.assertEqual(r.status_code, 404)
        # 发起人自己可删（审计口径：仅整会话可删）
        client.force_login(self.owner)
        r = client.delete(f"/api/workspaces/chatws-orch/agent-teams/conversations/{cid}/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            AgentConversation.objects.filter(id=cid, deleted_at__isnull=True).count(), 0)

    def test_create_validates_member(self):
        from django.test import Client
        client = Client()
        client.force_login(self.owner)
        # member 必须是启用中的 agent 成员（human/不存在均 404）
        human = services.add_member(team=self.team, user_id=self.owner.id, is_admin=True,
                                    kind="human", role="dev", user_ref=self.owner.id)
        r = client.post("/api/workspaces/chatws-orch/agent-teams/conversations/",
                        {"teamId": str(self.team.id), "agentMemberId": str(human.id)},
                        content_type="application/json")
        self.assertEqual(r.status_code, 404)


class SendMessageTests(ChatTestBase):
    def _post_message(self, cid, text="毛重以单据 480 为准"):
        from django.test import Client
        client = Client()
        client.force_login(self.owner)
        return client.post(f"/api/workspaces/chatws-orch/agent-teams/conversations/{cid}/messages/",
                           {"text": text}, content_type="application/json")

    def test_message_round_trip_with_streaming(self):
        """发消息 → 用户消息落库 → 员工流式回复落库（mock turn）。"""
        from unittest.mock import patch
        cid = self._create_conversation()
        events = [{"type": "delta", "text": "收到，"},
                  {"type": "delta", "text": "以 480 为准录入。"},
                  {"type": "done"}]
        with patch("plane.orchestration.chat.stream_agent_turn", side_effect=_fake_stream(events)):
            r = self._post_message(cid)
        self.assertEqual(r.status_code, 200)
        body = b"".join(r.streaming_content).decode()
        self.assertIn("event: delta", body)
        self.assertIn("以 480 为准录入", body)
        self.assertIn("event: done", body)
        conv = AgentConversation.objects.get(id=cid)
        messages = list(conv.messages.order_by("created_at"))
        self.assertEqual(messages[0].role, "user")
        self.assertEqual(messages[0].content["text"], "毛重以单据 480 为准")
        self.assertEqual(messages[1].role, "agent")
        self.assertEqual(messages[1].content["text"], "收到，以 480 为准录入。")

    def test_stage_event_forwarded(self):
        """协议 v2 §六：进度 stage 事件经 SSE 转发（tool_call 进度透传）。"""
        import json as _json
        from unittest.mock import patch
        cid = self._create_conversation()
        events = [{"type": "stage", "phase": "tool", "label": "正在调用 url_reader…"},
                  {"type": "done"}]
        with patch("plane.orchestration.chat.stream_agent_turn", side_effect=_fake_stream(events)):
            r = self._post_message(cid)
        body = b"".join(r.streaming_content).decode()
        self.assertIn("event: stage", body)
        self.assertIn("正在调用 url_reader…", body)

    def test_done_carries_snapshot_and_version(self):
        """协议 v2 §四：done 帧带定稿快照（content/stopReason）+ 版本字段 v=2。"""
        import json as _json
        from unittest.mock import patch
        cid = self._create_conversation()
        events = [{"type": "delta", "text": "正文内容"},
                  {"type": "done", "stopReason": ""}]
        with patch("plane.orchestration.chat.stream_agent_turn", side_effect=_fake_stream(events)):
            r = self._post_message(cid)
        body = b"".join(r.streaming_content).decode()
        # 抽 done 帧的 data JSON，断言快照与版本
        done_frame = None
        for block in body.split("\n\n"):
            if block.startswith("event: done"):
                done_frame = block
        self.assertIsNotNone(done_frame, "SSE 应含 done 帧")
        data_line = next(l for l in done_frame.split("\n") if l.startswith("data: "))
        payload = _json.loads(data_line[len("data: "):])
        self.assertEqual(payload["v"], 2)
        self.assertEqual(payload["content"]["text"], "正文内容")
        self.assertEqual(payload["messageId"], (AgentConversation.objects.get(id=cid).messages
                                                .filter(role="agent").last().id))

    def test_done_snapshot_carries_confirm_structure(self):
        """协议 v2 §五：确认卡场景 done 帧 content 携带 confirm 结构（供前端定稿渲染卡片）。"""
        import json as _json
        from unittest.mock import patch
        cid = self._create_conversation()
        card_json = '```json\n{"type": "create_card", "title": "出口报关-001", "description": "毛重 480"}\n```'
        with patch("plane.orchestration.chat.stream_agent_turn",
                   side_effect=_fake_stream([{"type": "delta", "text": card_json}, {"type": "done"}])):
            r = self._post_message(cid)
        body = b"".join(r.streaming_content).decode()
        done_frame = next(b for b in body.split("\n\n") if b.startswith("event: done"))
        payload = _json.loads(next(l for l in done_frame.split("\n") if l.startswith("data: "))[len("data: "):])
        self.assertEqual(payload["kind"], "confirm_card")
        self.assertEqual(payload["content"]["confirm"]["title"], "出口报关-001")

    def test_confirm_card_recognition(self):
        """回复为建卡 JSON → 消息落成 confirm_card（L1 确认卡）。"""
        from unittest.mock import patch
        cid = self._create_conversation()
        card_json = '```json\n{"type": "create_card", "title": "出口报关-001", "description": "毛重 480"}\n```'
        with patch("plane.orchestration.chat.stream_agent_turn",
                   side_effect=_fake_stream([{"type": "delta", "text": card_json}, {"type": "done"}])):
            r = self._post_message(cid)
        self.assertEqual(r.status_code, 200)
        b"".join(r.streaming_content)  # 消费流（生成器惰性：不读不执行 done 分支）
        reply = (AgentConversation.objects.get(id=cid).messages
                .filter(role="agent").order_by("created_at").last())
        self.assertEqual(reply.kind, AgentMessage.Kind.CONFIRM_CARD)
        self.assertEqual(reply.content["confirm"]["title"], "出口报关-001")

    def test_error_normalizes_to_sse_error_event(self):
        """员工 turn 失败 → SSE error 事件（D1 归一化），回复消息带 error。"""
        from unittest.mock import patch
        from plane.orchestration.worker import AgentTurnError
        cid = self._create_conversation()

        def _boom(**kwargs):
            raise AgentTurnError("not_deployed", "no deployment for agent x")
            yield  # pragma: no cover

        with patch("plane.orchestration.chat.stream_agent_turn", side_effect=_boom):
            r = self._post_message(cid)
        self.assertEqual(r.status_code, 200)
        body = b"".join(r.streaming_content).decode()
        self.assertIn("event: error", body)
        self.assertIn("not_deployed", body)

    def test_unexpected_exception_does_not_leave_empty_message(self):
        """协议 v2 §P4 收口健壮性：消费端非预期异常落 error，不留空消息不 500。"""
        from unittest.mock import patch
        cid = self._create_conversation()

        def _boom(**kwargs):
            raise ValueError("unexpected decode failure")
            yield  # pragma: no cover

        with patch("plane.orchestration.chat.stream_agent_turn", side_effect=_boom):
            r = self._post_message(cid)
        self.assertEqual(r.status_code, 200)
        body = b"".join(r.streaming_content).decode()
        self.assertIn("event: error", body)
        reply = (AgentConversation.objects.get(id=cid).messages
                 .filter(role="agent").order_by("created_at").last())
        self.assertIsNotNone(reply.content.get("error"), "兜底后消息应带 error 而非空 content")
        self.assertEqual(reply.content["error"]["code"], "agent_error")

    def test_history_pagination(self):
        cid = self._create_conversation()
        conv = AgentConversation.objects.get(id=cid)
        for i in range(3):
            AgentMessage.objects.create(conversation=conv, role="user",
                                        content={"text": f"m{i}"})
        from django.test import Client
        client = Client()
        client.force_login(self.owner)
        r = client.get(f"/api/workspaces/chatws-orch/agent-teams/conversations/{cid}/messages/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([m["content"]["text"] for m in r.json()], ["m0", "m1", "m2"])


class HistoryCompactionTests(ChatTestBase):
    def test_rolling_summary_keeps_recent_and_summarizes_overflow(self):
        """滚动摘要：超阈值后旧消息进摘要、近期原文保留（§3.2 拍板 1）。"""
        from plane.orchestration.chat import maybe_compact_history
        cid = self._create_conversation()
        conv = AgentConversation.objects.get(id=cid)
        # 构造：5 条近期（窗口保底）+ 若干长消息（溢出）
        for i in range(10):
            AgentMessage.objects.create(
                conversation=conv, role="user" if i % 2 else "agent",
                content={"text": f"早期消息{i}：" + "长内容" * 400})
        maybe_compact_history(conv)
        conv.refresh_from_db()
        self.assertTrue(conv.summary, "摘要未生成")
        self.assertIn("早期消息0", conv.summary[:200])
        self.assertTrue(conv.summary_through, "摘要游标未落")
        # 近期 5 条仍在摘要外（原文保真，不丢）
        kept = conv.messages.filter(
            id__in=[m.id for m in conv.messages.order_by("-created_at")[:5]])
        self.assertEqual(kept.count(), 5)
        # 摘要有界
        self.assertLessEqual(len(conv.summary), 4000)


class ConfirmCardTests(ChatTestBase):
    """L1 确认卡执行（§2.2.1）：confirm 建卡走闸门 / cancel / 幂等 / 流程卡回贴。"""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        from plane.db.models.project import Project
        from plane.orchestration import services, workflows
        from plane.orchestration.models import WorkflowDefinition
        from .canvas import CANVAS_SINGLE
        cls.project = Project.objects.create(
            name="chatproj", identifier="CHATORCH", workspace=cls.ws, created_by=cls.owner)
        wf = WorkflowDefinition.objects.create(project=cls.project, name="会话流程", created_by=cls.owner)
        workflows.update_draft(workflow=wf, user_id=cls.owner.id, draft=CANVAS_SINGLE)
        workflows.save_draft_version(workflow=wf, user_id=cls.owner.id)
        pub = workflows.start_publish(workflow=wf, user_id=cls.owner.id)
        cls.version = workflows.finish_publish(version=pub, engine_deploy_ref={})
        services.bind_project(project=cls.project, team=cls.team, user_id=cls.owner.id,
                              is_admin=True, workflow_version=cls.version)

    def _seed_confirm_card(self, cid):
        conv = AgentConversation.objects.get(id=cid)
        return AgentMessage.objects.create(
            conversation=conv, role=AgentMessage.Role.AGENT,
            kind=AgentMessage.Kind.CONFIRM_CARD,
            content={"text": "", "confirm": {"title": "出口报关-会话转卡",
                                             "description": "已整理 68 票，3 票存疑",
                                             "workflowHint": ""}})

    def _confirm(self, cid, mid, action="confirm", project_id=None):
        from django.test import Client
        client = Client()
        client.force_login(self.owner)
        return client.post(
            f"/api/workspaces/chatws-orch/agent-teams/conversations/{cid}/messages/{mid}/confirm/",
            {"action": action, "projectId": str(project_id or self.project.id)},
            content_type="application/json")

    def test_confirm_creates_issue_and_flow_card(self):
        from plane.db.models.issue import Issue
        from plane.orchestration.models import WorkItemExecution
        cid = self._create_conversation()
        card = self._seed_confirm_card(cid)
        r = self._confirm(cid, card.id)
        self.assertEqual(r.status_code, 200, r.content)
        issue_id = r.json()["issueId"]
        issue = Issue.objects.get(id=issue_id)
        self.assertEqual(issue.name, "出口报关-会话转卡")
        self.assertIn("已整理 68 票", issue.description_html)  # partial 随卡转移
        # signal 自动执行（闸门链通）
        self.assertTrue(WorkItemExecution.objects.filter(issue=issue).exists())
        # 流程卡回贴会话
        conv = AgentConversation.objects.get(id=cid)
        flow = conv.messages.filter(kind=AgentMessage.Kind.FLOW_CARD).last()
        self.assertIsNotNone(flow)
        self.assertEqual(flow.content["card"]["issueId"], str(issue_id))
        # 确认卡状态落定
        card.refresh_from_db()
        self.assertEqual(card.content["confirm"]["state"], "confirmed")

    def test_confirm_gate_rejects_unbound_project(self):
        from plane.db.models.project import Project
        other = Project.objects.create(
            name="unbound", identifier="UNBOUND", workspace=self.ws, created_by=self.owner)
        cid = self._create_conversation()
        card = self._seed_confirm_card(cid)
        r = self._confirm(cid, card.id, project_id=other.id)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["code"], "PROJECT_NOT_BOUND")

    def test_cancel_and_idempotency(self):
        cid = self._create_conversation()
        card = self._seed_confirm_card(cid)
        r = self._confirm(cid, card.id, action="cancel")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["state"], "cancelled")
        # 已决状态重复提交 → 409（幂等防线）
        r = self._confirm(cid, card.id)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["code"], "CONFIRM_SETTLED")


class CheckpointAndReadTests(ChatTestBase):
    """T1 预算检查点三选（§3.3）+ 已读游标。"""

    def test_timeout_error_becomes_checkpoint_with_options(self):
        """超时 + 已有 partial → error 事件带 checkpoint/options（不判死）。"""
        from unittest.mock import patch
        from plane.orchestration.worker import AgentTurnError
        cid = self._create_conversation()

        def _boom(**kwargs):
            yield {"type": "delta", "text": "已整理 68 票，"}
            raise AgentTurnError("timeout", "agent turn total timeout: exceeded 1800s budget")

        with patch("plane.orchestration.chat.stream_agent_turn", side_effect=_boom):
            from django.test import Client
            client = Client()
            client.force_login(self.owner)
            r = client.post(f"/api/workspaces/chatws-orch/agent-teams/conversations/{cid}/messages/",
                            {"text": "整理这批数据"}, content_type="application/json")
        body = b"".join(r.streaming_content).decode()
        self.assertIn("event: error", body)
        self.assertIn("checkpoint", body)
        self.assertIn('"continue"', body)
        reply = (AgentConversation.objects.get(id=cid).messages
                 .filter(role="agent").order_by("created_at").last())
        self.assertTrue(reply.content["checkpoint"])
        self.assertIn("已整理 68 票", reply.content["text"])  # partial 保留

    def test_unread_follows_wechat_model(self):
        """未读=微信模型：仅员工（agent）消息产生未读；用户自己发的不算；
        markRead 清除。"""
        cid = self._create_conversation()
        from django.test import Client
        from unittest.mock import patch
        client = Client()
        client.force_login(self.owner)
        # ① 仅用户消息（无 agent 回复，mock 流直接空 done）→ 不未读
        with patch("plane.orchestration.chat.stream_agent_turn",
                   side_effect=_fake_stream([{"type": "done"}])):
            client.post(f"/api/workspaces/chatws-orch/agent-teams/conversations/{cid}/messages/",
                        {"text": "hi"}, content_type="application/json")
        r = client.get("/api/workspaces/chatws-orch/agent-teams/conversations/")
        self.assertFalse(r.json()[0]["unread"], "用户自己发消息不应产生未读")
        # ② agent 回复落库 → 未读
        with patch("plane.orchestration.chat.stream_agent_turn",
                   side_effect=_fake_stream([{"type": "delta", "text": "好"}, {"type": "done"}])):
            resp = client.post(f"/api/workspaces/chatws-orch/agent-teams/conversations/{cid}/messages/",
                               {"text": "在吗"}, content_type="application/json")
            b"".join(resp.streaming_content)  # 消费流（生成器惰性：done 分支才落回复）
        r = client.get("/api/workspaces/chatws-orch/agent-teams/conversations/")
        self.assertTrue(r.json()[0]["unread"], "员工回复应产生未读")
        # ③ markRead → 清除
        r = client.patch(f"/api/workspaces/chatws-orch/agent-teams/conversations/{cid}/",
                         {"markRead": True}, content_type="application/json")
        self.assertEqual(r.status_code, 200)
        r = client.get("/api/workspaces/chatws-orch/agent-teams/conversations/")
        self.assertFalse(r.json()[0]["unread"])
