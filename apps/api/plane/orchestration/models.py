# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE.txt file in the repository root for details.
"""编排域业务模型（阶段 2′，设计稿 docs/orchestration-plane-models-design.md）。

不变式（等价性清单 §4/规格同步）：
- WorkflowVersion published 后不可变；ProjectTeamBinding 每项目一条活跃；
- WorkItemExecution 每 issue 一条非终态 + 冻结上下文 + 乐观锁 transition_version；
- 两类人工交互独立；Agent 成员仅存 agwmngr 不可变引用。
"""

import uuid

from django.conf import settings
from django.db import models

from plane.db.models.workspace import Workspace
from plane.db.models.project import Project
from plane.db.models.issue import Issue

from .state_machine import STATUS_CHOICES


def _uuid() -> str:
    return uuid.uuid4().hex


class OrchestrationBaseModel(models.Model):
    id = models.CharField(primary_key=True, max_length=64, default=_uuid)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


# ---------------------------------------------------------------- 团队域


class AgentTeam(OrchestrationBaseModel):
    """工作区级执行团队（↔ 旧 agent_teams；权限矩阵与配额在服务层）。"""

    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        ACTIVE = "active", "Active"
        ARCHIVED = "archived", "Archived"

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="agent_teams")
    name = models.CharField(max_length=200)
    objective = models.TextField(blank=True, default="")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="created_agent_teams")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["workspace", "name"], name="uniq_agent_team_name_per_workspace"),
        ]


class AgentTeamMember(OrchestrationBaseModel):
    """团队成员：人类=Plane 用户；数字员工=agwmngr 不可变引用（无本地身份表）。"""

    class Kind(models.TextChoices):
        HUMAN = "human", "Human"
        AGENT = "agent", "Agent"

    team = models.ForeignKey(AgentTeam, on_delete=models.CASCADE, related_name="members")
    kind = models.CharField(max_length=10, choices=Kind.choices)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, null=True, blank=True, related_name="agent_team_memberships")
    # agwmngr AgentDefinition 不可变引用（agent 必填；含发布/部署指纹快照）
    agent_definition_id = models.CharField(max_length=200, blank=True, default="")
    agent_release_digest = models.CharField(max_length=128, blank=True, default="")
    role = models.CharField(max_length=100)
    capabilities = models.JSONField(default=list, blank=True)
    sequence = models.PositiveIntegerField(default=1)
    enabled = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["team", "user"], condition=models.Q(kind="human"), name="uniq_team_human_member"),
            models.UniqueConstraint(fields=["team", "agent_definition_id"], condition=models.Q(kind="agent"), name="uniq_team_agent_member"),
        ]
        indexes = [models.Index(fields=["team", "enabled"])]


# ---------------------------------------------------------------- 流程域


class WorkflowDefinition(OrchestrationBaseModel):
    """项目所有的流程编辑态（引擎连接引用走 env，库里仅存引用名）。"""

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="workflow_definitions")
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True, default="")
    engine_kind = models.CharField(max_length=32, default="airflow")
    engine_connection_ref = models.CharField(max_length=128, blank=True, default="")
    draft = models.JSONField(default=dict)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="created_workflows")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["project", "name"], name="uniq_workflow_name_per_project"),
        ]


class WorkflowVersion(OrchestrationBaseModel):
    """不可变发布快照（published 后 definition/content_hash 只读，服务层强制）。"""

    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        PUBLISHING = "publishing", "Publishing"
        PUBLISHED = "published", "Published"
        FAILED = "failed", "Failed"

    workflow = models.ForeignKey(WorkflowDefinition, on_delete=models.CASCADE, related_name="versions")
    version = models.PositiveIntegerField()
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
    definition = models.JSONField(default=dict)
    content_hash = models.CharField(max_length=128, blank=True, default="")
    engine_deploy_ref = models.JSONField(default=dict, blank=True)
    published_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["workflow", "version"], name="uniq_workflow_version"),
        ]


# ---------------------------------------------------------------- 绑定与执行域


class ProjectTeamBinding(OrchestrationBaseModel):
    """项目-团队绑定（先绑团队，后挂发布版本；升级=显式改引用，不自动跟随）。

    成员收敛时序（team-member-scoping-design §3.1）：绑定只定「谁执行」，
    workflow_version 可空 = 已绑团队待配置流程——该态下建卡被 PROJECT_NOT_BOUND
    闸门拒绝（base.py 编排域闸门）、auto_start 不启动。
    """

    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        RETIRED = "retired", "Retired"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="team_bindings")
    team = models.ForeignKey(AgentTeam, on_delete=models.PROTECT, related_name="project_bindings")
    # null = 已绑团队、未挂流程（两步绑定中间态）；挂载/切换见 upgrade_binding
    workflow_version = models.ForeignKey(WorkflowVersion, on_delete=models.SET_NULL, null=True, blank=True, related_name="bindings")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.ACTIVE)

    class Meta:
        # 库级兜底（↔ idx_project_team_bindings_active）：每项目至多一条活跃
        constraints = [
            models.UniqueConstraint(fields=["project"], condition=models.Q(status="active"), name="uniq_active_binding_per_project"),
        ]


