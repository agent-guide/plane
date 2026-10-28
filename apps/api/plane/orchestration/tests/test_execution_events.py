# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""执行域事件消费测试（黄金基准——状态机规格第 2/3/4 节逐条）。

覆盖：七事件类型的合法路径、终态副作用、人工交接成员切换、
乐观锁并发冲突、inbox 幂等去重、非法转移拒绝、恢复/对账的前置校验。
"""

import threading

from django.contrib.auth import get_user_model
from django.test import TestCase

from plane.db.models.workspace import Workspace
from plane.db.models.project import Project
from plane.db.models.issue import Issue
from plane.orchestration import services
from plane.orchestration.execution import (
    ENGINE_TERMINAL_MAP, on_engine_started, on_engine_terminal, on_human_handoff,
    on_human_resume, on_reconcile_stale, process_event, transition_execution,
)
from plane.orchestration.models import (
    WorkflowDefinition, WorkflowVersion, WorkItemExecution,
)
from plane.orchestration.services import TeamDomainError
from plane.orchestration.state_machine import InvalidTransition

User = get_user_model()


class ExecutionTestBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user(email="e-owner@test.io", username="e-owner")
        cls.human = User.objects.create_user(email="e-human@test.io", username="e-human")
        cls.ws = Workspace.objects.create(name="ews", slug="ews-orch", owner=cls.owner)
        cls.project = Project.objects.create(name="ep", identifier="EPORCH", workspace=cls.ws, created_by=cls.owner)
        cls.team = services.create_team(workspace_id=cls.ws.id, user_id=cls.owner.id, is_admin=True, name="执行团队")
        cls.human_member = services.add_member(
            team=cls.team, user_id=cls.owner.id, is_admin=True, kind="human", role="approver", user_ref=cls.human.id)
        services.activate_team(team=cls.team, user_id=cls.owner.id, is_admin=True)
        cls.workflow = WorkflowDefinition.objects.create(project=cls.project, name="wf-e", created_by=cls.owner)
        cls.version = WorkflowVersion.objects.create(workflow=cls.workflow, version=1, status=WorkflowVersion.Status.PUBLISHED)
        cls.binding = services.bind_project(
            project=cls.project, team=cls.team, user_id=cls.owner.id, is_admin=True, workflow_version=cls.version)
        cls.issue = Issue.objects.create(
            project=cls.project, name="执行用工作项", created_by=cls.owner)  # save() 自动维护 sequence

    def _execution(self) -> WorkItemExecution:
        return WorkItemExecution.objects.create(issue=self.issue, binding=self.binding, frozen_context={"v": 1})


class CoreTransitionTests(ExecutionTestBase):
    def test_engine_started_moves_queued_to_running_with_ref(self):
        ex = self._execution()
        result = on_engine_started(execution_id=ex.id, event_id="evt-1", engine_run_ref="af-run-1")
        self.assertEqual(result.business_status, "running")
        self.assertEqual(result.engine_run_ref, "af-run-1")
        self.assertEqual(result.transition_version, 1)

    def test_engine_terminal_side_effects(self):
        """终态副作用（规格第 3 节）：清成员 + completed_at。"""
        ex = self._execution()
        on_engine_started(execution_id=ex.id, event_id="e1", engine_run_ref="r")
        on_engine_terminal(execution_id=ex.id, event_id="e2", engine_status="success")
        ex.refresh_from_db()
        self.assertEqual(ex.business_status, "completed")
        self.assertIsNone(ex.current_member)
        self.assertIsNotNone(ex.completed_at)

    def test_engine_terminal_maps_three_statuses(self):
        self.assertEqual(ENGINE_TERMINAL_MAP, {"success": "completed", "failed": "failed", "cancelled": "cancelled"})

    def test_terminal_is_absorbing(self):
        ex = self._execution()
        on_engine_terminal(execution_id=ex.id, event_id="e", engine_status="failed")
        ex.refresh_from_db()  # 终态事实入库后再断言吸收性
        with self.assertRaises(InvalidTransition):
            transition_execution(execution=ex, target="running", event_id="e2")

    def test_illegal_transition_rejected_before_write(self):
        ex = self._execution()
        with self.assertRaises(InvalidTransition):
            transition_execution(execution=ex, target="waiting_human", event_id="e")  # queued 无此出边
        ex.refresh_from_db()
        self.assertEqual(ex.business_status, "queued")  # 未落库


class HumanInteractionTests(ExecutionTestBase):
    def _running(self):
        ex = self._execution()
        on_engine_started(execution_id=ex.id, event_id="e0", engine_run_ref="r")
        return ex

    def test_handoff_sets_human_member_and_resume_clears(self):
        ex = self._running()
        waiting = on_human_handoff(execution_id=ex.id, event_id="e1", member=self.human_member)
        self.assertEqual(waiting.business_status, "waiting_human")
        self.assertEqual(waiting.current_member_id, self.human_member.id)
        resumed = on_human_resume(execution_id=ex.id, event_id="e2")
        self.assertEqual(resumed.business_status, "running")
        self.assertIsNone(resumed.current_member_id)  # 清成员，等下个 agent 分派再设

    def test_resume_requires_waiting(self):
        ex = self._running()
        with self.assertRaises(TeamDomainError) as c:
            on_human_resume(execution_id=ex.id, event_id="e")
        self.assertEqual(c.exception.code, "EXECUTION_RESUME_CONFLICT")


class ConcurrencyTests(ExecutionTestBase):
    def test_optimistic_lock_conflict_on_stale_object(self):
        """乐观锁（规格第 3 节）：同版本双改，后者 409。"""
        ex = self._execution()
        on_engine_started(execution_id=ex.id, event_id="winner", engine_run_ref="r")  # 版本 +1
        with self.assertRaises(TeamDomainError) as c:
            transition_execution(execution=ex, target="failed", event_id="loser")  # ex 持旧版本
        self.assertEqual(c.exception.code, "EXECUTION_TRANSITION_CONFLICT")
        ex.refresh_from_db()
        self.assertEqual(ex.last_event_id, "winner")  # 胜者未被覆盖

    def test_terminal_member_release_and_new_execution_allowed(self):
        """终态释放 issue：可再建新执行（partial unique 不变式的行为面）。"""
        ex = self._execution()
        on_engine_terminal(execution_id=ex.id, event_id="e", engine_status="cancelled")
        second = self._execution()  # 不抛即过
        self.assertEqual(second.business_status, "queued")


class InboxTests(ExecutionTestBase):
    def test_process_event_applies_and_dedups(self):
        ex = self._execution()
        r1 = process_event(external_event_id="ext-1", event_type="engine.started",
                           payload={"executionId": ex.id, "engine_run_ref": "r"})
        self.assertEqual(r1["status"], "applied")
        r2 = process_event(external_event_id="ext-1", event_type="engine.started",
                           payload={"executionId": ex.id, "engine_run_ref": "r"})
        self.assertEqual(r2["status"], "skipped")
        self.assertEqual(r2.get("reason"), "duplicate")

    def test_unknown_event_type_rejected_without_side_effect(self):
        ex = self._execution()
        r = process_event(external_event_id="ext-x", event_type="nope", payload={})
        self.assertEqual(r["status"], "rejected")
        ex.refresh_from_db()
        self.assertEqual(ex.business_status, "queued")

    def test_reconcile_stale_only_from_queued(self):
        ex = self._execution()
        r = process_event(external_event_id="ext-rc", event_type="engine.reconcile_stale",
                          payload={"executionId": ex.id})
        self.assertEqual(r["status"], "applied")
        self.assertEqual(r["business_status"], "failed")
        # 已终态再对账 → 前置违例抛业务错（调用方/worker 决策重试或丢弃）
        with self.assertRaises(TeamDomainError):
            process_event(external_event_id="ext-rc2", event_type="engine.reconcile_stale",
                          payload={"executionId": ex.id})
