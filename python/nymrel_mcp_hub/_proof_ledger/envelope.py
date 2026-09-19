"""
Cross-runtime receipt-envelope interoperability validator (Python mirror).

Performs focused, dependency-free structural validation of a Nymrel proof
receipt envelope (protocol identifier, version, and core-field shape) so a
caller can decide whether an envelope is portable across the TypeScript and
Python runtimes BEFORE running cryptographic verification.

This module is intentionally self-contained: it imports only the standard
library, performs no hashing, no signature checks, and no Merkle
recomputation. Structural shape only. Cryptographic integrity remains the
responsibility of ``verify_receipt``.

The TypeScript original lives at ``src/core/envelope.ts`` and must produce
byte-identical error codes, paths, ordering, and messages for the same input.
Any change here must be mirrored there (and vice versa).
"""

import json
import re
from typing import Any

RECEIPT_PROTOCOL = "nymrel-proof-ledger"

SUPPORTED_RECEIPT_VERSION = "2.0.0"
SUPPORTED_RECEIPT_VERSIONS = ("1.0.0", SUPPORTED_RECEIPT_VERSION)


class EnvelopeErrorCode:
    """Stable machine-readable error codes reported by envelope validation."""

    ENVELOPE_NOT_OBJECT = "ENVELOPE_NOT_OBJECT"
    PROTOCOL_MISSING = "PROTOCOL_MISSING"
    PROTOCOL_UNSUPPORTED = "PROTOCOL_UNSUPPORTED"
    VERSION_MISSING = "VERSION_MISSING"
    VERSION_UNSUPPORTED = "VERSION_UNSUPPORTED"
    FIELD_MISSING = "FIELD_MISSING"
    FIELD_TYPE_INVALID = "FIELD_TYPE_INVALID"
    TIMESTAMP_MALFORMED = "TIMESTAMP_MALFORMED"
    HASH_MALFORMED = "HASH_MALFORMED"


HEX_64_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")

# RFC 3339 timestamp shape check. Applied identically in both runtimes so the
# accept/reject set is deterministic cross-runtime (locale-dependent date
# parsers are deliberately avoided).
RFC3339_PATTERN = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$"
)


def _is_plain_object(value: Any) -> bool:
    return isinstance(value, dict)


def _is_non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and len(value) > 0


def _is_non_negative_integer(value: Any) -> bool:
    # bool is a subclass of int in Python; reject it explicitly so JSON
    # true/false never passes as sizeBytes.
    return (
        isinstance(value, (int, float)) and not isinstance(value, bool)
        and 0 <= value <= 9007199254740991
        and (isinstance(value, int) or value.is_integer())
    )


def _render_value(value: Any) -> str:
    try:
        # Match JavaScript JSON.stringify: preserve Unicode code points instead
        # of rendering them as ASCII escape sequences inside error messages.
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(value)


