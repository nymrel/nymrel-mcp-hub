# Nymrel MCP Hub Cursor review contract

Review Nymrel Remote as a security-sensitive remote execution control plane, not as a generic web service.

Prioritize concrete, exploitable, or reliability-impacting findings in these areas:

- OAuth issuer, audience, tenant, scope, and protected-resource metadata binding.
- Device pairing, refresh, revocation, replay, and stale-token behavior.
- Exactly-once queued-to-executing call transitions, crash recovery, expiry, and duplicate completion.
- Approval replay, cross-principal reuse, changed arguments, and schema-hash changes.
- Allowed-root confinement, canonical Windows paths, symlink/reparse-point behavior, and writable ancestor resolution.
- Command classification, network scope, destructive actions, output bounds, and secret leakage.
- Persistent-volume, single-replica, key rotation, retention, backup, restore, rollback, and supervisor assumptions.
- Mismatch between tool annotations/descriptions and actual side effects.

Do not report style-only observations unless they hide a correctness or security defect. Distinguish source defects from deployment evidence that is merely missing. Never include live credentials, tokens, private file contents, or speculative secret values in review comments.
