# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Agent Team Runtime webhook patch — fork protocol v1.

Contract (Runtime implementation plan §7.1): the delivery event ID is stable
across webhook targets and delivery retries, and the signature covers an
unambiguous length-prefixed sequence of version, decimal timestamp, UTF-8
event_id and the unmodified raw body. Delimiter-only concatenation is
forbidden. This module is dependency-free so the contract tests run without
the Django stack.
"""

from __future__ import annotations

import hashlib
import hmac

SIGNATURE_VERSION = "1"


def length_prefixed_signing_material(
    *, version: str, timestamp: str, event_id: str, raw_body: bytes
) -> bytes:
    """Each field is encoded as its ASCII decimal byte length, a ':', and its
    bytes; the four segments are then concatenated."""
    segments = [
        version.encode("utf-8"),
        timestamp.encode("utf-8"),
        event_id.encode("utf-8"),
        raw_body,
    ]
    return b"".join(str(len(segment)).encode("ascii") + b":" + segment for segment in segments)


def sign_delivery(*, secret_key: str, version: str, timestamp: str, event_id: str, raw_body: bytes) -> str:
    return hmac.new(
        secret_key.encode("utf-8"),
        length_prefixed_signing_material(
            version=version, timestamp=timestamp, event_id=event_id, raw_body=raw_body
        ),
        hashlib.sha256,
    ).hexdigest()


def verify_delivery(
    *, secret_key: str, version: str, timestamp: str, event_id: str, raw_body: bytes, signature: str
) -> bool:
    return hmac.compare_digest(
        sign_delivery(
            secret_key=secret_key,
            version=version,
            timestamp=timestamp,
            event_id=event_id,
            raw_body=raw_body,
        ),
        signature,
    )
