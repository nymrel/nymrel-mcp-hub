# CLI transport boundary

The CLI sends operator-selected candidate/evidence JSON and bearer credentials to
`NYMREL_WORKSPACE_URL`. Treat that environment variable as trusted operator
configuration. Files submitted to the gateway must never choose the request
origin. This is not protection against a compromised operator configuration.

Use an HTTPS origin with no user information, path prefix, query, or fragment:

```text
NYMREL_WORKSPACE_URL=https://your-approved-gateway.example
```

For local development only, HTTP requires both an exact literal-loopback origin
(`127.0.0.1` or `[::1]`) and `NYMREL_WORKSPACE_ALLOW_LOOPBACK_HTTP=1`. This exception
does not allow `localhost`, alternative IP spellings, LAN addresses, or remote
HTTP. Do not enable it for production or use production credentials in local
fixtures. Existing HTTP-based development scripts need the explicit opt-in.

The CLI rejects all redirects before following them, including same-origin
redirects. Configure the final origin directly rather than relying on redirects.
Each request has a 15-second deadline, including consumption of its response body.
There is no automatic retry. A timeout or transport error can occur after a
mutation was accepted: inspect gateway state and audit evidence before another
attempt. Do not interpret a timeout as a rollback. Multi-request bootstrap remains
non-atomic; an import can succeed before its node-report request fails.

No lease, fencing, idempotency-key, server authorization, OAuth, or credential
configuration changes are included. Candidate/evidence uploads remain intentional
network transfers. This change does not by itself establish that the CodeQL
file-data-in-outbound-request alert has been resolved; rerun it and review its
source-to-sink trace without suppressing the finding or weakening the gate.

Focused transport tests:

```bash
node --test workspace-gateway/test/cli-transport.test.js
```

The complete Gateway check still requires its declared Node 24+ runtime:

```bash
cd workspace-gateway
npm run check
```

Run all repository-required validation and independent review before merging or
releasing. Passing this focused test file is not full-repository release evidence.
