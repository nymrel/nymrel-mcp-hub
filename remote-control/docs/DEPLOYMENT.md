# Deployment

## Supported topology

Deploy one Nymrel Remote server process behind a TLS reverse proxy/load balancer with a persistent volume mounted at `/data`. Do not run more than one active replica for this build.

```text
Internet -> TLS / remote.example.com -> one Nymrel Remote container -> /data/state.json
                                              ^
                                              |
                                      OAuth AS / JWKS

owned machines -> outbound HTTPS/SSE -> remote.example.com
```

## Container build

```bash
docker build -t nymrel-remote:0.1.0 .
docker run --rm -p 8787:8787 --env-file .env.production -v nymrel-remote-data:/data nymrel-remote:0.1.0
```

Do not put production secrets into an image layer or compose file committed to Git.

## TLS and proxy behavior

- public scheme must be HTTPS
- preserve request headers used by MCP routing
- disable proxy buffering for `/v1/device/events`
- allow long-lived outbound SSE connections
- do not rewrite `/mcp` POST bodies
- keep `/healthz` and `/readyz` available to the platform health checker
- restrict direct access to the container port to the reverse proxy/network plane

## OAuth

Configure a trusted external authorization server. Nymrel Remote supports:

- JWT access tokens verified from JWKS (RSA, ECDSA, EdDSA families supported by Node crypto)
- issuer discovery when a JWKS URI is not given explicitly
- opaque tokens through an RFC 7662-style introspection endpoint
- exact resource/audience binding
- scope extraction from `scope` or `scp`

The public resource is `<NYMREL_REMOTE_PUBLIC_URL>/mcp`. Configure the authorization server to issue tokens for that audience/resource.

## Persistent data and backup

Back up:

1. the state file (`NYMREL_REMOTE_STORE`)
2. the data-encryption key
3. the audit key
4. the signing key if static/device credentials must survive restoration

Take a consistent backup by stopping the single process or snapshotting the persistent volume atomically. Test restoration in a non-production environment before relying on it.

## Rollback

Application rollback is safe when the state format remains `version: 1`. Before a version that changes the state format, ship and test an explicit migration/rollback plan. Never roll back by restoring code while silently discarding a newer state file.

## Post-deploy smoke gate

A deployment is not accepted until all of these pass against the actual public URL:

1. `/healthz` returns 200.
2. `/readyz` returns 200 and audit verification is valid.
3. Protected Resource Metadata names the exact public `/mcp` resource and expected authorization server.
4. Unauthenticated `/mcp` returns 401 with a resource-metadata challenge.
5. A real OAuth token for the MCP resource can perform modern `tools/list` with required MCP routing headers.
6. A test device pairs and registers.
7. Exact schema relay is verified on a non-empty parameterized tool such as `edit_block`.
8. A read-only canary call completes end to end.
9. A write canary does not execute before approval and does execute after approval.
10. Device revocation causes the old device token to fail.
