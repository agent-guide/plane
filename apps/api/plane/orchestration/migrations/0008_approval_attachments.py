# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""C7：审批答复附件挂载（BusinessApproval.attachment_ids）。"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("orchestration", "0007_node_failure_retries_and_answer"),
    ]

    operations = [
        migrations.AddField(
            model_name="businessapproval",
            name="attachment_ids",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
