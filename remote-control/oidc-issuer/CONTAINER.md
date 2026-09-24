# Disabled issuer container integration

The Remote Node24 image includes issuer dependencies. The Railway configuration
and image default `NYMREL_REMOTE_OIDC_ISSUER_ENABLED=false`. Nothing changes issuer,
bridge, gateway or ChatGPT configuration when this packaging is deployed disabled.
The optional issuer shares Remote's public HTTP listener and process. Its failure
makes both `/healthz` and `/readyz` return 503; unrelated Remote routes retain their
existing authentication. There is no second externally exposed port.

## Offline preparation and activation gates

1. Validate the image, default-disabled Remote behavior and existing 148-test suite.
   Run the issuer suite separately and test the Linux container startup/shutdown.
2. Obtain a separate live grant for Google registration, secret installation and
   activation. This document is not authorization. No production values belong here.
3. Prepare a private directory `<writable-root>/oidc` owned by the runtime UID, mode
   0700. The database must be inside this exact directory. Provision the private
   JSON configuration as an owner-readable file (0600) outside the image/repository.
   Set `NYMREL_OIDC_CONFIG_FILE=<private runtime file>` only after custody review.
   Its `issuer` must exactly equal the Remote public HTTPS origin (no trailing slash),
   `databasePath` must name the dedicated persistent SQLite file, and `offline` must
   be absent/false. See README for the remaining client, key and identity fields.
4. Set `NYMREL_REMOTE_OIDC_ISSUER_ENABLED=true` only in a reviewed activation change.
   The checked-in Railway configuration deliberately pins false, so applying it
   disables the issuer; update that file explicitly as part of any later activation.
5. Railway TLS termination is the trusted public boundary. The listener overwrites
   issuer host/protocol forwarding headers with the configured HTTPS origin. Do not
   expose its HTTP port directly to untrusted networks or bypass TLS termination.
6. Complete the README's token concurrency, live callback/refresh, backup recovery,
   key rotation, verified-email (if needed), rate limiting and operational gates
   before calling this production-ready. Issuer routes do not yet have a dedicated
   rate limiter; the readiness query proves reads, not disk capacity or writes.

## Ownership, restart and rollback

One persistent SQLite file has one exclusive `.owner` marker. Both production
entrypoints acquire it before opening SQLite. No age/PID heuristic steals it.
Graceful server close closes SQLite before releasing the marker. Another process
or a stale crash marker blocks startup. Canonical parent paths and rejection of
database symlinks prevent ordinary path aliases from bypassing the marker.
The dedicated directory must remain private: hardlinks and hostile filesystem
mutation by another same-UID process are outside this marker's security boundary.

After an ungraceful crash, stop all old issuer containers/processes, verify no
writer remains, retain the SQLite/WAL/SHM files, and separately approve/review
removing only the stale owner marker before restarting. This intentionally trades
automatic crash recovery for exclusive ownership. Never restore an old token
database while serving traffic; spent tokens could be resurrected. Until a tested
recovery design exists, invalidate prior sessions after restore.

For rollback set the issuer enable flag false and restart. Preserve its database
and private keys for controlled recovery. Disable the plugin bridge and gateway
read adapter separately if they were later enabled. Existing access JWTs can remain
valid until expiry; revoke verifier subject mapping for immediate fail-closed
access. No live bridge or gateway flag is changed by this slice.

Limits: one process/replica, shared failure and key-access boundary with Remote,
manual crash-marker recovery, no automatic secret generation, no deployment or
provider registration. Existing standalone issuer command remains loopback-only.
