# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""业务控制状态机契约（自 experts-backend runtime_state_contract 逐字移植）。

转移表唯一权威 = docs/orchestration-state-machine-spec.md 第 2 节；
配套测试按规格表生成（每合法转移 + 每终态拒绝 + 并发冲突）。
"""

CONTROL_TRANSITIONS: dict[str, frozenset[str]] = {
    "queued": frozenset({"running", "blocked", "failed", "cancelled"}),
    "running": frozenset({"waiting_human", "blocked", "failed", "completed", "cancelled"}),
    "waiting_human": frozenset({"running", "blocked", "failed", "cancelled"}),
    "blocked": frozenset({"queued", "running", "failed", "cancelled"}),
    "failed": frozenset(),
    "completed": frozenset(),
    "cancelled": frozenset(),
}

TERMINAL_STATUSES = frozenset({"failed", "completed", "cancelled"})

STATUS_CHOICES = [(s, s) for s in (
    "queued", "running", "waiting_human", "blocked", "failed", "completed", "cancelled",
)]


class InvalidTransition(ValueError):
    """非法业务控制转移（对应旧 StatusSchemeContractError 语义）。"""


def require_transition(current: str, target: str) -> None:
    if target not in CONTROL_TRANSITIONS.get(current, frozenset()):
        raise InvalidTransition(f"Invalid control transition: {current} -> {target}")
