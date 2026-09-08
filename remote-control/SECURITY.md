# Security Policy — Nymrel Remote

Nymrel Remote can cause real file and process changes on paired computers. Treat the hosted MCP account, authorization server, server cryptographic keys, operator credentials, and each device credential as privileged control-plane credentials.

## Security boundary

The control plane enforces identity, tenant isolation, capability scopes, approval policy, durable call state, payload encryption, schema integrity, and tamper-evident receipts. The local MCP server still executes with the operating-system privileges of the account running the device agent.

**Policy checks are not an operating-system sandbox.** For untrusted or high-risk workloads, run the local MCP server/device agent inside a separate OS account, VM, container, or sandbox with a deliberately narrow filesystem and network view.

## Production requirements

- Terminate public traffic with TLS; never expose a non-local production server over plain HTTP.
- Use an external OAuth authorization server and audience-bound access tokens for the public MCP endpoint.
- Keep static MCP/admin token compatibility and the HTTP bootstrap mint endpoint disabled unless there is a documented operational reason.
- Keep signing, data-encryption, audit, bootstrap, and OAuth client credentials out of Git, logs, tickets, and chat transcripts.
- Use independent random keys for signing, data encryption, and audit HMAC.
- Back up the encrypted state file and the matching cryptographic keys separately. A state file without its data/audit keys is not a usable recovery.
- Run one active server replica for this implementation.
- Run device agents only on machines/accounts the operator is authorized to control.

## Data handling

Remote call arguments and successful results are encrypted at rest using AES-256-GCM. Audit receipts contain hashes and operational metadata rather than call bodies. HTTP access logs contain method, path, response status, duration, and request ID only. Device-agent logs do not print tool arguments/results.

The plaintext of a call necessarily exists transiently inside the authenticated server process during routing and inside the local device process during execution.

## Revocation

Revoking a device increments its token generation and marks it revoked. Existing device tokens then fail validation. A re-pair requires a new operator-approved device flow.

For suspected server-key compromise, follow the key rotation and incident procedure in `docs/OPERATIONS.md`; simply revoking devices is not sufficient if the signing key itself is compromised.

## Vulnerability handling

Do not include secrets, live device tokens, private file contents, or exploitable customer data in a public issue. Use the organization’s private security-reporting channel for vulnerabilities that could cross tenant, authentication, cryptographic, or remote-execution boundaries.
