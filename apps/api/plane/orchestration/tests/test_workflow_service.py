# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""流程域服务测试（黄金基准，校验链清单 §1 流程段逐码）。"""

from django.contrib.auth import get_user_model
from django.test import TestCase

from plane.db.models.workspace import Workspace
from plane.db.models.project import Project
from plane.orchestration.workflows import (
    create_workflow, fail_publish, finish_publish, save_draft_version,
    start_publish, update_draft,
)
from plane.orchestration.models import WorkflowDefinition, WorkflowVersion
from plane.orchestration.services import TeamDomainError

User = get_user_model()


class WorkflowTestBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user(email="w-owner@test.io", username="w-owner")
        cls.ws = Workspace.objects.create(name="wws", slug="wws-orch", owner=cls.owner)
        cls.project = Project.objects.create(name="wp", identifier="WPORCH", workspace=cls.ws, created_by=cls.owner)


class DefinitionTests(WorkflowTestBase):
    def test_create_and_name_conflict(self):
        create_workflow(project=self.project, user_id=self.owner.id, name="流程A")
        with self.assertRaises(TeamDomainError) as c:
            create_workflow(project=self.project, user_id=self.owner.id, name="流程A")
        self.assertEqual(c.exception.code, "WORKFLOW_NAME_CONFLICT")

    def test_draft_update(self):
        wf = create_workflow(project=self.project, user_id=self.owner.id, name="流程B")
        update_draft(workflow=wf, user_id=self.owner.id, draft={"nodes": [{"key": "a"}]})
        wf.refresh_from_db()
        self.assertEqual(wf.draft["nodes"][0]["key"], "a")


class VersionTests(WorkflowTestBase):
    def test_draft_version_created_with_content_hash(self):
        wf = create_workflow(project=self.project, user_id=self.owner.id, name="带草稿")
        update_draft(workflow=wf, user_id=self.owner.id, draft={"n": 1})
        v1 = save_draft_version(workflow=wf, user_id=self.owner.id)
        self.assertEqual(v1.status, WorkflowVersion.Status.DRAFT)
        self.assertEqual(len(v1.content_hash), 64)
        # 同内容重复保存 → 幂等复用
        again = save_draft_version(workflow=wf, user_id=self.owner.id)
        self.assertEqual(again.id, v1.id)

    def test_empty_draft_rejected(self):
        wf = create_workflow(project=self.project, user_id=self.owner.id, name="空草稿")
        with self.assertRaises(TeamDomainError) as c:
            save_draft_version(workflow=wf, user_id=self.owner.id)
        self.assertEqual(c.exception.code, "WORKFLOW_DRAFT_EMPTY")


class PublishChainTests(WorkflowTestBase):
    def _draft_version(self, name="发布流程"):
        wf = create_workflow(project=self.project, user_id=self.owner.id, name=name)
        update_draft(workflow=wf, user_id=self.owner.id, draft={"nodes": []})
        return save_draft_version(workflow=wf, user_id=self.owner.id)

    def test_publish_requires_draft_version(self):
        wf = create_workflow(project=self.project, user_id=self.owner.id, name="无版本")
        with self.assertRaises(TeamDomainError) as c:
            start_publish(workflow=wf, user_id=self.owner.id)
        self.assertEqual(c.exception.code, "WORKFLOW_DRAFT_NOT_FOUND")

    def test_publish_chain_publishing_to_published(self):
        v = self._draft_version()
        publishing = start_publish(workflow=v.workflow, user_id=self.owner.id)
        self.assertEqual(publishing.status, WorkflowVersion.Status.PUBLISHING)
        published = finish_publish(version=publishing, engine_deploy_ref={"dag_id": "wf_x_v1"})
        self.assertEqual(published.status, WorkflowVersion.Status.PUBLISHED)
        self.assertEqual(published.engine_deploy_ref["dag_id"], "wf_x_v1")
        self.assertIsNotNone(published.published_at)

    def test_capability_validator_rejects_invalid(self):
        def reject(_):
            raise ValueError("node type unsupported by engine")
        v = self._draft_version("能力不足")
        with self.assertRaises(TeamDomainError) as c:
            start_publish(workflow=v.workflow, user_id=self.owner.id, capability_validator=reject)
        self.assertEqual(c.exception.code, "WORKFLOW_DEFINITION_INVALID")
        v.refresh_from_db()
        self.assertEqual(v.status, WorkflowVersion.Status.DRAFT)  # 校验失败不落 publishing

    def test_publish_failure_marks_failed_and_can_republish(self):
        """失败可重发（re-publish-from-failed/publishing 语义）。"""
        v = self._draft_version("失败重发")
        publishing = start_publish(workflow=v.workflow, user_id=self.owner.id)
        fail_publish(version=publishing)
        v.refresh_from_db()
        self.assertEqual(v.status, WorkflowVersion.Status.FAILED)
        again = start_publish(workflow=v.workflow, user_id=self.owner.id)  # 从 failed 再发
        self.assertEqual(again.status, WorkflowVersion.Status.PUBLISHING)

    def test_finish_requires_publishing_state(self):
        v = self._draft_version("状态守卫")
        with self.assertRaises(TeamDomainError) as c:
            finish_publish(version=v, engine_deploy_ref={})
        self.assertEqual(c.exception.code, "WORKFLOW_PUBLISH_STATE_CONFLICT")
