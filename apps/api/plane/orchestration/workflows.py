# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""流程域服务（阶段 2′）——定义草稿/版本/发布状态流转。

语义来源（等价性清单 §2 + 校验链清单 §1 流程段）：
- 流程归项目所有，项目内 name 唯一；编辑态存 draft JSON
- 发布前置：存在 draft 版本 + 引擎能力校验（fail-closed，校验器由 worker 发布适配注入）
- publishing → published 由 finish_publish 完成（引擎侧结果回写，轮询在 worker）
- publishing 失败可从 publishing 状态重新发布（re-publish-from-publishing）
- 版本一旦 published 不可变（服务层拒绝改 definition）
"""

import hashlib
import json

from django.db import transaction

from .models import WorkflowDefinition, WorkflowVersion
from .services import TeamDomainError


def _digest(definition: dict) -> str:
    return hashlib.sha256(json.dumps(definition, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def create_workflow(*, project, user_id, name: str, description: str = "", engine_kind: str = "airflow") -> WorkflowDefinition:
    if not (name or "").strip():
        raise TeamDomainError(400, "WORKFLOW_NAME_REQUIRED", "Workflow name is required")
    try:
        return WorkflowDefinition.objects.create(
            project=project, created_by_id=user_id, name=name.strip(), description=description, engine_kind=engine_kind,
        )
    except Exception as e:
        if "uniq_workflow_name" in str(e):
            raise TeamDomainError(409, "WORKFLOW_NAME_CONFLICT", "Workflow name already exists in this project")
        raise


def update_draft(*, workflow: WorkflowDefinition, user_id, draft: dict) -> WorkflowDefinition:
    if not isinstance(draft, dict):
        raise TeamDomainError(400, "WORKFLOW_DEFINITION_INVALID", "Draft must be a JSON object")
    workflow.draft = draft
    workflow.save(update_fields=["draft", "updated_at"])
    return workflow


def save_draft_version(*, workflow: WorkflowDefinition, user_id) -> WorkflowVersion:
    """把当前编辑态存为 draft 版本（发布的前置）。"""
    if not workflow.draft:
        raise TeamDomainError(400, "WORKFLOW_DRAFT_EMPTY", "Workflow draft is empty")
    latest = workflow.versions.order_by("-version").first()
    # 同内容草稿重复保存 → 复用既有 draft 版本（幂等），不堆叠空版本
    if latest and latest.status == WorkflowVersion.Status.DRAFT and latest.content_hash == _digest(workflow.draft):
        return latest
    version = (latest.version + 1) if latest else 1
    return WorkflowVersion.objects.create(
        workflow=workflow, version=version, status=WorkflowVersion.Status.DRAFT,
        definition=workflow.draft, content_hash=_digest(workflow.draft),
    )


def start_publish(*, workflow: WorkflowDefinition, user_id,
                  capability_validator=None) -> WorkflowVersion:
    """校验 + 标记 publishing（引擎不在此触碰；生成/上传/轮询在 worker）。

    capability_validator: 引擎能力校验器（worker 发布适配注入；None 时跳过——
    本地无引擎场景；终局由 worker 侧注入 fail-closed 校验器）。
    """
    draft_version = workflow.versions.filter(
        status__in=[WorkflowVersion.Status.DRAFT, WorkflowVersion.Status.PUBLISHING, WorkflowVersion.Status.FAILED]
    ).order_by("-version").first()
    if draft_version is None:
        raise TeamDomainError(409, "WORKFLOW_DRAFT_NOT_FOUND", "A draft version is required before publication")
    if capability_validator is not None:
        try:
            capability_validator(draft_version.definition)
        except ValueError as exc:
            raise TeamDomainError(400, "WORKFLOW_DEFINITION_INVALID", str(exc))
    draft_version.status = WorkflowVersion.Status.PUBLISHING
    draft_version.save(update_fields=["status", "updated_at"])
    return draft_version


def finish_publish(*, version: WorkflowVersion, engine_deploy_ref: dict) -> WorkflowVersion:
    """worker 上传/轮询成功后回写：published + 引擎部署映射（只增不改）。"""
    if version.status != WorkflowVersion.Status.PUBLISHING:
        raise TeamDomainError(409, "WORKFLOW_PUBLISH_STATE_CONFLICT", "Version is not publishing")
    with transaction.atomic():
        version.status = WorkflowVersion.Status.PUBLISHED
        version.engine_deploy_ref = engine_deploy_ref
        from django.utils import timezone
        version.published_at = timezone.now()
        version.save(update_fields=["status", "engine_deploy_ref", "published_at", "updated_at"])
    return version


def fail_publish(*, version: WorkflowVersion) -> WorkflowVersion:
    if version.status != WorkflowVersion.Status.PUBLISHING:
        raise TeamDomainError(409, "WORKFLOW_PUBLISH_STATE_CONFLICT", "Version is not publishing")
    version.status = WorkflowVersion.Status.FAILED
    version.save(update_fields=["status", "updated_at"])
    return version


def require_published_immutable(*, version: WorkflowVersion) -> None:
    """published 版本不可变守卫（绑定/执行引用前的防线）。"""
    if version.status == WorkflowVersion.Status.PUBLISHED and not version.engine_deploy_ref.get("mutable", False):
        return  # 已发布且不可变 → 合法（本守卫用于拦截写入路径，读路径直接过）
    raise TeamDomainError(409, "WORKFLOW_VERSION_IMMUTABLE", "Published versions are immutable")
