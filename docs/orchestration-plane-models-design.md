# 编排域 Plane 业务模型设计（阶段 2′ 设计稿）

- 文档类型：设计稿（待评审），依据《三部分职责拆分设计》§5-§7 与我方意见稿
- 日期：2026-10-28
- 分支：`feature/orchestration-plane`
- 状态：待评审 → 评审通过后进入实施

## 1. 定位与边界

本设计将 experts-backend 编排域的**活数据**迁入 Plane 后端（独立 Django app），Plane 成为业务控制唯一权威。**不建模**的内容（对齐拆分设计 §6）：

- 引擎原生状态（节点尝试/定时器/等待）——归引擎；本域只存业务视图与可重建观察
- 任何图调度/重试状态机——Plane 不与引擎竞争
- Agent 配置与部署——agwmngr 权威，本域只存不可变引用

## 2. 独立 app：`orchestration`

位置 `apps/api/plane/orchestration/`，自有 models/migrations/urls/views/services。对原生代码的接触点仅限注册（`INSTALLED_APPS`、根 urls 挂载一行）与既有事件钩子复用。

## 3. 模型清单

### 3.1 团队域

**AgentTeam**（↔ 旧 `agent_teams`）
- workspace FK(Workspace)、name、objective、status(draft/active/archived)、created_by FK(User)、时间戳
- 约束：name 工作区内唯一；archived 不可变更（终态）

**AgentTeamMember**（↔ 旧 `agent_team_members` + `runtime_identities` 合并）
- team FK、kind(human/agent)、user FK(User, human 时必填)、role、capabilities JSON、sequence、enabled
- **agent_ref**（agent 时必填）：`{agentDefinitionId, releaseId, releaseDigest, deploymentId}`——agwmngr 不可变引用快照，不含配置内容
- 约束：(team, user) / (team, agent_ref) 唯一；团队至少一名启用成员方可 active（沿用既有守卫语义）
- 说明：不再设本地 runtime identity 表——人类=Plane 用户，Agent=agwmngr 引用（§5.4）

### 3.2 流程域

**WorkflowDefinition**（↔ 旧 `workflows`）
- project FK(Project)、name、description、engine_kind（默认 airflow）、engine_connection_ref（服务端解析的连接引用，秘密不入库明文）、draft JSON（编辑态定义）
- 约束：project 内 name 唯一；流程归项目所有（§5.1），团队跨项目复用不动流程

**WorkflowVersion**（↔ 旧 `workflow_versions`）
- workflow FK、version(int)、definition JSON（发布时快照，**不可变**）、content_hash、status(draft/published/publishing/failed)、published_at、engine_deploy_ref JSON（引擎侧部署映射记录）
- 约束：(workflow, version) 唯一；published 后 definition/content_hash 只读；发布映射只增不改

### 3.3 绑定与执行域

**ProjectTeamBinding**（↔ 旧 `project_team_bindings`）
- project FK、team FK、workflow_version FK（钉发布版本）、status、时间戳
- 约束：每项目至多一条 active（partial unique index）；版本升级=显式改引用（不自动跟随新发布，沿用既有语义）

**WorkItemExecution**（↔ 旧 `task_bindings` + §5.2 冻结上下文）
- issue FK(Issue, 一对一活跃)、binding FK、engine_run_ref（引擎运行 id，只存引用）、business_status(pending/running/waiting_human/completed/failed/cancelled)（**业务视图**，由 worker 事件驱动）、current_agent_member FK(Member, null, 当前环节执行成员)、frozen_context JSON、时间戳
- **frozen_context 启动时冻结**：project/issue/team/流程版本+哈希/成员快照/agent release-digest 列表/输入摘要/授权来源；执行前校验部署 digest 未漂移，漂移则阻断待人工（口径 4）
- 约束：每 issue 至多一条非终态 execution（partial unique）；状态迁移仅由事件消费路径驱动

### 3.4 人工交互域（§5.3 两类分离）

**BusinessApproval**（业务审批）
- execution FK、node_ref、assignee FK(User)、options JSON（可选操作）、result(pending/approved/rejected)、reason、answered_at
- 约束：审批与当前引擎步骤/尝试绑定（node_ref 含 attempt）；两类人工交互互不代偿

**AgentPermissionRequest**（Agent 工具权限/问答）
- execution FK、gateway_request_id（唯一）、assignee FK、payload_ref（请求内容引用，服务端按权限解析）、answer JSON、answered_at
- 说明：测试环境现状为 0 条，但流程含权限交互节点，模型必须预留

### 3.5 成果域

**WorkItemArtifact**（↔ 旧 `artifacts`）
- execution FK、issue FK、content_hash、version(int)、storage_ref（Plane 附件或对象存储引用）、source_run_ref、produced_by FK(Member, null)、accepted_at
- 约束：(execution, content_hash, version) 唯一；不可变（成果事实记录，非可编辑附件——口径 5）

### 3.6 可靠性基础设施（§7 通用约束）

**OrchestrationOutbox**——业务记录与待发引擎命令同事务提交；state(pending/sent/confirmed/failed)、idempotency_key（相同键不同输入→冲突拒绝）、payload_hash、attempts
**OrchestrationInbox**——引擎 worker 回写事件入口；external_event_id 唯一（幂等去重）、event_type、payload、processed_at；消费侧按 execution+attempt 校验合法状态

### 3.7 历史桥

**LegacyRuntimeRef**——legacy_type/legacy_id → 通用外键（新对象），迁移脚本填充，供旧记录查询跳转（§9「保留旧 ID 映射供历史查询」）

## 4. 关键不变式汇总

1. WorkflowVersion published 后不可变（含哈希）
2. frozen_context 执行期不可变；部署 digest 漂移→阻断
3. 每 issue 至多一条活跃 execution；每项目至多一条 active 绑定
4. business_status 只由 inbox 消费推进；取消请求与实际停止分开表示
5. 两类人工交互独立结算，不可互相代偿
6. Agent 成员仅存 agwmngr 不可变引用，不缓存可变配置

## 5. 数据迁移对照（接测试环境盘点）

| 新模型 | 旧表（量） | 迁移方式 |
| --- | --- | --- |
| AgentTeam/Member | agent_teams(6)/members(19)/identities(6) | 脚本转换 + 旧 ID 入 LegacyRuntimeRef |
| WorkflowDefinition/Version | workflows(10)/versions(12) | 编辑态与发布快照分列；引擎映射重记 |
| ProjectTeamBinding | project_team_bindings(7) | 直迁 |
| WorkItemExecution | task_bindings(14, 全终态) | **只建历史快照记录或直接归档**（无在途，不迁活跃态） |
| WorkItemArtifact | artifacts(17) | 迁引用+哈希，校验对象存在 |
| BusinessApproval | agent_human_requests(0) | 空 |
| 历史（runs/events/handoffs/chat） | — | 不迁，旧库只读归档 |

## 6. 待评审确认点

1. engine_connection_ref 的承载形态：环境变量/独立受控表/复用 WorkflowDefinition 单行——倾向受控单表（服务端解析，不进共享 DAG/日志）
2. agent 成员是否需要映射 Plane Bot 展示身份（§5.4 提及）——一期先不做展示映射，引用直显 agwmngr 名称
3. inbox/outbox 与引擎 worker 的传输协议（HTTP 回调 vs 队列）——随 §7 契约定稿
