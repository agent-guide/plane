# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""建卡自动启动（等价旧链 WorkManagementAutoStartService 的事件驱动触发）。

post_save(created) 覆盖进程内一切创建路径（API/草稿转正式/模板/未来代码）；
幂等由 start_execution 的 EXECUTION_CONFLICT 校验链承担（等价旧 already_bound
闸门）；not_governed 等价「无活跃绑定不启动」。bulk_create 不发信号——由
worker 对账兜底（reconcile 补启未启动的已绑定工作项）。
"""

from django.db.models.signals import post_save
from django.dispatch import receiver

from plane.db.models.issue import Issue

from .models import ProjectTeamBinding


@receiver(post_save, sender=Issue, weak=False)
def auto_start_execution(sender, instance, created, **kwargs):
    if not created:
        return
    binding = ProjectTeamBinding.objects.filter(
        project_id=instance.project_id, status=ProjectTeamBinding.Status.ACTIVE,
        workflow_version__isnull=False,  # 两步绑定中间态（已绑团队未挂版本）不启动
    ).select_related("workflow_version").first()
    if binding is None:
        return  # not_governed：未绑定/未挂版本不启动
    from . import execution as execution_svc
    try:
        execution_svc.start_execution(issue=instance, binding=binding, user_id=instance.created_by_id)
    except Exception:
        pass  # 校验链失败不阻塞创建（等价旧「启动失败仅记录」语义）——面板可见可重试
