# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE.txt file in the repository root for details.

"""Cross-repo contract test: the fork's webhook signing against the shared
golden vectors (implementation plan §7.1).

The vector file has a byte-identical twin in the experts-backend repository
(tests/contracts/plane_webhook_signature_vectors.json); both sides must
accept the same signatures. Changing the protocol requires changing both
files in lockstep — that is exactly the drift this test exists to catch.

Loaded by path so the module under test runs without the Django stack.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

VECTORS_PATH = Path(__file__).with_name("webhook_signature_vectors.json")
PROTOCOL_PATH = (
    Path(__file__).resolve().parents[2] / "bgtasks" / "webhook_protocol.py"
)


def _load_protocol():
    spec = importlib.util.spec_from_file_location("webhook_protocol", PROTOCOL_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _vectors() -> list[dict]:
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))["cases"]


def test_signature_matches_golden_vectors() -> None:
    protocol = _load_protocol()
    for case in _vectors():
        actual = protocol.sign_delivery(
            secret_key=case["secret"],
            version=case["version"],
            timestamp=case["timestamp"],
            event_id=case["event_id"],
            raw_body=case["raw_body"].encode("utf-8"),
        )
        assert actual == case["expected_signature"], (
            f"vector {case['name']}: signature drifted from the golden vector — "
            "the cross-repo contract is broken; update both twin files deliberately"
        )


def test_verify_accepts_golden_and_rejects_tampering() -> None:
    protocol = _load_protocol()
    for case in _vectors():
        kwargs = dict(
            secret_key=case["secret"],
            version=case["version"],
            timestamp=case["timestamp"],
            event_id=case["event_id"],
            raw_body=case["raw_body"].encode("utf-8"),
            signature=case["expected_signature"],
        )
        assert protocol.verify_delivery(**kwargs) is True, case["name"]
        tampered = dict(kwargs, raw_body=case["raw_body"].encode("utf-8") + b" ")
        assert protocol.verify_delivery(**tampered) is False, case["name"]
        wrong_secret = dict(kwargs, secret_key=case["secret"] + "x")
        assert protocol.verify_delivery(**wrong_secret) is False, case["name"]


def test_length_prefixing_is_unambiguous() -> None:
    """Guard the 'no delimiter-only concatenation' rule: shifting bytes
    between fields must change the signing material."""
    protocol = _load_protocol()
    a = protocol.length_prefixed_signing_material(
        version="1", timestamp="12", event_id="ab", raw_body=b"cd"
    )
    b = protocol.length_prefixed_signing_material(
        version="1", timestamp="1", event_id="2ab", raw_body=b"cd"
    )
    assert a != b
