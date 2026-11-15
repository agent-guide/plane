# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""C8-B 执行中补料：短期签名 + 自取接口 + prompt 纪律。"""

import os
import time

from django.contrib.auth import get_user_model
from django.test import TestCase, Client

from plane.db.models.workspace import Workspace
from plane.db.models.project import Project
from plane.db.models.issue import Issue
from plane.orchestration.models import AgentTeam, ProjectTeamBinding
from plane.orchestration.supplement_access import (
    sign_supplement_access, verify_supplement_access, supplement_entries)

User = get_user_model()


class SupplementAccessTests(TestCase):
    def setUp(self):
        os.environ["ORCHESTRATION_INTERNAL_TOKEN"] = "steer-token"
        self.owner = User.objects.create_user(email="s@test.io", username="s")
        self.ws = Workspace.objects.create(name="s", slug="steer-orch", owner=self.owner)
        self.project = Project.objects.create(name="sp", identifier="STEER1", workspace=self.ws, created_by=self.owner)
        team = AgentTeam.objects.create(workspace=self.ws, name="st")
        self.issue = Issue.objects.create(
            workspace=self.ws, project=self.project, name="steer card", created_by=self.owner)
        self.binding = ProjectTeamBinding.objects.create(project=self.project, team=team)

    def _exec(self):
        from plane.orchestration.models import WorkItemExecution
        return WorkItemExecution.objects.create(issue=self.issue, binding=self.binding)

    def test_sign_and_verify_roundtrip(self):
        ex = self._exec()
        grant = sign_supplement_access(str(ex.id), ttl_seconds=120)
        self.assertTrue(verify_supplement_access(str(ex.id), grant["exp"], grant["sig"]))

    def test_expired_rejected(self):
        ex = self._exec()
        grant = sign_supplement_access(str(ex.id), ttl_seconds=60)
        self.assertFalse(verify_supplement_access(str(ex.id), int(time.time()) - 1, grant["sig"]))

    def test_wrong_signature_or_execution_rejected(self):
        ex = self._exec()
        grant = sign_supplement_access(str(ex.id), ttl_seconds=120)
        self.assertFalse(verify_supplement_access("other-exec", grant["exp"], grant["sig"]))
        self.assertFalse(verify_supplement_access(str(ex.id), grant["exp"], "deadbeef"))
        self.assertFalse(verify_supplement_access(str(ex.id), "not-a-number", grant["sig"]))

    def test_endpoint_requires_valid_signature(self):
        ex = self._exec()
        grant = sign_supplement_access(str(ex.id), ttl_seconds=300)
        client = Client()
        r = client.get(f"/api/internal/executions/{ex.id}/supplements/")
        self.assertEqual(r.status_code, 403, r.content)
        r = client.get(f"/api/internal/executions/{ex.id}/supplements/?exp=1&sig=x")
        self.assertEqual(r.status_code, 403, r.content)
        r = client.get(f"/api/internal/executions/{ex.id}/supplements/?exp={grant['exp']}&sig={grant['sig']}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"supplements": [], "hasNew": False})

    def test_endpoint_returns_new_supplements_only(self):
        from plane.db.models import IssueComment
        ex = self._exec()
        grant = sign_supplement_access(str(ex.id), ttl_seconds=300)
        IssueComment.objects.create(
            workspace=self.ws, project=self.project, issue=self.issue,
            actor=self.owner, created_by=self.owner,
            comment_html="<p>gross weight 500 KGM</p>")
        client = Client()
        from django.utils import timezone as tz
        from datetime import timedelta
        future = tz.localtime(tz.now() + timedelta(seconds=5)).replace(microsecond=0).isoformat()
        r = client.get(f"/api/internal/executions/{ex.id}/supplements/?exp={grant['exp']}&sig={grant['sig']}")
        body = r.json()
        self.assertTrue(body["hasNew"])
        self.assertEqual(len(body["supplements"]), 1)
        self.assertIn("gross weight 500 KGM", body["supplements"][0]["text"])
        r2 = client.get(f"/api/internal/executions/{ex.id}/supplements/", {
            "after": future, "exp": grant["exp"], "sig": grant["sig"]})
        self.assertFalse(r2.json()["hasNew"])

    def test_bot_comments_excluded(self):
        from plane.db.models import IssueComment, User
        bot = User.objects.create_user(email="agent-bot@runtime.local", username="agent-bot", is_bot=True)
        ex = self._exec()
        grant = sign_supplement_access(str(ex.id), ttl_seconds=300)
        IssueComment.objects.create(
            workspace=self.ws, project=self.project, issue=self.issue,
            actor=bot, created_by=bot, comment_html="<p>bot says</p>")
        entries = supplement_entries(self.issue)
        self.assertEqual(entries, [])

    def test_steering_discipline_in_prompt(self):
        from plane.orchestration.worker import _steering_discipline
        text = _steering_discipline(execution_id="exec-x", node={"type": "ai", "retries": None})
        self.assertIn("执行中补料", text)
        self.assertIn("exec-x", text)
        self.assertIn("sig=", text)
        self.assertIn("hasNew=true", text)


