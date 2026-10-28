# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""状态机契约测试（黄金基准，按规格表生成）。

来源：docs/orchestration-state-machine-spec.md 第 2 节；
移植自 experts-backend 契约测试语义并按表全量展开。
"""

from django.test import SimpleTestCase

from plane.orchestration.state_machine import (
    CONTROL_TRANSITIONS,
    TERMINAL_STATUSES,
    InvalidTransition,
    require_transition,
)

ALL_STATUSES = ["queued", "running", "waiting_human", "blocked", "failed", "completed", "cancelled"]

LEGAL = [
    ("queued", "running"), ("queued", "blocked"), ("queued", "failed"), ("queued", "cancelled"),
    ("running", "waiting_human"), ("running", "blocked"), ("running", "failed"), ("running", "completed"), ("running", "cancelled"),
    ("waiting_human", "running"), ("waiting_human", "blocked"), ("waiting_human", "failed"), ("waiting_human", "cancelled"),
    ("blocked", "queued"), ("blocked", "running"), ("blocked", "failed"), ("blocked", "cancelled"),
]


class TransitionTableContract(SimpleTestCase):
    def test_table_matches_spec_exactly(self):
        """规格第 2 节逐字对照（任何漂移即失败）。"""
        expected = {
            "queued": {"running", "blocked", "failed", "cancelled"},
            "running": {"waiting_human", "blocked", "failed", "completed", "cancelled"},
            "waiting_human": {"running", "blocked", "failed", "cancelled"},
            "blocked": {"queued", "running", "failed", "cancelled"},
            "failed": set(), "completed": set(), "cancelled": set(),
        }
        self.assertEqual({k: set(v) for k, v in CONTROL_TRANSITIONS.items()}, expected)

    def test_seven_statuses_fixed(self):
        self.assertEqual(set(ALL_STATUSES), set(CONTROL_TRANSITIONS))
        self.assertEqual(TERMINAL_STATUSES, {"failed", "completed", "cancelled"})


class LegalTransitions(SimpleTestCase):
    def test_all_legal_pass(self):
        for current, target in LEGAL:
            with self.subTest(f"{current}->{target}"):
                require_transition(current, target)  # 不抛即通过

    def test_legal_count_covers_every_nonterminal_row(self):
        nonterminal = [s for s in ALL_STATUSES if s not in TERMINAL_STATUSES]
        self.assertEqual(
            sorted({c for c, _ in LEGAL}), sorted(nonterminal),
            "每个非终态都应有出边",
        )


class IllegalTransitions(SimpleTestCase):
    def test_terminal_statuses_reject_everything(self):
        for terminal in TERMINAL_STATUSES:
            for target in ALL_STATUSES:
                with self.subTest(f"{terminal}->x{target}"):
                    with self.assertRaises(InvalidTransition):
                        require_transition(terminal, target)

    def test_unknown_and_backwards_rejected(self):
        for current, target in [
            ("queued", "queued"), ("queued", "waiting_human"), ("queued", "completed"),
            ("running", "queued"), ("waiting_human", "waiting_human"),
            ("unknown", "running"), ("running", "unknown"),
        ]:
            with self.subTest(f"{current}->{target}"):
                with self.assertRaises(InvalidTransition):
                    require_transition(current, target)