def validate_receipt_envelope(receipt: Any) -> dict[str, Any]:
    """
    Validates the structural envelope of a Nymrel proof receipt.

    Unknown extra fields are allowed (forward compatibility); unsupported
    protocol or version values are rejected with dedicated codes. Errors are
    reported in a fixed field order so both runtimes emit identical sequences.

    Returns ``{"valid": bool, "errors": [{"code", "path", "message"}, ...]}``.
    """
    if not _is_plain_object(receipt):
        return {
            "valid": False,
            "errors": [
                {
                    "code": EnvelopeErrorCode.ENVELOPE_NOT_OBJECT,
                    "path": None,
                    "message": "Receipt envelope must be a JSON object.",
                }
            ],
        }

    errors: list[dict[str, Any]] = []

    def push(code: str, path: str | None, message: str) -> None:
        errors.append({"code": code, "path": path, "message": message})

    def require_non_empty_string(
        container: dict[str, Any], key: str, path: str | None = None
    ) -> bool:
        path = path or key
        if key not in container:
            push(
                EnvelopeErrorCode.FIELD_MISSING,
                path,
                f"Required field '{path}' is missing.",
            )
            return False
        if not _is_non_empty_string(container[key]):
            push(
                EnvelopeErrorCode.FIELD_TYPE_INVALID,
                path,
                f"Field '{path}' must be a non-empty string.",
            )
            return False
        return True

    # 1. Protocol identifier
    if "protocol" not in receipt:
        push(
            EnvelopeErrorCode.PROTOCOL_MISSING,
            "protocol",
            "Required field 'protocol' is missing.",
        )
    elif receipt["protocol"] != RECEIPT_PROTOCOL:
        push(
            EnvelopeErrorCode.PROTOCOL_UNSUPPORTED,
            "protocol",
            "Unsupported protocol identifier: expected "
            f"'{RECEIPT_PROTOCOL}', got {_render_value(receipt['protocol'])}.",
        )

    # 2. Version gate
    if "version" not in receipt:
        push(
            EnvelopeErrorCode.VERSION_MISSING,
            "version",
            "Required field 'version' is missing.",
        )
    elif (
        not isinstance(receipt["version"], str)
        or receipt["version"] not in SUPPORTED_RECEIPT_VERSIONS
    ):
        push(
            EnvelopeErrorCode.VERSION_UNSUPPORTED,
            "version",
            "Unsupported receipt version: expected one of '1.0.0', "
            f"'{SUPPORTED_RECEIPT_VERSION}', got {_render_value(receipt['version'])}.",
        )

    # 3. Core scalar fields
    require_non_empty_string(receipt, "proofId")

    if "timestamp" not in receipt:
        push(
            EnvelopeErrorCode.FIELD_MISSING,
            "timestamp",
            "Required field 'timestamp' is missing.",
        )
    elif not isinstance(receipt["timestamp"], str):
        push(
            EnvelopeErrorCode.FIELD_TYPE_INVALID,
            "timestamp",
            "Field 'timestamp' must be a non-empty string.",
        )
    elif RFC3339_PATTERN.fullmatch(receipt["timestamp"]) is None:
        push(
            EnvelopeErrorCode.TIMESTAMP_MALFORMED,
            "timestamp",
            "Field 'timestamp' must be an RFC 3339 timestamp string.",
        )

    require_non_empty_string(receipt, "parentOrganization")

    # 4. Task record
    if "task" not in receipt:
        push(
            EnvelopeErrorCode.FIELD_MISSING, "task", "Required field 'task' is missing."
        )
    elif not _is_plain_object(receipt["task"]):
        push(
            EnvelopeErrorCode.FIELD_TYPE_INVALID,
            "task",
            "Field 'task' must be a JSON object.",
        )
    else:
        require_non_empty_string(receipt["task"], "name", "task.name")

    # 5. Environment record
    if "environment" not in receipt:
        push(
            EnvelopeErrorCode.FIELD_MISSING,
            "environment",
            "Required field 'environment' is missing.",
        )
    elif not _is_plain_object(receipt["environment"]):
        push(
            EnvelopeErrorCode.FIELD_TYPE_INVALID,
            "environment",
            "Field 'environment' must be a JSON object.",
        )
    else:
        environment = receipt["environment"]
        require_non_empty_string(environment, "platform", "environment.platform")
        require_non_empty_string(environment, "arch", "environment.arch")
        require_non_empty_string(environment, "runtime", "environment.runtime")

    # 6. Artifacts array
    if "artifacts" not in receipt:
        push(
            EnvelopeErrorCode.FIELD_MISSING,
            "artifacts",
            "Required field 'artifacts' is missing.",
        )
    elif not isinstance(receipt["artifacts"], list):
        push(
            EnvelopeErrorCode.FIELD_TYPE_INVALID,
            "artifacts",
            "Field 'artifacts' must be an array.",
        )
    else:
        for index, item in enumerate(receipt["artifacts"]):
            item_path = f"artifacts[{index}]"
            if not _is_plain_object(item):
                push(
                    EnvelopeErrorCode.FIELD_TYPE_INVALID,
                    item_path,
                    f"Field '{item_path}' must be a JSON object.",
                )
                continue
            require_non_empty_string(item, "path", f"{item_path}.path")
            if "sha256" not in item:
                push(
                    EnvelopeErrorCode.FIELD_MISSING,
                    f"{item_path}.sha256",
                    f"Required field '{item_path}.sha256' is missing.",
                )
            elif (
                not isinstance(item["sha256"], str)
                or HEX_64_PATTERN.fullmatch(item["sha256"]) is None
            ):
                push(
                    EnvelopeErrorCode.HASH_MALFORMED,
                    f"{item_path}.sha256",
                    f"Field '{item_path}.sha256' must be a 64-character hexadecimal SHA-256 digest.",
                )
            if "sizeBytes" not in item:
                push(
                    EnvelopeErrorCode.FIELD_MISSING,
                    f"{item_path}.sizeBytes",
                    f"Required field '{item_path}.sizeBytes' is missing.",
                )
            elif not _is_non_negative_integer(item["sizeBytes"]):
                push(
                    EnvelopeErrorCode.FIELD_TYPE_INVALID,
                    f"{item_path}.sizeBytes",
                    f"Field '{item_path}.sizeBytes' must be an integer greater than or equal to 0.",
                )

    # 7. Merkle block
    if "merkle" not in receipt:
        push(
            EnvelopeErrorCode.FIELD_MISSING,
            "merkle",
            "Required field 'merkle' is missing.",
        )
    elif not _is_plain_object(receipt["merkle"]):
        push(
            EnvelopeErrorCode.FIELD_TYPE_INVALID,
            "merkle",
            "Field 'merkle' must be a JSON object.",
        )
    else:
        merkle = receipt["merkle"]

        if "algorithm" not in merkle:
            push(
                EnvelopeErrorCode.FIELD_MISSING,
                "merkle.algorithm",
                "Required field 'merkle.algorithm' is missing.",
            )
        elif receipt.get("version") in SUPPORTED_RECEIPT_VERSIONS:
            expected_algorithm = (
                "RFC6962-SHA256"
                if receipt.get("version") == SUPPORTED_RECEIPT_VERSION
                else "SHA-256"
            )
            if merkle["algorithm"] != expected_algorithm:
                push(
                    EnvelopeErrorCode.FIELD_TYPE_INVALID,
                    "merkle.algorithm",
                    f"Field 'merkle.algorithm' must be '{expected_algorithm}' "
                    f"for receipt version '{receipt.get('version')}'.",
                )

        if "leaves" not in merkle:
            push(
                EnvelopeErrorCode.FIELD_MISSING,
                "merkle.leaves",
                "Required field 'merkle.leaves' is missing.",
            )
        elif not isinstance(merkle["leaves"], list):
            push(
                EnvelopeErrorCode.FIELD_TYPE_INVALID,
                "merkle.leaves",
                "Field 'merkle.leaves' must be an array.",
            )
        else:
            for index, leaf in enumerate(merkle["leaves"]):
                if not isinstance(leaf, str) or HEX_64_PATTERN.fullmatch(leaf) is None:
                    push(
                        EnvelopeErrorCode.HASH_MALFORMED,
                        f"merkle.leaves[{index}]",
                        f"Field 'merkle.leaves[{index}]' must be a 64-character hexadecimal SHA-256 digest.",
                    )

        if "root" not in merkle:
            push(
                EnvelopeErrorCode.FIELD_MISSING,
                "merkle.root",
                "Required field 'merkle.root' is missing.",
            )
        elif (
            not isinstance(merkle["root"], str)
            or HEX_64_PATTERN.fullmatch(merkle["root"]) is None
        ):
            push(
                EnvelopeErrorCode.HASH_MALFORMED,
                "merkle.root",
                "Field 'merkle.root' must be a 64-character hexadecimal SHA-256 digest.",
            )

    # 8. Signature record
    if "signature" not in receipt:
        push(
            EnvelopeErrorCode.FIELD_MISSING,
            "signature",
            "Required field 'signature' is missing.",
        )
    elif not _is_plain_object(receipt["signature"]):
        push(
            EnvelopeErrorCode.FIELD_TYPE_INVALID,
            "signature",
            "Field 'signature' must be a JSON object.",
        )
    else:
        signature = receipt["signature"]
        signature_algorithm_valid = require_non_empty_string(
            signature, "algorithm", "signature.algorithm"
        )
        if signature_algorithm_valid and signature["algorithm"] not in (
            "HMAC-SHA256",
            "Ed25519",
        ):
            push(
                EnvelopeErrorCode.FIELD_TYPE_INVALID,
                "signature.algorithm",
                "Field 'signature.algorithm' must be 'HMAC-SHA256' or 'Ed25519'.",
            )
        require_non_empty_string(signature, "keyId", "signature.keyId")
        require_non_empty_string(
            signature, "signerIdentity", "signature.signerIdentity"
        )
        signature_value_valid = require_non_empty_string(signature, "value", "signature.value")
        if signature_value_valid and signature.get('algorithm') in ('HMAC-SHA256', 'Ed25519'):
            length = 64 if signature['algorithm'] == 'HMAC-SHA256' else 128
            if re.fullmatch(rf'[0-9a-fA-F]{{{length}}}', signature['value']) is None:
                push(EnvelopeErrorCode.FIELD_TYPE_INVALID, 'signature.value',
                     "Field 'signature.value' encoding must match the declared algorithm.")

        if "timestamp" not in signature:
            push(
                EnvelopeErrorCode.FIELD_MISSING,
                "signature.timestamp",
                "Required field 'signature.timestamp' is missing.",
            )
        elif not isinstance(signature["timestamp"], str) or (
            RFC3339_PATTERN.fullmatch(signature["timestamp"]) is None
        ):
            push(
                EnvelopeErrorCode.TIMESTAMP_MALFORMED,
                "signature.timestamp",
                "Field 'signature.timestamp' must be an RFC 3339 timestamp string.",
            )

    # 9. Metadata object
    if "metadata" not in receipt:
        push(
            EnvelopeErrorCode.FIELD_MISSING,
            "metadata",
            "Required field 'metadata' is missing.",
        )
    elif not _is_plain_object(receipt["metadata"]):
        push(
            EnvelopeErrorCode.FIELD_TYPE_INVALID,
            "metadata",
            "Field 'metadata' must be a JSON object.",
        )

    return {"valid": len(errors) == 0, "errors": errors}
