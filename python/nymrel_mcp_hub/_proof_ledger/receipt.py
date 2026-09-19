"""Versioned proof receipt generation and verification."""

from __future__ import annotations

import hashlib
import os
import platform
import re
import subprocess
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .canonical import canonical_hash
from .envelope import validate_receipt_envelope
from .merkle import MerkleTree
from .signer import ProofSigner

RECEIPT_PROTOCOL = "nymrel-proof-ledger"
RECEIPT_VERSION = "2.0.0"
LEGACY_RECEIPT_VERSION = "1.0.0"
RFC6962_MERKLE_ALGORITHM = "RFC6962-SHA256"
LEGACY_MERKLE_ALGORITHM = "SHA-256"


def sanitize_git_remote(remote: str) -> str | None:
    trimmed = remote.strip()
    if re.fullmatch(r"git@[A-Za-z0-9.-]+:[^\s?#]+", trimmed):
        return trimmed
    try:
        parsed = urlsplit(trimmed)
        if parsed.scheme not in ("https", "http", "ssh", "git") or not parsed.hostname:
            return None
        host = parsed.hostname
        if parsed.port is not None:
            host = f"{host}:{parsed.port}"
        return urlunsplit((parsed.scheme, host, parsed.path, "", ""))
    except (ValueError, TypeError):
        return None


def get_git_context(cwd: str | None = None) -> dict[str, Any] | None:
    cwd = cwd or os.getcwd()
    try:
        commit = (
            subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=cwd, stderr=subprocess.DEVNULL
            )
            .decode("utf-8")
            .strip()
        )
        branch = (
            subprocess.check_output(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=cwd,
                stderr=subprocess.DEVNULL,
            )
            .decode("utf-8")
            .strip()
        )
        dirty = bool(
            subprocess.check_output(
                ["git", "status", "--porcelain"], cwd=cwd, stderr=subprocess.DEVNULL
            )
            .decode("utf-8")
            .strip()
        )
        remote = None
        try:
            remote = sanitize_git_remote(
                subprocess.check_output(
                    ["git", "config", "--get", "remote.origin.url"],
                    cwd=cwd,
                    stderr=subprocess.DEVNULL,
                ).decode("utf-8")
            )
        except (OSError, subprocess.SubprocessError):
            remote = None
        return {
            "commit": commit,
            "branch": branch,
            "dirty": dirty,
            **({} if remote is None else {"remote": remote}),
        }
    except (OSError, subprocess.SubprocessError):
        return None


def hash_artifact(
    artifact_path: str,
    data: str | bytes | None = None,
    cwd: str | None = None,
) -> dict[str, Any]:
    cwd = cwd or os.getcwd()
    resolved = (
        artifact_path
        if os.path.isabs(artifact_path)
        else os.path.abspath(os.path.join(cwd, artifact_path))
    )
    if data is None:
        with open(resolved, "rb") as file:
            buffer = file.read()
    else:
        buffer = data.encode("utf-8") if isinstance(data, str) else bytes(data)
    try:
        relative = os.path.relpath(resolved, cwd).replace("\\", "/")
    except ValueError:
        relative = artifact_path
    return {
        "path": relative or artifact_path,
        "sha256": hashlib.sha256(buffer).hexdigest(),
        "sizeBytes": len(buffer),
    }


def _profiles(version: str) -> tuple[str, str]:
    return (
        ("legacy", "legacy-duplicated")
        if version == LEGACY_RECEIPT_VERSION
        else ("rfc8785", "rfc6962")
    )


def _receipt_leaves(
    task: dict[str, Any],
    environment: dict[str, Any],
    artifacts: list[dict[str, Any]],
    version: str,
) -> list[str]:
    canonical_profile, _ = _profiles(version)
    artifact_leaves = (
        [artifact["sha256"] for artifact in artifacts]
        if version == LEGACY_RECEIPT_VERSION
        else [
            canonical_hash(artifact, profile=canonical_profile)
            for artifact in artifacts
        ]
    )
    return [
        canonical_hash(task, profile=canonical_profile),
        canonical_hash(environment, profile=canonical_profile),
        *artifact_leaves,
    ]


