# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""编排域独立 app（阶段 2′）：团队/流程/绑定/执行/审批/成果的业务控制模型。

设计依据：docs/orchestration-plane-models-design.md（模型）、
docs/orchestration-state-machine-spec.md（状态机）、
docs/orchestration-validation-chains.md（校验链）。
独立纪律：模型/迁移/视图自持，对原生代码接触点仅 INSTALLED_APPS 与根 urls 注册。
"""
