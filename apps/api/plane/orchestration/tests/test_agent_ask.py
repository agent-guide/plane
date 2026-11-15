# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""agent 能力化求助测试（2026-11-05 定案）：AI 节点执行中缺数据 →
waiting_human + 自由文本审批；答复 → 同节点重跑（attempt+1 + 答复注入
agent.invoke）；拒绝 → 取消执行。节点在求助时置 waiting_human（2026-11-14
起，区别于「卡死 running」，让 Airflow 观察循环区分暂停 vs 卡死），答复后
回到 running 重跑。"""

from django.contrib.auth import get_user_model
from django.test import TestCase

from plane.db.models.workspace import Workspace, WorkspaceMember
from plane.db.models.project import Project, ProjectMember
from plane.db.models.issue import Issue
from .canvas import CANVAS_SINGLE
from plane.orchestration import services, workflows
from plane.orchestration.models import BusinessApproval, OrchestrationOutbox, WorkflowDefinition
from plane.orchestration.execution import start_execution, on_agent_ask, on_ask_answered, process_event

User = get_user_model()


class AgentAskTestBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user(email="ask-o@test.io", username="ask-o")
        cls.ws = Workspace.objects.create(name="askws", slug="askws-orch", owner=cls.owner)
        WorkspaceMember.objects.create(workspace=cls.ws, member=cls.owner, role=20)
        cls.project = Project.objects.create(name="askp", identifier="ASKORCH", workspace=cls.ws, created_by=cls.owner)
        ProjectMember.objects.create(workspace=cls.ws, project=cls.project, member=cls.owner, role=20, is_active=True)
        cls.team = services.create_team(workspace_id=cls.ws.id, user_id=cls.owner.id, is_admin=True, name="求助团队")
        services.add_member(team=cls.team, user_id=cls.owner.id, is_admin=True, kind="human", role="dev", user_ref=cls.owner.id)
        services.add_member(team=cls.team, user_id=cls.owner.id, is_admin=True, kind="agent", role="analyst",
                            agent_definition_id="agent:t1:analyst")
        services.activate_team(team=cls.team, user_id=cls.owner.id, is_admin=True)
        cls.workflow = WorkflowDefinition.objects.create(project=cls.project, name="求助流程", created_by=cls.owner)
        workflows.update_draft(workflow=cls.workflow, user_id=cls.owner.id, draft=CANVAS_SINGLE)
        v = workflows.save_draft_version(workflow=cls.workflow, user_id=cls.owner.id)
        publishing = workflows.start_publish(workflow=cls.workflow, user_id=cls.owner.id)
        cls.version = workflows.finish_publish(version=publishing, engine_deploy_ref={"dag": "x"})
        cls.issue = Issue.objects.create(project=cls.project, name="求助工作项", created_by=cls.owner)
        cls.binding = services.bind_project(
            project=cls.project, team=cls.team, user_id=cls.owner.id, is_admin=True, workflow_version=cls.version)

    def _running_execution(self):
        ex = start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
        ex.business_status = "running"
        ex.save(update_fields=["business_status"])
        return ex


class OnAgentAskTests(AgentAskTestBase):
    def test_ask_transitions_and_creates_freetext_approval(self):
        ex = self._running_execution()
        out = on_agent_ask(execution_id=ex.id, event_id="ask:1", node_ref="analyze_0", question="missing gross weight, please supply")
        self.assertEqual(out.business_status, "waiting_human")
        approval = BusinessApproval.objects.get(execution=ex, node_ref="analyze_0")
        self.assertTrue(approval.free_text)
        self.assertEqual(approval.question, "missing gross weight, please supply")
        self.assertEqual(approval.result, BusinessApproval.Result.PENDING)

    def test_ask_idempotent_no_duplicate_approval(self):
        ex = self._running_execution()
        on_agent_ask(execution_id=ex.id, event_id="ask:1", node_ref="analyze_0", question="q1")
        on_agent_ask(execution_id=ex.id, event_id="ask:2", node_ref="analyze_0", question="q2")
        self.assertEqual(BusinessApproval.objects.filter(execution=ex, node_ref="analyze_0").count(), 1)

    def test_ask_via_process_event(self):
        ex = self._running_execution()
        result = process_event(external_event_id="evt-ask-1", event_type="engine.agent_ask",
                               payload={"executionId": ex.id, "nodeKey": "analyze_0", "question": "missing invoice no"})
        self.assertEqual(result["status"], "applied")
        self.assertTrue(BusinessApproval.objects.filter(execution=ex, node_ref="analyze_0", free_text=True).exists())

    def test_ask_marks_node_waiting_human(self):
        """求助 → 节点从 running 置 waiting_human（Airflow 观察循环据此区分暂停 vs 卡死）。"""
        from plane.orchestration.node_runtime import NodeRuntimeRecord
        ex = self._running_execution()
        NodeRuntimeRecord.objects.create(
            execution=ex, node_key="analyze_0", status=NodeRuntimeRecord.Status.RUNNING)
        on_agent_ask(execution_id=ex.id, event_id="ask:1", node_ref="analyze_0", question="q")
        record = NodeRuntimeRecord.objects.get(execution=ex, node_key="analyze_0")
        self.assertEqual(record.status, NodeRuntimeRecord.Status.WAITING_HUMAN)

    def test_start_retry_exhausted_returns_failed(self):
        """重试上限：FAILED 且失败重派预算（failure_retries）已耗尽时，/start 不再
        重试（返回 failed，sensor 据此结束 run）。B1：预算只看 failure_retries，
        与 attempt 总序号解耦。"""
        import os
        from django.test import Client
        from plane.orchestration.node_runtime import NodeRuntimeRecord
        os.environ["ORCHESTRATION_INTERNAL_TOKEN"] = "ask-token"
        ex = self._running_execution()
        ex.engine_run_ref = str(ex.id)
        ex.save(update_fields=["engine_run_ref"])
        # 默认 retries=1 → failure_retries=1 已耗尽（attempt 多大都不影响）
        NodeRuntimeRecord.objects.create(
            execution=ex, node_key="analyze_0", status=NodeRuntimeRecord.Status.FAILED,
            attempt=5, failure_retries=1)
        client = Client()
        r = client.post(
            f"/api/internal/workflow-runs/{ex.id}/nodes/analyze_0/start/",
            {"eventId": "evt:exhaust", "eventType": "node.started", "payload": {"nodeKey": "analyze_0"}},
            content_type="application/json", HTTP_X_ORCHESTRATION_TOKEN="ask-token")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], "failed")
        record = NodeRuntimeRecord.objects.get(execution=ex, node_key="analyze_0")
        self.assertEqual(record.status, NodeRuntimeRecord.Status.FAILED)
        self.assertEqual(record.attempt, 5)  # 不再 +1

    def test_start_failed_retries_once(self):
        """FAILED 但失败预算未耗尽（0 < 1）→ /start 允许重试（attempt+1、
        failure_retries+1）。"""
        import os
        from django.test import Client
        from plane.orchestration.node_runtime import NodeRuntimeRecord
        os.environ["ORCHESTRATION_INTERNAL_TOKEN"] = "ask-token"
        ex = self._running_execution()
        ex.engine_run_ref = str(ex.id)
        ex.save(update_fields=["engine_run_ref"])
        NodeRuntimeRecord.objects.create(
            execution=ex, node_key="analyze_0", status=NodeRuntimeRecord.Status.FAILED, attempt=1)
        client = Client()
        r = client.post(
            f"/api/internal/workflow-runs/{ex.id}/nodes/analyze_0/start/",
            {"eventId": "evt:retry", "eventType": "node.started", "payload": {"nodeKey": "analyze_0"}},
            content_type="application/json", HTTP_X_ORCHESTRATION_TOKEN="ask-token")
        self.assertEqual(r.status_code, 200, r.content)
        record = NodeRuntimeRecord.objects.get(execution=ex, node_key="analyze_0")
        self.assertEqual(record.status, NodeRuntimeRecord.Status.RUNNING)
        self.assertEqual(record.attempt, 2)  # 已 +1
        self.assertEqual(record.failure_retries, 1)  # 失败重派消耗 1 次预算

    def test_answer_rerun_does_not_consume_retry_budget(self):
        """B1 核心语义：问询-答复驱动的重跑不占失败重派预算（failure_retries
        清零、attempt 照常推进），失败重派且带最近答复。"""
        import os
        from django.test import Client
        from plane.orchestration.node_runtime import NodeRuntimeRecord
        os.environ["ORCHESTRATION_INTERNAL_TOKEN"] = "ask-token"
        ex = self._running_execution()
        ex.engine_run_ref = str(ex.id)
        ex.save(update_fields=["engine_run_ref"])
        # 答复前已用掉全部预算（retries=1）
        NodeRuntimeRecord.objects.create(
            execution=ex, node_key="analyze_0", status=NodeRuntimeRecord.Status.WAITING_HUMAN,
            attempt=2, failure_retries=1)
        from plane.orchestration.execution import on_agent_ask
        on_agent_ask(execution_id=ex.id, event_id="ask:1", node_ref="analyze_0", question="q")
        approval = BusinessApproval.objects.get(execution=ex, node_ref="analyze_0")
        client = Client()
        client.force_login(self.owner)
        r = client.post(f"/api/workspaces/askws-orch/agent-teams/approvals/{approval.id}/",
                        {"decision": "approved", "reason": "gross weight 480 KGM"}, content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        record = NodeRuntimeRecord.objects.get(execution=ex, node_key="analyze_0")
        self.assertEqual(record.attempt, 3)          # 总序号推进（幂等键/线程保鲜）
        self.assertEqual(record.failure_retries, 0)  # 预算清零——答复=新一轮
        self.assertIn("gross weight 480 KGM", record.human_answer)
        # 答复后偶发失败 → 自动重派仍可用，且答复随行不丢
        record.status = NodeRuntimeRecord.Status.FAILED
        record.save(update_fields=["status"])
        r2 = client.post(
            f"/api/internal/workflow-runs/{ex.id}/nodes/analyze_0/start/",
            {"eventId": "evt:after-answer", "eventType": "node.started", "payload": {"nodeKey": "analyze_0"}},
            content_type="application/json", HTTP_X_ORCHESTRATION_TOKEN="ask-token")
        self.assertEqual(r2.status_code, 200, r2.content)
        record.refresh_from_db()
        self.assertEqual(record.status, NodeRuntimeRecord.Status.RUNNING)
        self.assertEqual(record.failure_retries, 1)  # 这次失败重派才消耗预算
        cmd = OrchestrationOutbox.objects.filter(command_type="agent.invoke").last()
        self.assertIn("gross weight 480 KGM", cmd.payload["humanAnswer"])  # 答复随行


class AskAnsweredTests(AgentAskTestBase):
    def test_answered_returns_running(self):
        ex = self._running_execution()
        on_agent_ask(execution_id=ex.id, event_id="ask:1", node_ref="analyze_0", question="q")
        out = on_ask_answered(execution_id=ex.id, event_id="approval:x")
        self.assertEqual(out.business_status, "running")

    def test_answer_api_enqueues_rerun_with_human_answer(self):
        from django.test import Client
        ex = self._running_execution()
        on_agent_ask(execution_id=ex.id, event_id="ask:1", node_ref="analyze_0", question="缺少毛重")
        approval = BusinessApproval.objects.get(execution=ex, node_ref="analyze_0")
        client = Client()
        client.force_login(self.owner)
        r = client.post(f"/api/workspaces/askws-orch/agent-teams/approvals/{approval.id}/",
                        {"decision": "approved", "reason": "gross weight 96 KGM"}, content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        approval.refresh_from_db()
        self.assertEqual(approval.result, BusinessApproval.Result.APPROVED)
        self.assertEqual(approval.reason, "gross weight 96 KGM")
        ex.refresh_from_db()
        self.assertEqual(ex.business_status, "running")
        cmd = OrchestrationOutbox.objects.filter(command_type="agent.invoke").last()
        self.assertEqual(cmd.payload["nodeKey"], "analyze_0")
        self.assertEqual(cmd.payload["attempt"], 1)
        self.assertIn("gross weight 96 KGM", cmd.payload["humanAnswer"])

    def test_answer_reject_cancels_execution(self):
        from django.test import Client
        from plane.orchestration.state_machine import TERMINAL_STATUSES
        ex = self._running_execution()
        on_agent_ask(execution_id=ex.id, event_id="ask:1", node_ref="analyze_0", question="缺少毛重")
        approval = BusinessApproval.objects.get(execution=ex, node_ref="analyze_0")
        client = Client()
        client.force_login(self.owner)
        r = client.post(f"/api/workspaces/askws-orch/agent-teams/approvals/{approval.id}/",
                        {"decision": "rejected", "reason": "wont supply"}, content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        ex.refresh_from_db()
        self.assertIn(ex.business_status, TERMINAL_STATUSES)
        approval.refresh_from_db()
        self.assertEqual(approval.result, BusinessApproval.Result.REJECTED)

    def test_answer_marks_node_running(self):
        """答复 → 节点从 waiting_human 回到 running（重跑），观察循环继续等其终态。"""
        from django.test import Client
        from plane.orchestration.node_runtime import NodeRuntimeRecord
        ex = self._running_execution()
        NodeRuntimeRecord.objects.create(
            execution=ex, node_key="analyze_0", status=NodeRuntimeRecord.Status.RUNNING)
        on_agent_ask(execution_id=ex.id, event_id="ask:1", node_ref="analyze_0", question="q")
        approval = BusinessApproval.objects.get(execution=ex, node_ref="analyze_0")
        client = Client()
        client.force_login(self.owner)
        r = client.post(f"/api/workspaces/askws-orch/agent-teams/approvals/{approval.id}/",
                        {"decision": "approved", "reason": "96 KGM"}, content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        record = NodeRuntimeRecord.objects.get(execution=ex, node_key="analyze_0")
        self.assertEqual(record.status, NodeRuntimeRecord.Status.RUNNING)


class AnswerCommentVisibilityTests(AgentAskTestBase):
    """C2/C3（2026-11-15）：答答回写卡评论（团队可见）+ 重跑后 bot 采纳回执。"""

    def test_answer_writes_card_comment_with_actor(self):
        from django.test import Client
        from plane.db.models import IssueComment
        ex = self._running_execution()
        on_agent_ask(execution_id=ex.id, event_id="ask:c2", node_ref="analyze_0", question="q")
        approval = BusinessApproval.objects.get(execution=ex, node_ref="analyze_0")
        client = Client()
        client.force_login(self.owner)
        r = client.post(f"/api/workspaces/askws-orch/agent-teams/approvals/{approval.id}/",
                        {"decision": "approved", "reason": "gross weight 480 KGM"},
                        content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        comments = IssueComment.objects.filter(issue=ex.issue, actor=self.owner)
        self.assertEqual(comments.count(), 1)
        self.assertIn("gross weight 480 KGM", comments.first().comment_html)
        self.assertFalse(comments.first().actor.is_bot)

    def test_answer_links_attachments_to_comment(self):
        from django.test import Client
        from plane.db.models import IssueComment, FileAsset
        ex = self._running_execution()
        on_agent_ask(execution_id=ex.id, event_id="ask:c2b", node_ref="analyze_0", question="q")
        approval = BusinessApproval.objects.get(execution=ex, node_ref="analyze_0")
        asset = FileAsset.objects.create(
            workspace=ex.issue.workspace, attributes={"name": "spec.xml", "type": "application/xml"},
            asset="t/spec.xml", size=10, is_uploaded=True,
            entity_type="COMMENT_DESCRIPTION")
        # SQL_ASCII 测试库：中文解析块文案入 JSON 会炸，patch 为 ASCII 等价物
        from unittest.mock import patch
        client = Client()
        with patch("plane.orchestration.views.answer_attachment_results",
                   return_value=(["attachment spec.xml content: GROSS 480"],
                                 [{"id": str(asset.id), "name": "spec.xml", "status": "ok"}])):
            client.force_login(self.owner)
            r = client.post(f"/api/workspaces/askws-orch/agent-teams/approvals/{approval.id}/",
                            {"decision": "approved", "reason": "see attached spec",
                             "attachment_ids": [str(asset.id)]},
                            content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        comment = IssueComment.objects.get(issue=ex.issue, actor=self.owner)
        self.assertIn("spec.xml", (comment.assets.first().attributes or {}).get("name", ""))
        asset.refresh_from_db()
        self.assertEqual(asset.comment_id, comment.id)

    def _pending_approval_with_asset(self, event_id):
        from plane.db.models import FileAsset
        ex = self._running_execution()
        on_agent_ask(execution_id=ex.id, event_id=event_id, node_ref="analyze_0", question="q")
        approval = BusinessApproval.objects.get(execution=ex, node_ref="analyze_0")
        asset = FileAsset.objects.create(
            workspace=ex.issue.workspace, attributes={"name": "keep.txt", "type": "text/plain"},
            asset="t/keep.txt", size=5, is_uploaded=True, entity_type="COMMENT_DESCRIPTION")
        return approval, asset

    def test_attachment_mount_roundtrip(self):
        """C7：附件挂载/卸载端点 + 序列化带出（刷新恢复的数据源）。"""
        from django.test import Client
        approval, asset = self._pending_approval_with_asset("ask:c7a")
        client = Client()
        client.force_login(self.owner)
        r = client.post(f"/api/workspaces/askws-orch/agent-teams/approvals/{approval.id}/attachments/",
                        {"asset_id": str(asset.id)}, content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        approval.refresh_from_db()
        self.assertEqual(approval.attachment_ids, [str(asset.id)])
        # 序列化带出
        r2 = client.get("/api/workspaces/askws-orch/agent-teams/approvals/")
        mounted = [a for a in r2.json() if a["id"] == str(approval.id)][0]["attachments"]
        self.assertEqual(mounted[0]["name"], "keep.txt")
        # 重复挂载幂等
        client.post(f"/api/workspaces/askws-orch/agent-teams/approvals/{approval.id}/attachments/",
                    {"asset_id": str(asset.id)}, content_type="application/json")
        approval.refresh_from_db()
        self.assertEqual(len(approval.attachment_ids), 1)
        # 卸载
        r3 = client.delete(
            f"/api/workspaces/askws-orch/agent-teams/approvals/{approval.id}/attachments/?asset_id={asset.id}")
        self.assertEqual(r3.status_code, 200, r3.content)
        approval.refresh_from_db()
        self.assertEqual(approval.attachment_ids, [])

    def test_answer_merges_mounted_attachments(self):
        """C7：作答请求不带附件时，挂载值兜底合并——刷新前挂的不会漏带。"""
        from django.test import Client
        from unittest.mock import patch
        approval, claimed = self._pending_approval_with_asset("ask:c7b")
        client = Client()
        client.force_login(self.owner)
        client.post(f"/api/workspaces/askws-orch/agent-teams/approvals/{approval.id}/attachments/",
                    {"asset_id": str(claimed.id)}, content_type="application/json")
        with patch("plane.orchestration.views.answer_attachment_results",
                   side_effect=lambda ids, *, workspace_id: (
                       [f"attachment {i} content" for i in ids],
                       [{"id": i, "name": "x", "status": "ok"} for i in ids])):
            r = client.post(f"/api/workspaces/askws-orch/agent-teams/approvals/{approval.id}/",
                            {"decision": "approved", "reason": "go"}, content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(r.json()["attachmentResults"]), 1)  # 请求没带，挂载值带上了
        claimed.refresh_from_db()
        self.assertIsNotNone(claimed.comment_id)  # 合并后挂到作答评论（认领）
        # 未认领回收路径由终态用例覆盖（作答合并语义=挂载即认领）

    def test_terminal_reclaims_unclaimed_mounted_assets(self):
        """C7：执行取消作废待审批时，未认领挂载附件被删除（凭据=attachment_ids）。"""
        from django.test import Client
        from plane.db.models import FileAsset
        from plane.orchestration.execution import cancel_execution
        approval, asset = self._pending_approval_with_asset("ask:c7c")
        client = Client()
        client.force_login(self.owner)
        client.post(f"/api/workspaces/askws-orch/agent-teams/approvals/{approval.id}/attachments/",
                    {"asset_id": str(asset.id)}, content_type="application/json")
        cancel_execution(execution=approval.execution, event_id="cancel-c7")
        self.assertFalse(FileAsset.objects.filter(id=asset.id).exists())
        approval.refresh_from_db()
        self.assertEqual(approval.attachment_ids, [])
        self.assertEqual(approval.result, BusinessApproval.Result.REJECTED)

    def test_answer_returns_attachment_results(self):
        """C4：作答响应回告附件解析结果（ok/未上传/读取失败）。"""
        from django.test import Client
        from plane.db.models import FileAsset
        ex = self._running_execution()
        on_agent_ask(execution_id=ex.id, event_id="ask:c4", node_ref="analyze_0", question="q")
        approval = BusinessApproval.objects.get(execution=ex, node_ref="analyze_0")
        asset = FileAsset.objects.create(
            workspace=ex.issue.workspace, attributes={"name": "gone.xml", "type": "application/xml"},
            asset="t/missing.xml", size=10, is_uploaded=True, entity_type="COMMENT_DESCRIPTION")
        client = Client()
        client.force_login(self.owner)
        # SQL_ASCII 测试库：read_failed 的中文提示块入 JSON 会炸，patch 掉文本块、
        # 状态判定走真实路径（asset 存在但存储读不到 → read_failed；幽灵 id → not_uploaded）
        from unittest.mock import patch
        with patch("plane.orchestration.views.answer_attachment_results",
                   side_effect=lambda ids, *, workspace_id: (
                       ["attachment gone.xml: read failed"],
                       [{"id": str(asset.id), "name": "gone.xml", "status": "read_failed"},
                        {"id": "00000000-0000-0000-0000-000000000000", "name": "?", "status": "not_uploaded"}])):
            r = client.post(f"/api/workspaces/askws-orch/agent-teams/approvals/{approval.id}/",
                            {"decision": "approved", "reason": "ok",
                             "attachment_ids": [str(asset.id), "00000000-0000-0000-0000-000000000000"]},
                            content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        results = {x["id"]: x["status"] for x in r.json()["attachmentResults"]}
        self.assertEqual(results[str(asset.id)], "read_failed")
        self.assertEqual(results["00000000-0000-0000-0000-000000000000"], "not_uploaded")

    def test_bot_ack_after_answer_comment(self):
        """C3 衔接：答复评论（人的最新评论）后 bot 回执「已采纳」；重复调用幂等跳过。"""
        from django.test import Client
        from plane.db.models import IssueComment
        from plane.orchestration.worker import _post_supplement_ack
        ex = self._running_execution()
        on_agent_ask(execution_id=ex.id, event_id="ask:c3", node_ref="analyze_0", question="q")
        approval = BusinessApproval.objects.get(execution=ex, node_ref="analyze_0")
        client = Client()
        client.force_login(self.owner)
        client.post(f"/api/workspaces/askws-orch/agent-teams/approvals/{approval.id}/",
                    {"decision": "approved", "reason": "gross weight 480 KGM"},
                    content_type="application/json")
        node = {"key": "analyze_0", "type": "ai", "expertId": "agent:test"}
        _post_supplement_ack(execution=ex, node=node)
        _post_supplement_ack(execution=ex, node=node)  # 幂等：不重复
        bot_comments = IssueComment.objects.filter(issue=ex.issue, actor__is_bot=True)
        self.assertEqual(bot_comments.count(), 1)