class WorkItemExecution(OrchestrationBaseModel):
    """工作项执行（↔ 旧 task_bindings + 冻结上下文）。

    business_status 仅由 inbox 事件消费推进（转移表见 state_machine.py）；
    transition_version 为乐观锁；frozen_context 启动后不可变。
    """

    issue = models.ForeignKey(Issue, on_delete=models.CASCADE, related_name="executions")
    binding = models.ForeignKey(ProjectTeamBinding, on_delete=models.PROTECT, related_name="executions")
    engine_run_ref = models.CharField(max_length=200, blank=True, default="")
    business_status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="queued")
    current_member = models.ForeignKey(AgentTeamMember, on_delete=models.SET_NULL, null=True, blank=True, related_name="active_executions")
    frozen_context = models.JSONField(default=dict, blank=True)
    transition_version = models.PositiveIntegerField(default=0)
    last_event_id = models.CharField(max_length=200, blank=True, default="")
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        # 库级兜底（↔ idx_task_bindings_nonterminal）：每 issue 至多一条非终态
        constraints = [
            models.UniqueConstraint(
                fields=["issue"],
                condition=~models.Q(business_status__in=["failed", "completed", "cancelled"]),
                name="uniq_nonterminal_execution_per_issue",
            ),
        ]
        indexes = [models.Index(fields=["binding", "business_status"])]


# ---------------------------------------------------------------- 人工交互域


class BusinessApproval(OrchestrationBaseModel):
    """业务审批（§5.3 类型一；与工具权限请求互不代偿）。"""

    class Result(models.TextChoices):
        PENDING = "pending", "Pending"
        APPROVED = "approved", "Approved"
        REJECTED = "rejected", "Rejected"

    execution = models.ForeignKey(WorkItemExecution, on_delete=models.CASCADE, related_name="approvals")
    node_ref = models.CharField(max_length=200)  # 含引擎步骤/尝试，答复绑定当前步骤
    # null=True：未钉审批人（definition 未指定且交接成员非人类）——全员可答
    assignee = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="business_approvals", null=True, blank=True)
    options = models.JSONField(default=list, blank=True)
    # 审批呈现面（handoff 时自发布版本 definition 快照）
    question = models.TextField(blank=True, default="")
    free_text = models.BooleanField(default=False)
    result = models.CharField(max_length=16, choices=Result.choices, default=Result.PENDING)
    reason = models.TextField(blank=True, default="")
    answered_at = models.DateTimeField(null=True, blank=True)
    # 答复附件挂载（C7，2026-11-15）：作答前随传随挂到审批——刷新不丢，
    # 作答时与请求附件合并；未认领（没挂上评论）的由作答/终态路径回收。
    attachment_ids = models.JSONField(default=list, blank=True)


class AgentPermissionRequest(OrchestrationBaseModel):
    """Agent 工具权限/问答请求（§5.3 类型二；gateway 请求 id 幂等锚）。"""

    execution = models.ForeignKey(WorkItemExecution, on_delete=models.CASCADE, related_name="permission_requests")
    gateway_request_id = models.CharField(max_length=200, unique=True)
    assignee = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="agent_permission_requests")
    payload_ref = models.JSONField(default=dict, blank=True)
    answer = models.JSONField(default=dict, blank=True)
    answered_at = models.DateTimeField(null=True, blank=True)


# ---------------------------------------------------------------- 连接域


class ExternalConnection(OrchestrationBaseModel):
    """外部系统连接（连接管理设计 §2）：工作区级凭据实体。

    config 为 Fernet 加密 JSON，API 永不回明文；删除即凭据置空（软删仅留元数据）。
    被流程 AI 节点按名称引用；运行时工具服务经内部 resolve 回调取凭据。
    """

    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        UNREACHABLE = "unreachable", "Unreachable"
        UNTESTED = "untested", "Untested"

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="external_connections")
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True,
                                   related_name="created_connections")
    name = models.CharField(max_length=100)
    type = models.CharField(max_length=30)
    config = models.TextField(blank=True, default="")  # Fernet 加密 JSON
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.UNTESTED)
    status_note = models.CharField(max_length=200, blank=True, default="")  # 面向用户的失败原因
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "name"],
                condition=models.Q(deleted_at__isnull=True),
                name="uniq_connection_name_per_workspace_when_not_deleted"),
        ]
        indexes = [models.Index(fields=["workspace", "type"])]
        db_table = "orchestration_connections"


# ---------------------------------------------------------------- 成果域


class WorkItemArtifact(OrchestrationBaseModel):
    """不可变成果事实记录（↔ 旧 artifacts；非可编辑附件）。"""

    execution = models.ForeignKey(WorkItemExecution, on_delete=models.CASCADE, related_name="artifacts")
    issue = models.ForeignKey(Issue, on_delete=models.CASCADE, related_name="artifacts")
    content_hash = models.CharField(max_length=128)
    version = models.PositiveIntegerField(default=1)
    storage_ref = models.CharField(max_length=500)
    source_run_ref = models.CharField(max_length=200, blank=True, default="")
    produced_by = models.ForeignKey(AgentTeamMember, on_delete=models.SET_NULL, null=True, blank=True)
    accepted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["execution", "content_hash", "version"], name="uniq_artifact_version"),
        ]


