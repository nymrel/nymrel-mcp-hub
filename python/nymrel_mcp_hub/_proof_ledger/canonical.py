"""RFC 8785 JSON canonicalization with a frozen v1 compatibility profile."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Literal

import rfc8785

CanonicalizationProfile = Literal["rfc8785", "legacy"]


def canonicalize_legacy(value: Any) -> str:
    """Frozen serializer used by protocol v1 receipts."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("Cannot canonicalize non-finite numbers")
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize_legacy(item) for item in value) + "]"
    if isinstance(value, dict):
        entries = []
        for key in sorted(value.keys()):
            if not isinstance(key, str):
                raise TypeError("Canonical JSON object keys must be strings")
            entries.append(
                json.dumps(key, ensure_ascii=False, separators=(",", ":"))
                + ":"
                + canonicalize_legacy(value[key])
            )
        return "{" + ",".join(entries) + "}"
    raise TypeError(f"Unsupported type for canonicalization: {type(value)}")


def canonicalize(value: Any, profile: CanonicalizationProfile = "rfc8785") -> str:
    """Returns RFC 8785 JCS text, or the frozen v1 form when requested."""
    if profile == "legacy":
        return canonicalize_legacy(value)
    if profile != "rfc8785":
        raise ValueError(f"Unsupported canonicalization profile: {profile}")
    return rfc8785.dumps(value).decode("utf-8")


def canonical_hash(
    data: Any,
    algorithm: str = "sha256",
    profile: CanonicalizationProfile = "rfc8785",
) -> str:
    digest = hashlib.new(algorithm)
    digest.update(canonicalize(data, profile).encode("utf-8"))
    return digest.hexdigest()
