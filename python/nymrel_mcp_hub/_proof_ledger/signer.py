"""HMAC-SHA256 and audited-library Ed25519 signing primitives."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from datetime import UTC, datetime
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from .canonical import CanonicalizationProfile, canonicalize

HEX_32_BYTES = re.compile(r"^[0-9a-fA-F]{64}$")
HMAC_SIGNATURE = re.compile(r"^[0-9a-fA-F]{64}$")
ED25519_SIGNATURE = re.compile(r"^[0-9a-fA-F]{128}$")


def _raw_key(material: str, label: str) -> bytes:
    if not isinstance(material, str) or HEX_32_BYTES.fullmatch(material) is None:
        raise ValueError(
            f"{label} must be exactly 32 bytes encoded as 64 hexadecimal characters"
        )
    return bytes.fromhex(material)


class ProofSigner:
    @staticmethod
    def generate_secret_key() -> str:
        return secrets.token_hex(32)

    @staticmethod
    def generate_key_pair() -> dict[str, str]:
        private_key = Ed25519PrivateKey.generate()
        public_key = private_key.public_key()
        return {
            "privateKey": private_key.private_bytes(
                serialization.Encoding.Raw,
                serialization.PrivateFormat.Raw,
                serialization.NoEncryption(),
            ).hex(),
            "publicKey": public_key.public_bytes(
                serialization.Encoding.Raw,
                serialization.PublicFormat.Raw,
            ).hex(),
            "algorithm": "Ed25519",
            "encoding": "raw-hex",
        }

    @staticmethod
    def sign_payload(
        payload: Any,
        private_key_or_secret: str,
        algorithm: str = "HMAC-SHA256",
        canonicalization_profile: CanonicalizationProfile = "rfc8785",
    ) -> str:
        if not isinstance(private_key_or_secret, str) or not private_key_or_secret:
            raise ValueError('Signing key must be a non-empty string')
        canonicalize(private_key_or_secret)
        canonical = (
            payload
            if isinstance(payload, str)
            else canonicalize(payload, canonicalization_profile)
        )
        message = canonical.encode("utf-8")
        if algorithm == "HMAC-SHA256":
            return hmac.new(
                private_key_or_secret.encode("utf-8"), message, hashlib.sha256
            ).hexdigest()
        if algorithm == "Ed25519":
            private_key = Ed25519PrivateKey.from_private_bytes(
                _raw_key(private_key_or_secret, "Ed25519 private key")
            )
            return private_key.sign(message).hex()
        raise ValueError(f"Unsupported signature algorithm: {algorithm}")

    @staticmethod
    def verify_signature(
        payload: Any,
        signature_hex: str,
        public_key_or_secret: str,
        algorithm: str = "HMAC-SHA256",
        canonicalization_profile: CanonicalizationProfile = "rfc8785",
    ) -> bool:
        try:
            if not isinstance(public_key_or_secret, str) or not public_key_or_secret:
                return False
            canonicalize(public_key_or_secret)
            canonical = (
                payload
                if isinstance(payload, str)
                else canonicalize(payload, canonicalization_profile)
            )
            message = canonical.encode("utf-8")
            if algorithm == "HMAC-SHA256":
                if HMAC_SIGNATURE.fullmatch(signature_hex) is None:
                    return False
                expected = hmac.new(
                    public_key_or_secret.encode("utf-8"), message, hashlib.sha256
                ).hexdigest()
                return hmac.compare_digest(signature_hex.lower(), expected)
            if algorithm == "Ed25519":
                if ED25519_SIGNATURE.fullmatch(signature_hex) is None:
                    return False
                public_key = Ed25519PublicKey.from_public_bytes(
                    _raw_key(public_key_or_secret, "Ed25519 public key")
                )
                public_key.verify(bytes.fromhex(signature_hex), message)
                return True
            return False
        except (InvalidSignature, TypeError, ValueError):
            return False

    @staticmethod
    def create_signature_record(
        payload: Any,
        private_key_or_secret: str,
        signer_identity: str,
        key_id: str,
        algorithm: str = "HMAC-SHA256",
        canonicalization_profile: CanonicalizationProfile = "rfc8785",
    ) -> dict[str, str]:
        return {
            "algorithm": algorithm,
            "keyId": key_id,
            "signerIdentity": signer_identity,
            "value": ProofSigner.sign_payload(
                payload,
                private_key_or_secret,
                algorithm,
                canonicalization_profile,
            ),
            "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        }
