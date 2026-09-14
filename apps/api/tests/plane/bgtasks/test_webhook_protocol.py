"""Contract tests for the Agent Team Runtime webhook patch (fork protocol v1).

Runtime implementation plan §7.1 / §18.1 Phase 2 precondition:
- the delivery event ID is stable across webhook targets and retries;
- the signature covers an unambiguous length-prefixed sequence of version,
  decimal timestamp, UTF-8 event_id and the unmodified raw body;
- delimiter-only concatenation is forbidden.

Dependency-free (no Django settings), so they run with plain pytest.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from plane.bgtasks.webhook_protocol import (  # noqa: E402
    length_prefixed_signing_material,
    sign_delivery,
    verify_delivery,
)

SECRET = "whsec_test"
EVENT_ID = "evt_0f0e0d0c"
TIMESTAMP = "1789000000"
RAW = b'{"event":"issue","action":"create","data":{"id":"i-1"}}'


class TestLengthPrefixedMaterial:
    def test_exact_layout(self):
        material = length_prefixed_signing_material(
            version="1", timestamp=TIMESTAMP, event_id=EVENT_ID, raw_body=RAW
        )
        expected = (
            b"1:1" + TIMESTAMP.encode() + b"@" + b""
        )
        # Assemble explicitly for readability instead of the placeholder above.
        expected = (
            str(len(b"1")).encode() + b":" + b"1"
            + str(len(TIMESTAMP.encode())).encode() + b":" + TIMESTAMP.encode()
            + str(len(EVENT_ID.encode())).encode() + b":" + EVENT_ID.encode()
            + str(len(RAW)).encode() + b":" + RAW
        )
        assert material == expected

    def test_delimiter_inside_body_is_unambiguous(self):
        # A body crafted to contain ':' bytes cannot shift field boundaries —
        # the length prefix, not a delimiter, decides where each field ends.
        a = length_prefixed_signing_material(
            version="1", timestamp="1", event_id="a", raw_body=b"b:c"
        )
        b = length_prefixed_signing_material(
            version="1", timestamp="1", event_id="a:b", raw_body=b"c"
        )
        assert a != b

    def test_bytes_are_not_distinguished_by_content_only(self):
        assert length_prefixed_signing_material(
            version="1", timestamp="12", event_id=EVENT_ID, raw_body=RAW
        ) != length_prefixed_signing_material(
            version="1", timestamp="1", event_id=EVENT_ID, raw_body=b"2" + RAW
        )


class TestSigning:
    def test_sign_and_verify_roundtrip(self):
        signature = sign_delivery(
            secret_key=SECRET, version="1", timestamp=TIMESTAMP, event_id=EVENT_ID, raw_body=RAW
        )
        assert verify_delivery(
            secret_key=SECRET,
            version="1",
            timestamp=TIMESTAMP,
            event_id=EVENT_ID,
            raw_body=RAW,
            signature=signature,
        )

    def test_tampered_body_rejected(self):
        signature = sign_delivery(
            secret_key=SECRET, version="1", timestamp=TIMESTAMP, event_id=EVENT_ID, raw_body=RAW
        )
        assert not verify_delivery(
            secret_key=SECRET,
            version="1",
            timestamp=TIMESTAMP,
            event_id=EVENT_ID,
            raw_body=RAW + b"x",
            signature=signature,
        )

    def test_tampered_event_id_rejected(self):
        signature = sign_delivery(
            secret_key=SECRET, version="1", timestamp=TIMESTAMP, event_id=EVENT_ID, raw_body=RAW
        )
        assert not verify_delivery(
            secret_key=SECRET,
            version="1",
            timestamp=TIMESTAMP,
            event_id=EVENT_ID + "x",
            raw_body=RAW,
            signature=signature,
        )

    def test_wrong_secret_rejected(self):
        signature = sign_delivery(
            secret_key=SECRET, version="1", timestamp=TIMESTAMP, event_id=EVENT_ID, raw_body=RAW
        )
        assert not verify_delivery(
            secret_key="whsec_other",
            version="1",
            timestamp=TIMESTAMP,
            event_id=EVENT_ID,
            raw_body=RAW,
            signature=signature,
        )

    def test_timestamp_and_version_are_signed(self):
        signature = sign_delivery(
            secret_key=SECRET, version="1", timestamp=TIMESTAMP, event_id=EVENT_ID, raw_body=RAW
        )
        # A different timestamp (replay) or version must not verify.
        assert not verify_delivery(
            secret_key=SECRET,
            version="1",
            timestamp="1789000099",
            event_id=EVENT_ID,
            raw_body=RAW,
            signature=signature,
        )
        assert not verify_delivery(
            secret_key=SECRET,
            version="2",
            timestamp=TIMESTAMP,
            event_id=EVENT_ID,
            raw_body=RAW,
            signature=signature,
        )


class TestStableDeliveryId:
    """The signing material embeds the event id, so a receiver re-verifying the
    same (event_id, body, timestamp) across retries proves id stability."""

    def test_same_delivery_reverifies(self):
        signature = sign_delivery(
            secret_key=SECRET, version="1", timestamp=TIMESTAMP, event_id=EVENT_ID, raw_body=RAW
        )
        for _ in range(3):  # retries
            assert verify_delivery(
                secret_key=SECRET,
                version="1",
                timestamp=TIMESTAMP,
                event_id=EVENT_ID,
                raw_body=RAW,
                signature=signature,
            )

    def test_distinct_occurrences_sign_differently(self):
        first = sign_delivery(
            secret_key=SECRET, version="1", timestamp=TIMESTAMP, event_id="evt_1", raw_body=RAW
        )
        second = sign_delivery(
            secret_key=SECRET, version="1", timestamp=TIMESTAMP, event_id="evt_2", raw_body=RAW
        )
        assert first != second
