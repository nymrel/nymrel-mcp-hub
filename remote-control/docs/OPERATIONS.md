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

### Recovering trust after issuer or hosting-provider compromise

Apply this procedure to the incident's identified or potentially exposed scope; a
provider disclosure alone does not prove that every credential or paired host was
compromised. Record unknown exposure explicitly. Preserve existing incident holds:
an MCP front-door pause and disconnected Local Bridge stay in place until the
recovery owner has verified the applicable gates below. This runbook does not
authorize account changes, credential rotation, deployment or reconnection.

1. Establish trusted administration independent of the suspect issuer. Do not
   reconnect Local Bridge through that issuer to investigate it. Inventory the
   actual projects, environments, services, integrations, historical secret
   bindings and consumers using authenticated provider reads. A failed inventory
   is an access blocker, not an empty inventory.
2. Verify containment of the actual backend and issuer, including direct origins,
   previews, existing device streams and queued/claimed work. An edge pause or
   one failing health URL proves only that tested path. If backend isolation is
   unavailable, use independently trusted host administration to contain verified
   local instances; disable their verified watchdog/scheduled restart paths before
   stopping them. Preserve evidence and inspect host integrity before re-pairing.
3. Classify the affected credentials before replacing them:

   | Credential class | Recovery boundary |
   | --- | --- |
   | OAuth issuer private signing keys | Replace at the issuer with new key IDs; remove compromised public keys from JWKS without a rollover overlap. |
   | Issuer cookie/session keys, refresh grants and OAuth client secrets | Invalidate affected sessions/grants and rotate affected client secrets at their issuers; update each consumer. Signing-key replacement alone does not revoke these. |
   | Remote internal signing and bootstrap credentials | Follow [server signing-key compromise](#server-signing-key-compromise) for `NYMREL_REMOTE_SIGNING_KEY`; separately replace any exposed bootstrap credential. These are not the OAuth issuer's signing keys. |
   | Provider, database and registry credentials | Revoke at the issuing provider and replace every affected consumer; removing a variable from the host is not issuer-side revocation. |
   | Remote data and audit keys | Follow the migration/preservation procedures below; do not overwrite keys and destroy recoverable state or claimed audit continuity. |

   The [issuer entrypoint](../oidc-issuer/README.md#entrypoint-configuration)
   accepts `NYMREL_OIDC_CONFIG_FILE` as a path to private configuration. Establish
   how that file was provisioned and stored before claiming that its contents
   were exposed; knowing the path alone does not establish access to the file.
4. Clear cached trust in every affected verifier instance after issuer recovery,
   normally by a controlled restart while containment remains in force. The
   [Remote verifier](../src/oauth.js) caches JWKS for five minutes, discovery
   metadata for ten minutes and positive introspection results for up to thirty
   seconds. JWTs are verified locally when an issuer is configured: revoking a
   token only at the issuer does not make a cached public signing key unusable.
   Waiting for a legitimate token's expiry is insufficient after private-key
   compromise, because an attacker can sign a different expiry.
5. From the trusted recovery route, prove rejection of old issuer signatures,
   affected refresh/session material, old internal/device tokens and revoked
   provider credentials as applicable. Exercise the recovered service's actual
   authorization boundary using a harmless read, keeping test credentials inside
   the approved secret-handling route. A front-door 503, DNS error, timeout or
   failed network connection is not evidence of credential rejection. Verify new
   credentials work only for the intended identity, audience and scope. Never
   paste tokens, keys, private configuration or raw credential-bearing responses
   into a receipt.
6. Review service/provider audit logs and billing over the incident window,
   pending/claimed calls and host integrity. Bind any required reviewed redeploy
   to the exact source, service and replacement configuration. Staged variables
   are not evidence that running consumers use replacements. Prevent backup
   restoration from rolling revocation state backward. Only then may the existing
   recovery owner clear the applicable holds and authorize normal traffic or
   re-pairing within their authority.

Keep a minimal receipt in the existing private incident record: source locator,
retrieval time and source-effective time, scoped non-secret resource identifiers,
credential class and issuer, revocation time, old-credential rejection result,
consumer/deployment revision, cache invalidation coverage, anomaly-review interval
and result, containment/host checks, and remaining unknowns. Redact customer-linked
identifiers when needed. Record checks as verified, failed or unavailable; provider
availability, a successful source test or an updated runbook is not recovery proof.

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