def _signing_payload(
    receipt: dict[str, Any],
    signature: dict[str, Any] | None = None,
) -> dict[str, Any]:
    legacy_payload = {
        "proofId": receipt["proofId"],
        "timestamp": receipt["timestamp"],
        "parentOrganization": receipt["parentOrganization"],
        "taskName": receipt["task"]["name"],
        "merkleRoot": receipt["merkle"]["root"],
    }
    if receipt["version"] == LEGACY_RECEIPT_VERSION:
        return legacy_payload
    if signature is None:
        raise ValueError("Protocol v2 signing requires a complete signature header")
    return {
        "protocol": receipt["protocol"],
        "version": receipt["version"],
        "merkleAlgorithm": receipt["merkle"]["algorithm"],
        "metadataHash": canonical_hash(receipt["metadata"]),
        "signatureAlgorithm": signature["algorithm"],
        "signatureKeyId": signature["keyId"],
        "signerIdentity": signature["signerIdentity"],
        "signatureTimestamp": signature["timestamp"],
        **legacy_payload,
    }


def create_receipt(
    task: dict[str, Any],
    signing_key: str,
    signer_identity: str,
    artifacts: list[dict[str, Any]] | None = None,
    key_id: str | None = None,
    algorithm: str = "HMAC-SHA256",
    metadata: dict[str, Any] | None = None,
    cwd: str | None = None,
    include_hostname: bool = False,
    include_git_context: bool = True,
) -> dict[str, Any]:
    cwd = cwd or os.getcwd()
    now = datetime.now(UTC)
    proof_id = f"prf_{int(now.timestamp()):x}_{os.urandom(6).hex()}"
    timestamp = now.isoformat().replace("+00:00", "Z")
    processed_artifacts: list[dict[str, Any]] = []
    for item in artifacts or []:
        artifact = hash_artifact(item["path"], item.get("data"), cwd)
        if "mimeType" in item:
            artifact["mimeType"] = item["mimeType"]
        processed_artifacts.append(artifact)

    environment: dict[str, Any] = {
        "platform": platform.system().lower(),
        "arch": platform.machine().lower(),
        "runtime": f"python {platform.python_version()}",
    }
    if include_hostname:
        environment["hostname"] = platform.node()
    git = get_git_context(cwd) if include_git_context else None
    if git is not None:
        environment["git"] = git

    task_record: dict[str, Any] = {
        "name": task["name"],
        "runner": task.get("runner", "nymrel-agent"),
        "status": task.get("status", "SUCCESS"),
        "exitCode": task.get("exitCode", 0),
    }
    for optional in ("description", "durationMs", "command"):
        if optional in task:
            task_record[optional] = task[optional]

    leaves = _receipt_leaves(
        task_record, environment, processed_artifacts, RECEIPT_VERSION
    )
    tree = MerkleTree(leaves, is_pre_hashed=True, profile="rfc6962")
    receipt_metadata = metadata or {}
    unsigned: dict[str, Any] = {
        "protocol": RECEIPT_PROTOCOL,
        "version": RECEIPT_VERSION,
        "proofId": proof_id,
        "timestamp": timestamp,
        "parentOrganization": "Nymrel",
        "task": task_record,
        "merkle": {
            "algorithm": RFC6962_MERKLE_ALGORITHM,
            "leaves": tree.get_leaves(),
            "root": tree.get_root(),
        },
        "metadata": receipt_metadata,
    }
    resolved_key_id = key_id or (
        "ed25519-primary" if algorithm == "Ed25519" else "hmac-default"
    )
    signature_header = {
        "algorithm": algorithm,
        "keyId": resolved_key_id,
        "signerIdentity": signer_identity,
        "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }
    signature = {
        **signature_header,
        "value": ProofSigner.sign_payload(
            _signing_payload(unsigned, signature_header),
            signing_key,
            algorithm,
            "rfc8785",
        ),
    }
    return {
        **unsigned,
        "environment": environment,
        "artifacts": processed_artifacts,
        "signature": signature,
        "metadata": receipt_metadata,
    }


def _artifact_path_within(cwd: str, artifact_path: str) -> str | None:
    root = os.path.realpath(os.path.abspath(cwd))
    candidate = os.path.realpath(os.path.abspath(os.path.join(root, artifact_path)))
    try:
        return candidate if os.path.commonpath((root, candidate)) == root else None
    except ValueError:
        return None


def verify_receipt(
    receipt: Any,
    public_key_or_secret: str | None = None,
    check_files_on_disk: bool = False,
    cwd: str | None = None,
) -> dict[str, Any]:
    envelope = validate_receipt_envelope(receipt)
    if not envelope["valid"]:
        return {
            "valid": False,
            "trusted": False,
            "merkleValid": False,
            "signatureChecked": False,
            "signatureValid": None,
            "artifactsValid": False,
            "errors": [
                f"Envelope {error['code']}"
                + ("" if error["path"] is None else f" at {error['path']}")
                + f": {error['message']}"
                for error in envelope["errors"]
            ],
            "warnings": [],
            "checkedArtifacts": 0,
            "receipt": None,
        }

    errors: list[str] = []
    warnings: list[str] = []
    cwd = cwd or os.getcwd()
    canonical_profile, merkle_profile = _profiles(receipt["version"])
    expected_raw_leaves = _receipt_leaves(
        receipt["task"],
        receipt["environment"],
        receipt["artifacts"],
        receipt["version"],
    )
    calculated_tree = MerkleTree(
        expected_raw_leaves, is_pre_hashed=True, profile=merkle_profile
    )
    calculated_leaves = calculated_tree.get_leaves()
    recorded_leaves = [leaf.lower() for leaf in receipt["merkle"]["leaves"]]
    leaves_valid = calculated_leaves == recorded_leaves
    calculated_root = calculated_tree.get_root()
    recorded_root = receipt["merkle"]["root"].lower()
    merkle_valid = leaves_valid and calculated_root == recorded_root
    if not leaves_valid:
        errors.append("Merkle leaf list does not match the receipt payload")
    if calculated_root != recorded_root:
        errors.append(
            f"Merkle root mismatch: recorded '{receipt['merkle']['root']}', "
            f"recalculated '{calculated_root}'"
        )

    artifacts_valid = True
    checked_artifacts = 0
    if check_files_on_disk:
        for artifact in receipt["artifacts"]:
            full_path = _artifact_path_within(cwd, artifact["path"])
            if full_path is None:
                artifacts_valid = False
                errors.append(
                    f"Artifact path escapes verification root: '{artifact['path']}'"
                )
                continue
            try:
                with open(full_path, "rb") as file:
                    actual_hash = hashlib.sha256(file.read()).hexdigest()
                checked_artifacts += 1
                if actual_hash != artifact["sha256"].lower():
                    artifacts_valid = False
                    errors.append(
                        f"Artifact tampered: '{artifact['path']}' (hash mismatch)"
                    )
            except OSError as error:
                artifacts_valid = False
                errors.append(
                    f"Artifact missing on disk: '{artifact['path']}' ({error})"
                )

    signature_checked = public_key_or_secret is not None
    signature_valid: bool | None = None
    if signature_checked:
        signature_valid = ProofSigner.verify_signature(
            _signing_payload(receipt, receipt["signature"]),
            receipt["signature"]["value"],
            public_key_or_secret,
            receipt["signature"]["algorithm"],
            canonical_profile,
        )
        if not signature_valid:
            errors.append(
                "Cryptographic signature verification failed with provided key"
            )
    else:
        warnings.append(
            "Signature was not cryptographically verified (no public key or secret provided)"
        )

    valid = not errors
    return {
        "valid": valid,
        "trusted": valid and signature_valid is True,
        "merkleValid": merkle_valid,
        "signatureChecked": signature_checked,
        "signatureValid": signature_valid,
        "artifactsValid": artifacts_valid,
        "errors": errors,
        "warnings": warnings,
        "checkedArtifacts": checked_artifacts,
        "receipt": receipt,
    }
