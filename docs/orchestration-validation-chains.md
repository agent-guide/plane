# 编排域校验链清单（阶段 2′ 实施基准）

- 文档类型：实施规格（自现有代码提取，2026-10-28）
- 提取方法：全量 `raise ApiError` 计数分桶 + 编排域逐条错误码提取（计数核对见文末账目）

## 1. 关键操作校验链（按业务动作）

### 绑定项目（project_team_binding_service，9 个错误码）

```
PROJECT_NOT_FOUND → PROJECT_INACTIVE → AGENT_TEAM_NOT_FOUND → AGENT_TEAM_INACTIVE
→ PROJECT_TEAM_BINDING_CONFLICT（已有活跃绑定）
→ WORKFLOW_VERSION_NOT_FOUND → WORKFLOW_VERSION_NOT_PUBLISHED
→ WORKFLOW_ENGINE_CONNECTION_INACTIVE
```

### 受控启动（runtime_controlled_start_service，7 个错误码）

```
TASK_NOT_FOUND → TASK_BINDING_CONFLICT（已有活跃执行）
→ AGENT_TEAM_EMPTY（无启用成员）→ RUNTIME_IDENTITY_DISABLED
→ WORKFLOW_ENGINE_UNAVAILABLE
→ RUNTIME_START_IDEMPOTENCY_CONFLICT（幂等键冲突）→ RUNTIME_START_INCOMPLETE
```

### 团队管理（agent_team_service，13 个错误码）

```
AGENT_TEAM_NOT_FOUND / AGENT_TEAM_FORBIDDEN（权限矩阵）
/ AGENT_TEAM_NAME_CONFLICT（工作区内重名）
/ AGENT_TEAM_EMPTY（上架前置：≥1 启用成员）
/ AGENT_TEAM_ARCHIVE_FORBIDDEN（归档仅管理员）
/ AGENT_TEAM_MEMBER_NOT_FOUND / AGENT_TEAM_MEMBER_CONFLICT
/ RUNTIME_IDENTITY_DISABLED
```

### 流程域（project_workflow_service + workflow/query，约 20 个错误码）

```
WORKFLOW_NOT_FOUND / WORKFLOW_OWNER_REQUIRED（项目成员权限）
/ WORKFLOW_DEFINITION_INVALID（画布定义校验）
/ WORKFLOW_VERSION_NOT_FOUND
+ 发布链错误（引擎能力/连接未就绪，详见 workflow_service 与引擎校验模块）
```

## 2. 编排域 raise 计数账目（完整性核对基准）

| 文件 | raise 数 | 新归宿 |
| --- | --- | --- |
| agent_team_service | 16 | Plane 团队服务层（权限矩阵+生命周期逐条复刻） |
| project_team_binding_service | 15 | Plane 绑定服务层 |
| runtime_controlled_start_service | 20 | 启动命令处理（worker） |
| project_workflow_service | 21 | Plane 流程服务层 |
| runtime_execution_service | 14 | inbox 事件消费器 |
| workflow_service / query_service | 6 + 6 | Plane 流程服务层 |
| workflow_runs 路由 | 17 | Plane 执行查询接口 |
| runtime_tasks / internal_workflow_runs / bindings 路由 | 3 + 3 + 1 | Plane 对应路由 |
| **编排域合计** | **≈122** | 实施完成逐文件核对 N/N |

## 3. 全量 479 处的分域账目（范围界定）

| 域 | 处数（约） | 处置 |
| --- | --- | --- |
| **编排域（本清单范围）** | **122** | 逐条复刻（见上表） |
| 资源域（skills/library/document/knowledge/expert/object_store） | ≈150 | agwmngr/同事侧（不在本域） |
| 连接与身份（runtime_connection/auth/exchange/webhook/mapping/proposal） | ≈85 | 过渡保留，终局退役 |
| 管理端支撑（tenant/rbac/users/deps/board/task_workflow/builds） | ≈60 | 随 admin 退役/过渡 |
| 其他（storage/ops 等） | ≈62 | 逐文件归类〔待走查：ops 的队列信号接口属运维观测，新架构归 worker 健康接口〕 |

## 4. 数据库约束账目（32 个迁移文件的约束提取）

〔实施前置补全：逐迁移文件列出唯一索引/外键/检查约束 → 映射 Django 模型 constraints；数据盘点已核对主要表结构〕

## 5. 实施规则

1. 每条错误码在新实现中保留**同语义错误**（码名可换，触发条件与 HTTP 语义不变）
2. 校验顺序保持一致（顺序影响哪条错误先暴露，前端提示依赖）
3. 配套测试按「每码至少一个触发用例」移植

## 6. 覆盖率交叉验证结果（2026-10-28，658 测试 + pytest-cov）

- **全仓覆盖率 82.9%**（12959/15635 行）；未覆盖 17% 主要分布在资源域/过渡域/管理端支撑（不在本清单范围）
- **编排域核心文件覆盖率 78–100%**：

| 文件 | 覆盖率 | 未覆盖行 |
| --- | --- | --- |
| runtime_state_contract（状态机表） | **100%** | 0 |
| runtime_execution_service | 93% | 18 |
| workflow_terminal_settlement | 92% | 2 |
| runtime_controlled_start_service | 88% | 20 |
| workflow_run_service | 86% | 66 |
| project_team_binding_service | 85% | 18 |
| agent_team_service | 81% | 23 |
| project_workflow_service | 78% | 36 |
| workflow_reconciliation_service | 80% | 55 |

- **人工走查范围收敛为 238 行**（上述未覆盖行合计）——实施前逐行过一遍标注行为归属，即完成全覆盖闭环；已覆盖部分由测试作为行为证明
- 状态机契约表 100% 覆盖 = 第 1 份规格的机器证明已闭环

## 7. 238 行未覆盖走查标注（2026-10-28，代表性抽样 + 最大块全读）

未覆盖行经走查分为四类，全部有归宿：

| 类别 | 占比（约） | 内容示例 | 归宿 |
| --- | --- | --- | --- |
| A. 错误分支 | ~55% | 404/409 的单行 raise（如 AGENT_HUMAN_REQUEST_NOT_FOUND） | 校验链清单已逐码覆盖，移植测试按码补用例即可 |
| B. 恢复/对账路径 | ~25% | 启动恢复的引擎校验、cancellation.gateway.result 事件扫描、幂等冲突分支 | 状态机规格第 4 节调用点 2/6/7 对应；移植时按规格补测试 |
| C. 引擎语义特判 | ~12% | **重试预算判定**（节点失败但重试额度未尽时 run 不判失败，workflow_run:1315）——精妙语义，无测试 | 〔实施时必须补规格测试〕——见下发现② |
| D. 防护守卫 | ~8% | 值解析容错 continue、边界空值 | 随域复刻，低风险 |

**走查发现（重要）**：
- ① agent_team_service:247-269「**活跃团队禁用最后一名启用成员**」的 409 防护（AGENT_TEAM_EMPTY）无测试覆盖——等价性清单已含此规则，实施时按规格补测试，不依赖旧测试
- ② workflow_run 重试预算判定无测试——移植时需按状态机规格衍生「失败但额度未尽→不判失败」用例
- 结论：未覆盖区**没有发现无归宿的隐藏行为**；四类全部落在两份规格的覆盖面内，走查闭环
