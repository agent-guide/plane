# -*- coding: utf-8 -*-
"""节点运行记录新增 RETRYING 状态（11-24 重试透明定案）。

尝试失败但重试额度未尽的中间态（Airflow up_for_retry 同语义）；
FAILED 自此只表终态失败。choices 变更为纯 DDL 无操作（char 同型）。
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("orchestration", "0012_noderuntimerecord_trace"),
    ]

    operations = [
        migrations.AlterField(
            model_name="noderuntimerecord",
            name="status",
            field=models.CharField(
                choices=[
                    ("pending", "Pending"),
                    ("running", "Running"),
                    ("waiting_human", "Waiting Human"),
                    ("success", "Success"),
                    ("failed", "Failed"),
                    ("retrying", "Retrying"),
                    ("cancelled", "Cancelled"),
                    ("skipped", "Skipped"),
                ],
                max_length=16,
                default="pending",
            ),
        ),
    ]
