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
   key rotation, verified-email (if needed), ingress and operational gates before
   calling this production-ready. Issuer routes have process-wide request budgets.
   Automatic expiry cleanup deletes at most 1,000 rows on startup and every 30
   seconds. A cleanup failure makes issuer health and container readiness fail
   until restart; between cleanup runs readiness probes storage reads. Neither
   check establishes free disk capacity. Monitor volume/WAL usage; deleted pages
   can be reused but the SQLite file does not automatically shrink.

## Ownership, restart and rollback

One persistent SQLite file has one dedicated `.owner.sqlite` ownership database.
Both production entrypoints hold an exclusive transaction in that database before
opening token storage. SQLite's OS file lock rejects a second live owner and is
released automatically when the process dies. No age/PID heuristic steals it.
Graceful server close closes token storage before releasing the ownership lock.
Canonical parent paths and rejection of database symlinks prevent ordinary path
aliases from bypassing ownership. Never unlink the ownership database while running.
The dedicated directory must remain private: hardlinks and hostile filesystem
mutation by another same-UID process are outside this lock's security boundary.

After an ungraceful crash, restart with the same persistent SQLite/WAL/SHM files
and the same private keys. SQLite recovers its journals and the next process can
acquire ownership only when the former OS lock is gone. A contending live process
fails startup immediately; the platform restart policy must retry after teardown.
Offline tests exercise a real second process and forced termination/reacquisition.
Linux/container volume restart proof remains an activation gate. Never restore an old token
database while serving traffic; spent tokens could be resurrected. Until a tested
recovery design exists, invalidate prior sessions after restore.

For rollback set the issuer enable flag false and restart. Preserve its database
and private keys for controlled recovery. Disable the plugin bridge and gateway
read adapter separately if they were later enabled. Existing access JWTs can remain
valid until expiry; revoke verifier subject mapping for immediate fail-closed
access. No live bridge or gateway flag is changed by this slice.

Limits: one process/replica, local filesystem SQLite locks (no network shares),
shared failure and key-access boundary with Remote, no automatic secret generation, no deployment or
provider registration. Existing standalone issuer command remains loopback-only.
