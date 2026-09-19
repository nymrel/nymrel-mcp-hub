"""Thin MCP adapters over the pinned canonical Protocol v2 implementation."""

import json
import math
import re
from typing import Any

from ._proof_ledger.canonical import canonicalize
from ._proof_ledger.receipt import create_receipt, verify_receipt


def _non_blank_text(value):
    return isinstance(value, str) and bool(re.search(r'[^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]', value))


def _validate_input(value):
    pending = [(value, 0)]
    count = 0
    while pending:
        item, depth = pending.pop()
        count += 1
        if count > 10000 or depth > 64:
            raise ValueError('Input limit')
        if isinstance(item, (int, float)) and not isinstance(item, bool):
            if not math.isfinite(item) or abs(item) > 9007199254740991:
                raise ValueError('Nonportable number')
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
    if len(canonicalize(value).encode('utf-8')) > 1048576:
        raise ValueError('Input size limit')


def _text(value: Any, error: bool = False) -> dict[str, Any]:
    result = {"content": [{"type": "text", "text": json.dumps(value, indent=2, allow_nan=False)}]}
    if error:
        result["isError"] = True
    return result


def proof_ledger(args: Any) -> dict[str, Any]:
    try:
        _validate_input(args)
        if not isinstance(args, dict) or set(args) - {
            "action", "agentId", "payload", "signingKey", "algorithm", "keyId", "prevProofHash"
        }:
            raise ValueError()
        for key in ("action", "agentId", "signingKey"):
            if not _non_blank_text(args.get(key)):
                raise ValueError()
        if not isinstance(args.get("payload"), dict):
            raise ValueError()
        if "keyId" in args and not _non_blank_text(args['keyId']):
            raise ValueError()
        if "prevProofHash" in args and (
            not isinstance(args["prevProofHash"], str)
            or re.fullmatch(r"[0-9a-fA-F]{64}", args["prevProofHash"]) is None
        ):
            raise ValueError()
        algorithm = args.get("algorithm")
        if algorithm not in ("HMAC-SHA256", "Ed25519"):
            raise ValueError()
        if algorithm == 'Ed25519' and re.fullmatch(r'[0-9a-fA-F]{64}', args['signingKey']) is None:
            raise ValueError()
        metadata = {"payload": args["payload"]}
        if "prevProofHash" in args:
            metadata["prevProofHash"] = args["prevProofHash"]
        receipt = create_receipt(
            task={"name": args["action"], "runner": args["agentId"], "status": "ATTESTED"},
            signing_key=args["signingKey"], signer_identity=args["agentId"],
            algorithm=algorithm, key_id=args.get("keyId"), metadata=metadata, include_git_context=False,
        )
        _validate_input({'receipt': receipt, 'publicKeyOrSecret': args['signingKey'], 'expectedAlgorithm': algorithm})
        return _text(receipt)
    except Exception:
        return _text({"error": "INVALID_PROOF_INPUT: Supply action, agentId, JSON object payload and a valid signingKey; only HMAC-SHA256 and Ed25519 are supported."}, True)


def proof_verify(args: Any) -> dict[str, Any]:
    try:
        _validate_input(args)
        if not isinstance(args, dict) or set(args) - {"receipt", "publicKeyOrSecret", "expectedAlgorithm"}:
            raise ValueError()
        if ('publicKeyOrSecret' in args) != ('expectedAlgorithm' in args):
            raise ValueError()
        if "publicKeyOrSecret" in args and not _non_blank_text(args['publicKeyOrSecret']):
            raise ValueError()
        receipt = args.get("receipt")
        if not isinstance(receipt, dict) or receipt.get("version") != "2.0.0":
            raise ValueError()
        fields = [receipt.get('timestamp')]
        if isinstance(receipt.get('signature'), dict):
            fields.append(receipt['signature'].get('timestamp'))
        if isinstance(receipt.get('merkle'), dict):
            fields.append(receipt['merkle'].get('root'))
            if isinstance(receipt['merkle'].get('leaves'), list):
                fields.extend(receipt['merkle']['leaves'])
        if isinstance(receipt.get('artifacts'), list):
            fields.extend(item.get('sha256') for item in receipt['artifacts'] if isinstance(item, dict))
        if any(isinstance(value, str) and ('\r' in value or '\n' in value) for value in fields):
            raise ValueError()
        signature = receipt.get("signature")
        if not isinstance(signature, dict):
            raise ValueError()
        if 'expectedAlgorithm' in args and (
            args['expectedAlgorithm'] != signature.get('algorithm')
            or args['expectedAlgorithm'] not in ('HMAC-SHA256', 'Ed25519')
        ):
            raise ValueError()
        if args.get('expectedAlgorithm') == 'Ed25519' and re.fullmatch(r'[0-9a-fA-F]{64}', args['publicKeyOrSecret']) is None:
            raise ValueError()
        length = {"HMAC-SHA256": 64, "Ed25519": 128}.get(signature.get("algorithm"), 0)
        value = signature.get("value")
        if not length or not isinstance(value, str) or re.fullmatch(rf"[0-9a-fA-F]{{{length}}}", value) is None:
            raise ValueError()
        result = verify_receipt(receipt, public_key_or_secret=args.get("publicKeyOrSecret"), expected_algorithm=args.get('expectedAlgorithm'))
        if result['valid'] and any(set(record) - set(allowed) for record, allowed in [
            (receipt, ['protocol', 'version', 'proofId', 'timestamp', 'parentOrganization', 'task', 'environment', 'artifacts', 'merkle', 'signature', 'metadata']),
            (receipt['signature'], ['algorithm', 'keyId', 'signerIdentity', 'value', 'timestamp']),
            (receipt['merkle'], ['algorithm', 'leaves', 'root']),
        ]):
            result['warnings'].append('Unknown top-level, signature, or Merkle extension fields are not authenticated; do not use them as trusted claims.')
    except Exception:
        result = {
            "valid": False, "trusted": False, "merkleValid": False, "signatureChecked": False,
            "signatureValid": None, "artifactsValid": False, "checkedArtifacts": 0, "receipt": None,
            "errors": ["INVALID_PROOF_INPUT: A complete Protocol v2 receipt with a correctly encoded signature and optional non-empty publicKeyOrSecret is required."],
            "warnings": [],
        }
    result["verified"] = result["trusted"]
    result["verificationVerdict"] = (
        "INVALID" if not result["valid"] else
        "SIGNATURE_AUTHENTICATED" if result["trusted"] else "INTEGRITY_ONLY"
    )
    response = _text(result, not result["valid"])
    response.setdefault("isError", False)
    return response
