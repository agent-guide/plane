# 编排域业务控制状态机规格（阶段 2′ 实施基准）

- 文档类型：实施规格（自现有代码逐条提取，2026-10-28）
- 来源：`runtime_state_contract.py`（转移表）+ `runtime_execution_repository.transition_task_binding`（机制）+ 7 处调用点
- 用法：新实现（Plane inbox 事件消费器）逐条复刻本表；配套测试以本表为用例源

## 1. 状态集（七值，固定）

`queued / running / waiting_human / blocked / failed / completed / cancelled`

后三者为**终态**，无出边（任何从终态的转移直接抛契约错误）。

## 2. 合法转移表（唯一权威，逐字提取）

| 当前 ↓ | 可转移至 |
| --- | --- |
| queued | running, blocked, failed, cancelled |
| running | waiting_human, blocked, failed, completed, cancelled |
| waiting_human | running, blocked, failed, cancelled |
| blocked | queued, running, failed, cancelled |
| failed | （无） |
| completed | （无） |
| cancelled | （无） |

## 3. 转移机制（并发与一致性，必须等价）

1. **乐观锁**：UPDATE 带 `WHERE transition_version = 期望值 AND control_status = 当前值`；影响行数 ≠ 1 → 返回失败（调用方按冲突处理，不重试盲目覆盖）
2. **终态副作用**：进入终态时清空 `active_member_id`、写入 `completed_at`
3. **事件幂等锚**：每次转移写 `last_event_id`（事件去重/恢复判定依据）
4. **出站事件**：每次成功转移发控制状态 outbox 事件（新架构即 OrchestrationOutbox 的既有关联动作）

## 4. 七处调用点（触发场景 → 新归宿）

| # | 现有位置 | 转移 | 场景 | 新归宿 |
| --- | --- | --- | --- | --- |
| 1 | runtime_controlled_start_service:381 | （启动路径） | 受控启动主路径 | 启动命令处理（worker/服务） |
| 2 | runtime_controlled_start_service:402 | （恢复路径） | 启动恢复（recovered） | 启动命令处理-恢复分支 |
| 3 | workflow_run_service:796 | running→waiting_human + 设人工成员 | 引擎人工节点交接 | inbox：人工交接事件 |
| 4 | workflow_run_service:816 | waiting_human→running + 清成员 | 人工答复恢复 | inbox：答复事件 |
| 5 | workflow_terminal_settlement:101 | 引擎终态映射（success→completed / failed→failed / cancelled→cancelled） | 引擎运行终态结算 | inbox：引擎终态事件 |
| 6-7 | workflow_reconciliation_service:234,279 | queued→failed（陈旧排队对账） | 对账兜底 | inbox：对账事件（保留对账，口径见等价性清单） |

## 5. 配套测试（黄金基准，实施时移植）

现有测试中覆盖状态机的用例（tests 目录 grep `transition\|control_status` 定位，覆盖率报告核对）随实现移植；新增用例直接按第 2 节表格生成：**每行每目标一个合法用例 + 每终态×非法目标一个拒绝用例 + 并发冲突用例（同版本双改）**，共约 7×若干 + 3×4 + 1 组，全绿为完成标准。

## 6. 完整性声明

- 转移调用点：`grep transition_task_binding(` 共 7 处 → 本表 7/7
- 转移表：模块唯一（`CONTROL_TRANSITIONS`），无第二处定义
- 状态机相关 raise：`StatusSchemeContractError`（非法转移）唯一
