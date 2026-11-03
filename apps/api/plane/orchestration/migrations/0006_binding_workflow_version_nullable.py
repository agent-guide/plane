# 成员收敛（team-member-scoping-design §3.1）：绑定拆两步——先绑团队后挂版本。
# workflow_version 可空（null = 已绑团队待配置流程）；on_delete PROTECT → SET_NULL
# 仅因可空字段要求（发布版本不可删，实际不会被置空）。

import django.db.models.deletion
import plane.orchestration.models
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('db', '0123_state_external_id_unique'),
        ('orchestration', '0005_external_connection'),
    ]

    operations = [
        migrations.AlterField(
            model_name='projectteambinding',
            name='workflow_version',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='bindings', to='orchestration.workflowversion'),
        ),
    ]