# ---------------------------------------------------------------- 会话域（P2 agent chat，2026-11-17）


class AgentConversation(OrchestrationBaseModel):
    """数字员工会话（设计 v2/team-assistant-chat-design.md §3.1）。

    对话主体=具体团队成员（agent 名册成员）；一期私有（成员=发起人）。
    持久化在 Plane 侧（agwmngr 边界禁存聊天）。
    """

    team = models.ForeignKey("AgentTeam", on_delete=models.CASCADE, related_name="conversations")
    agent_member = models.ForeignKey("AgentTeamMember", on_delete=models.CASCADE, related_name="conversations")
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="agent_conversations")
    title = models.CharField(max_length=200, blank=True, default="")
    # 滚动摘要（§3.2：超 8000 字符阈值时更早历史压成摘要；空=未压缩过）
    summary = models.TextField(blank=True, default="")
    summary_through = models.CharField(max_length=64, blank=True, default="",
                                       help_text="摘要覆盖到的最后一条消息 id")
    last_message_at = models.DateTimeField(null=True, blank=True)
    # 已读游标（一期通知=未读会话数，与审批待办同构的前端轮询形态）
    last_read_at = models.DateTimeField(null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=["workspace", "created_by", "deleted_at"])]
        constraints = [
            # 单会话模型（Slack DM 同构）：同（团队,成员,发起人）活跃会话唯一——
            # 条件唯一索引兜底并发创建竞态（软删后可再开新的）
            models.UniqueConstraint(
                fields=["team", "agent_member", "created_by"],
                condition=models.Q(deleted_at__isnull=True),
                name="uniq_active_agent_conversation"),
        ]


class AgentMessage(OrchestrationBaseModel):
    """会话消息。审计口径（拍板记录 §6.4）：不可编辑不可删，仅整会话可删。"""

    class Role(models.TextChoices):
        USER = "user", "User"
        AGENT = "agent", "Agent"
        SYSTEM = "system", "System"

    class Kind(models.TextChoices):
        TEXT = "text", "Text"
        TASK = "task", "Task"                  # T1 任务：进度+终产出
        CONFIRM_CARD = "confirm_card", "Confirm Card"  # L1 建卡预览（确认/取消）
        FLOW_CARD = "flow_card", "Flow Card"   # 已触发的建卡引用

    conversation = models.ForeignKey(AgentConversation, on_delete=models.CASCADE, related_name="messages")
    role = models.CharField(max_length=8, choices=Role.choices)
    kind = models.CharField(max_length=16, choices=Kind.choices, default=Kind.TEXT)
    # content：{text, task{status,progress,output}, card{issue_id,title,status}, confirm{...}}
    content = models.JSONField(default=dict)
    streaming_offset = models.PositiveIntegerField(default=0, help_text="流式游标：断线重连续传位置")
    attachments = models.JSONField(default=list, help_text="FileAsset id 列表")

    class Meta:
        indexes = [models.Index(fields=["conversation", "created_at"])]
        ordering = ["created_at"]


# ---------------------------------------------------------------- 可靠性基础设施


class OrchestrationOutbox(OrchestrationBaseModel):
    """业务记录与待发命令同事务提交（§7；幂等键冲突拒绝）。"""

    class State(models.TextChoices):
        PENDING = "pending", "Pending"
        SENT = "sent", "Sent"
        CONFIRMED = "confirmed", "Confirmed"
        FAILED = "failed", "Failed"

    idempotency_key = models.CharField(max_length=200, unique=True)
    command_type = models.CharField(max_length=100)
    payload = models.JSONField(default=dict)
    payload_hash = models.CharField(max_length=128)
    state = models.CharField(max_length=16, choices=State.choices, default=State.PENDING)
    attempts = models.PositiveIntegerField(default=0)


class OrchestrationInbox(OrchestrationBaseModel):
    """引擎 worker 回写事件入口（external_event_id 幂等去重）。"""

    external_event_id = models.CharField(max_length=250, unique=True)
    event_type = models.CharField(max_length=100)
    payload = models.JSONField(default=dict)
    processed_at = models.DateTimeField(null=True, blank=True)


# ---------------------------------------------------------------- 历史桥


class LegacyRuntimeRef(OrchestrationBaseModel):
    """旧系统 ID → 新对象映射（迁移脚本填充，历史查询跳转）。"""

    legacy_type = models.CharField(max_length=64)
    legacy_id = models.CharField(max_length=128)
    target_id = models.CharField(max_length=128)
    note = models.CharField(max_length=500, blank=True, default="")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["legacy_type", "legacy_id"], name="uniq_legacy_ref"),
        ]


from .node_runtime import NodeRuntimeRecord  # noqa: E402,F401
