"""RFC 6962 Merkle tree with an explicit protocol-v1 compatibility profile."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Literal

LEAF_PREFIX = b"\x00"
NODE_PREFIX = b"\x01"
HEX_64_REGEX = re.compile(r"^[0-9a-fA-F]{64}$")
MerkleProfile = Literal["rfc6962", "legacy-duplicated"]


def _require_hash(value: str, label: str) -> None:
    if not isinstance(value, str) or HEX_64_REGEX.fullmatch(value) is None:
        raise ValueError(f"{label} must be a 64-character hexadecimal SHA-256 digest")


def hash_leaf(data: str | bytes, is_hex: bool = False) -> str:
    if is_hex:
        if not isinstance(data, str) or HEX_64_REGEX.fullmatch(data) is None:
            raise ValueError(
                "Pre-hashed leaf must be a 64-character hexadecimal SHA-256 digest"
            )
        payload = bytes.fromhex(data)
    else:
        payload = data.encode("utf-8") if isinstance(data, str) else bytes(data)
    return hashlib.sha256(LEAF_PREFIX + payload).hexdigest()


def hash_nodes(left_hex: str, right_hex: str) -> str:
    _require_hash(left_hex, "Left child hash")
    _require_hash(right_hex, "Right child hash")
    return hashlib.sha256(
        NODE_PREFIX + bytes.fromhex(left_hex) + bytes.fromhex(right_hex)
    ).hexdigest()


@dataclass(frozen=True)
class MerkleProofStep:
    position: Literal["left", "right"]
    hash: str

    def to_dict(self) -> dict[str, str]:
        return {"position": self.position, "hash": self.hash}


class MerkleTree:
    def __init__(
        self,
        items: list[str | bytes] | None = None,
        is_pre_hashed: bool = False,
        profile: MerkleProfile = "rfc6962",
    ) -> None:
        self.profile = profile
        self.leaves = [hash_leaf(item, is_hex=is_pre_hashed) for item in (items or [])]
        if self.leaves:
            self.layers = self._build_layers(self.leaves)
        else:
            empty = LEAF_PREFIX if profile == "legacy-duplicated" else b""
            self.layers = [[hashlib.sha256(empty).hexdigest()]]

    def _build_layers(self, leaves: list[str]) -> list[list[str]]:
        layers = [list(leaves)]
        current = list(leaves)
        while len(current) > 1:
            next_level: list[str] = []
            for index in range(0, len(current), 2):
                left = current[index]
                if index + 1 < len(current):
                    next_level.append(hash_nodes(left, current[index + 1]))
                elif self.profile == "legacy-duplicated":
                    next_level.append(hash_nodes(left, left))
                else:
                    next_level.append(left)
            layers.append(next_level)
            current = next_level
        return layers

    def get_root(self) -> str:
        return self.layers[-1][0]

    def get_leaves(self) -> list[str]:
        return list(self.leaves)

    def get_layers(self) -> list[list[str]]:
        return [list(layer) for layer in self.layers]

    def get_proof(self, index: int) -> list[dict[str, str]]:
        if (
            not isinstance(index, int)
            or isinstance(index, bool)
            or index < 0
            or index >= len(self.leaves)
        ):
            raise IndexError(
                f"Leaf index {index} out of bounds (0..{len(self.leaves) - 1})"
            )
        proof: list[dict[str, str]] = []
        current_index = index
        for layer in self.layers[:-1]:
            is_right = current_index % 2 == 1
            sibling_index = current_index - 1 if is_right else current_index + 1
            if sibling_index < len(layer):
                proof.append(
                    {
                        "position": "left" if is_right else "right",
                        "hash": layer[sibling_index],
                    }
                )
            elif self.profile == "legacy-duplicated":
                proof.append({"position": "right", "hash": layer[current_index]})
            current_index //= 2
        return proof

    @staticmethod
    def verify_proof(
        leaf_hash: str, proof: list[dict[str, str] | MerkleProofStep], expected_root: str
    ) -> bool:
        """Check a supplied hash path, not leaf data, index, size or root provenance."""
        try:
            _require_hash(leaf_hash, "Leaf hash")
            _require_hash(expected_root, "Expected root")
            current = leaf_hash.lower()
            for step in proof:
                if isinstance(step, MerkleProofStep):
                    step = step.to_dict()
                position = step.get("position")
                step_hash = step.get("hash")
                if position not in ("left", "right"):
                    return False
                _require_hash(step_hash, "Proof step hash")
                current = (
                    hash_nodes(step_hash, current)
                    if position == "left"
                    else hash_nodes(current, step_hash)
                )
            return current == expected_root.lower()
        except (TypeError, ValueError, AttributeError):
            return False

    def verify(self, leaf_hash: str, proof: list[dict[str, str] | MerkleProofStep]) -> bool:
        return self.verify_proof(leaf_hash, proof, self.get_root())

    def to_dict(self) -> dict[str, object]:
        return {
            "root": self.get_root(),
            "leafCount": len(self.leaves),
            "leaves": self.get_leaves(),
            "depth": len(self.layers),
            "profile": self.profile,
        }
