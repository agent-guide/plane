# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""B1 重试账本分离：NodeRuntimeRecord 加 failure_retries（失败重派专用预算）
与 human_answer（最近人工答复，重派随行防丢失）。"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("orchestration", "0006_binding_workflow_version_nullable"),
    ]

    operations = [
        migrations.AddField(
            model_name="noderuntimerecord",
            name="failure_retries",
            field=models.PositiveIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="noderuntimerecord",
            name="human_answer",
            field=models.TextField(blank=True, default=""),
        ),
    ]
