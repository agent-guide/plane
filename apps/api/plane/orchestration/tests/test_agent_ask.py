# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""agent 能力化求助测试（2026-11-05 定案）：AI 节点执行中缺数据 →
waiting_human + 自由文本审批；答复 → 同节点重跑（attempt+1 + 答复注入
agent.invoke）；拒绝 → 取消执行。节点全程保持 RUNNING（区别于人工节点
收口 success），DAG 无感知。"""

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
