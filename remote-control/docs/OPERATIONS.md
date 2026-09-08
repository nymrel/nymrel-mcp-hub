# Operations Runbook

## Health

- `GET /healthz`: process liveness
- `GET /readyz`: readable state + valid complete audit chain

Treat a failed audit verification as a readiness failure. Do not overwrite or auto-repair the ledger in place during an incident.

## Logs

Expected access-log fields are HTTP method, path, status, duration, and request ID. Task arguments, results, query strings, and bearer tokens must not be logged. Preserve request IDs when collecting proxy and application logs.

## Device incident

If one device is suspected compromised:

1. revoke the device from an authenticated operator session
2. stop its local Nymrel Remote agent
3. inspect the host independently
4. do not re-pair until host integrity is restored
5. verify the audit chain and review call metadata/hashes around the incident window

Revocation increments the device token generation, invalidating all device tokens from the old generation.

## Authorization incident

If an OAuth access token is compromised, revoke it at the authorization server and review issued scopes/audience. If the authorization server itself is compromised, block public MCP traffic at the edge until trust is restored.

## Server signing-key compromise

The internal signing key protects static compatibility/operator tokens and device tokens. If compromised:

1. stop public traffic
2. rotate `NYMREL_REMOTE_SIGNING_KEY`
3. restart the server
4. all existing device/static tokens become invalid; re-pair devices and reissue any deliberately used static operator tokens
5. investigate state and audit receipts before reopening traffic

## Data-key compromise

Rotate the data key only with an explicit state re-encryption migration. Replacing it in the environment without migrating existing envelopes makes pending call arguments, results, pairing recovery tokens, and MRTR request states unreadable.

For an emergency where confidentiality is already lost and pending work may be discarded, stop traffic, archive the compromised state for forensics, start a clean state with a new key set, and re-pair devices.

## Audit-key compromise

A new audit key cannot validate the old receipt chain. Preserve the old key under incident controls long enough to verify/export the historical chain, then start a new signed ledger epoch in a future migration rather than pretending continuity.

## Backup restore

Restore the state file and its matching key set together. Start with public traffic blocked, verify `/readyz`, inspect device status, then explicitly re-enable traffic. Re-pair/revoke devices if restoration rolled token generation backward.

## Maintenance

- review OAuth issuer/JWKS/introspection configuration after provider changes
- test device token refresh and revocation periodically
- verify backups by restoration drill
- keep Node on a supported security-maintained 22/24 line per project policy
- run the repository CI gate before every release candidate
