# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""worker 切片测试：受控启动校验链 + 引擎事件入口（令牌鉴权/幂等）。"""

from django.contrib.auth import get_user_model
from django.test import Client, TestCase

from plane.db.models.workspace import Workspace, WorkspaceMember
from plane.db.models.project import Project
from plane.db.models.issue import Issue
from plane.orchestration import services, workflows
from plane.orchestration.models import (
    OrchestrationOutbox, WorkflowDefinition, WorkflowVersion,
)
from plane.orchestration.services import TeamDomainError
from plane.orchestration.execution import start_execution

User = get_user_model()


class StartExecutionTestBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user(email="wk-o@test.io", username="wk-o")
        cls.ws = Workspace.objects.create(name="wkws", slug="wkws-orch", owner=cls.owner)
        WorkspaceMember.objects.create(workspace=cls.ws, member=cls.owner, role=20)
        cls.project = Project.objects.create(name="wkp", identifier="WKPORCH", workspace=cls.ws, created_by=cls.owner)
        cls.team = services.create_team(workspace_id=cls.ws.id, user_id=cls.owner.id, is_admin=True, name="启动团队")
        services.add_member(team=cls.team, user_id=cls.owner.id, is_admin=True, kind="human", role="dev", user_ref=cls.owner.id)
        services.activate_team(team=cls.team, user_id=cls.owner.id, is_admin=True)
        cls.workflow = WorkflowDefinition.objects.create(project=cls.project, name="启动流程", created_by=cls.owner)
        workflows.update_draft(workflow=cls.workflow, user_id=cls.owner.id, draft={"nodes": []})
        v = workflows.save_draft_version(workflow=cls.workflow, user_id=cls.owner.id)
        publishing = workflows.start_publish(workflow=cls.workflow, user_id=cls.owner.id)
        cls.version = workflows.finish_publish(version=publishing, engine_deploy_ref={"dag": "x"})
        cls.binding = services.bind_project(
            project=cls.project, team=cls.team, user_id=cls.owner.id, is_admin=True, workflow_version=cls.version)
        cls.issue = Issue.objects.create(project=cls.project, name="启动用工作项", created_by=cls.owner)


class StartExecutionChainTests(StartExecutionTestBase):
    def test_happy_path_frozen_context_and_outbox(self):
        ex = start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
        self.assertEqual(ex.business_status, "queued")
        self.assertEqual(ex.frozen_context["teamId"], str(self.team.id))
        self.assertEqual(ex.frozen_context["members"][0]["kind"], "human")
        cmd = OrchestrationOutbox.objects.get(idempotency_key=f"start:{ex.id}")
        self.assertEqual(cmd.command_type, "engine.start")
        self.assertEqual(cmd.payload["workflowVersionId"], str(self.version.id))

    def test_conflict_on_second_active(self):
        start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
        with self.assertRaises(TeamDomainError) as c:
            start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
        self.assertEqual(c.exception.code, "EXECUTION_CONFLICT")

    def test_rejected_when_team_inactive(self):
        services.archive_team(team=self.team, is_admin=True)
        with self.assertRaises(TeamDomainError) as c:
            start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
        self.assertEqual(c.exception.code, "AGENT_TEAM_INACTIVE")

    def test_rejected_when_no_enabled_member(self):
        from plane.orchestration.models import AgentTeamMember
        # 构造异常态（绕过服务层末位防护）：库级直改
        AgentTeamMember.objects.filter(team=self.team).update(enabled=False)
        with self.assertRaises(TeamDomainError) as c:
            start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
        self.assertEqual(c.exception.code, "AGENT_TEAM_EMPTY")


class EngineEventEndpointTests(StartExecutionTestBase):
    def setUp(self):
        self.internal = Client()
        self.user_client = Client()
        self.user_client.force_login(self.owner)

    def test_token_required(self):
        r = self.internal.post("/api/internal/orchestration/events/", {"eventType": "engine.started"}, content_type="application/json")
        self.assertIn(r.status_code, (401, 403))

    def test_with_token_full_flow(self):
        with self.settings():
            import os
            os.environ["ORCHESTRATION_INTERNAL_TOKEN"] = "test-internal-token"
            ex = start_execution(issue=self.issue, binding=self.binding, user_id=self.owner.id)
            r = self.internal.post(
                "/api/internal/orchestration/events/",
                {"externalEventId": "af-live-1", "eventType": "engine.started",
                 "payload": {"executionId": ex.id, "engine_run_ref": "af-run-9"}},
                content_type="application/json", HTTP_X_ORCHESTRATION_TOKEN="test-internal-token")
            self.assertEqual(r.status_code, 200, r.content)
            self.assertEqual(r.json()["status"], "applied")
            ex.refresh_from_db()
            self.assertEqual(ex.business_status, "running")
            # 重复投递幂等
            r2 = self.internal.post(
                "/api/internal/orchestration/events/",
                {"externalEventId": "af-live-1", "eventType": "engine.started",
                 "payload": {"executionId": ex.id, "engine_run_ref": "af-run-9"}},
                content_type="application/json", HTTP_X_ORCHESTRATION_TOKEN="test-internal-token")
            self.assertEqual(r2.json()["status"], "skipped")
