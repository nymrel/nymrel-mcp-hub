# Regular ChatGPT Pro read-only profile

## Goal

Give ordinary ChatGPT conversations on the web a narrow Nymrel Remote surface for inspecting JalenPC files without depending on ChatGPT Work or Codex.

This profile is intentionally separate from the full public/plugin catalog. It is a compatibility profile for the current ChatGPT Pro custom-MCP capability and must not widen local permissions.

## Status

The profile is wired, tested, and deployed to `https://nymrel-remote-production.up.railway.app` as of 2026-09-22. Live probes returned `200` for `/healthz`, `/readyz`, and the read-only protected-resource metadata, and `401` for an unauthenticated MCP request. It is **not yet connected to ChatGPT or authorized to read local files**. Nymrel Remote contains no OAuth authorization server: it only verifies tokens from an external one. Until the operator provisions a provider (see [Provider requirements](#provider-requirements)) the read-only resource answers every request with `401`, by design.

## Tool surface

The profile exposes only:

- `list_devices`
- `read_file`
- `list_directory`
- `get_file_info`
- `search_files`
- `search_content`

The requested OAuth scopes are only `devices:read` and `tools:read`.

It does not expose writes, edits, shell/process execution, process output, process enumeration, or termination. Any other tool name returns a not-found JSON-RPC error before the broker is reached, so no call record or audit `call.created` event exists for it. The device agent's existing allowed-directory boundary remains authoritative.

## Resource wiring

| Item | Value |
| --- | --- |
| MCP endpoint | `POST https://<production-host>/chatgpt/readonly/mcp` |
| Protected-resource metadata | `GET https://<production-host>/.well-known/oauth-protected-resource/chatgpt/readonly/mcp` |
| Required token audience (`aud`) | exactly `https://<production-host>/chatgpt/readonly/mcp` |
| `scopes_supported` | exactly `devices:read`, `tools:read` |
| Static bearer tokens | never accepted, whatever `NYMREL_REMOTE_ALLOW_STATIC_MCP_TOKENS` says |

`src/chatgpt-readonly-profile.js` provides `ChatgptReadonlyMcpEdge` and the frozen catalog. `src/chatgpt-server.js` mounts it next to `/chatgpt/mcp` and reuses the existing encrypted durable-call broker, projected device schemas, device selector, and exactly-once execution path.

Properties enforced by the server and covered by `test/chatgpt-readonly-http.test.js`:

- The read-only audience is always the exact resource URL. There is deliberately no override variable. Startup fails if `NYMREL_REMOTE_OAUTH_AUDIENCE` or `NYMREL_REMOTE_CHATGPT_OAUTH_AUDIENCE` is set to the read-only URL, because a shared audience would let a token issued for one resource be replayed against the other.
- A token issued for `/mcp` or `/chatgpt/mcp` is rejected here, and a read-only token is rejected there.
- Only the two read scopes are honored on this resource. Broader scopes carried by a token, including `*` and `tools:*`, are dropped before the request reaches the broker.
- `/chatgpt/mcp` and `/mcp` keep their catalogs, metadata, and static-token compatibility behavior. `/chatgpt/mcp` remains the full directory-submission surface and must never be the URL given to a regular ChatGPT conversation.

## External subjects must be mapped to a tenant

Device access is decided by tenant. An external identity provider may allow self-signup or dynamic client registration, so a validly signed token proves nothing about which tenant its holder belongs to. Every public entry point that accepts external OAuth tokens therefore requires an explicit operator-configured mapping:

```text
NYMREL_REMOTE_OAUTH_SUBJECT_TENANTS={"<exact sub claim of the operator account>":"<tenant id JalenPC is paired under>"}
```

- This applies to `/chatgpt/readonly/mcp`, `/chatgpt/mcp`, `/mcp`, and the `/v1/*` operator API. Restricting only the read-only route would leave the other routes open to the same self-signed-up account.
- The value is a JSON object of at most 32 entries. Subjects are matched exactly (case-sensitive, no trimming) and only for the configured `NYMREL_REMOTE_OAUTH_ISSUER`.
- The tenant always comes from this mapping. A `tenant`/`tid` claim in the token is never trusted to select a tenant, so `NYMREL_REMOTE_OAUTH_TENANT_CLAIM` no longer influences authorization for external principals.
- A missing, empty, or unrecognized subject fails closed with `403 OAUTH_SUBJECT_DENIED`. It is never retried as a static token.
- With `NODE_ENV=production`, startup fails when `NYMREL_REMOTE_AUTHORIZATION_SERVERS` is set and the mapping is empty or malformed, or when `NYMREL_REMOTE_OAUTH_ISSUER` is not exactly one of the advertised authorization servers.
- Static compatibility tokens are unaffected: they keep the tenant they were minted with.

Issuer identifiers are compared exactly. Configure `https://issuer.example/` with its trailing slash if that is what the provider publishes in its metadata and `iss` claim.

## Provider requirements

These are operator/account inputs. None can be produced from this repository.

1. Authorization-server metadata discoverable from the issuer, whose `issuer` value equals the configured issuer exactly.
2. `authorization_endpoint`, `token_endpoint`, and `jwks_uri` (or RFC 7662 introspection, configured through `NYMREL_REMOTE_OAUTH_INTROSPECTION_URL`).
3. PKCE `S256`.
4. A client onboarding path ChatGPT can use: a client-ID metadata document, dynamic client registration, or a predefined client (probe flag `--predefined-client`).
5. `offline_access` / refresh tokens, otherwise the connection dies when the first access token expires.
6. Access tokens whose `aud` is exactly the read-only resource URL (RFC 8707 resource indicators, or an API identifier equal to that URL) and whose scope contains `devices:read tools:read`.
7. Signup restricted to the operator's account. The subject mapping is the enforcement; restricted signup is defense in depth.
8. A stable `sub` for the operator account, known before deployment, because it is the key of the mapping.

Revocation: JWT access tokens are verified offline and stay valid until `exp`, so use short access-token lifetimes. With introspection, a revoked token is refused once the server's 30-second introspection cache entry expires.

## Restricted local roots

**This is an explicit rollout item, not a solved problem.** The native device agent has no sensitive-path denylist: `NYMREL_REMOTE_ALLOWED_DIRECTORIES` is the only file boundary, and every file beneath it is readable and searchable through this profile.

JalenPC currently allows `C:\Users\johns`, the whole user profile. A profile root is where SSH keys, browser profiles, and application data normally live. A whole-profile root is not an acceptable root for a cloud-reachable resource, and nothing in this change makes it one. The Windows bootstrap supports a second `ChatGPTStudio` instance with its own device credential and restricted roots, so existing clients can retain their current device configuration.

Before ChatGPT is connected:

1. The operator chooses the narrowest project directories that regular ChatGPT actually needs.
2. Install the separate instance described in `docs/WINDOWS_BOOTSTRAP.md` with only those roots, and pair it under a dedicated tenant. Map the operator's OAuth subject to that tenant. Alternatively, narrow the existing JalenPC agent with `-AllowedDirectory` and restart it if every current client should lose access outside the chosen roots.
3. The operator confirms from ChatGPT that only the narrow device is listed and that `list_directory` on `C:\Users\johns` and on the credential directory is refused.

The allowed roots are per device, not per resource. Tenant isolation is what prevents the regular ChatGPT profile from discovering a different, broader device.

## Client onboarding

1. In ChatGPT.com, enable developer mode for connectors and add a custom MCP connector with the URL `https://<production-host>/chatgpt/readonly/mcp`. Do not use `/chatgpt/mcp`.
2. ChatGPT receives the `401` challenge, reads the protected-resource metadata, discovers the authorization server, and runs authorization-code + PKCE for `devices:read tools:read`.
3. The operator signs in with the mapped account and consents.
4. Prove `list_devices`, `search_content`, and `read_file` against JalenPC, then confirm the connection still works after the first access token has expired.

## Deployment

Production runs this profile, but has no authorization server configured. Deployment `d32760f9-aa83-44c6-8bc9-b36d1ac744f3` succeeded on 2026-09-22. The remaining steps below require an authorization provider, a narrow device pairing, and an operator identity decision.

1. Provision the provider and record the operator `sub`. Create a dedicated tenant for the read-only ChatGPT device; do not map that subject to the tenant containing the existing whole-profile JalenPC device.
2. Pair the separate `ChatGPTStudio` Windows instance with only the operator-selected roots under that tenant, as described above.
3. Set the service variables: `NYMREL_REMOTE_AUTHORIZATION_SERVERS`, `NYMREL_REMOTE_OAUTH_ISSUER`, `NYMREL_REMOTE_OAUTH_SUBJECT_TENANTS`, and either `NYMREL_REMOTE_OAUTH_JWKS_URL` (optional when discovery publishes `jwks_uri`) or the introspection variables. Leave `NYMREL_REMOTE_OAUTH_AUDIENCE` and `NYMREL_REMOTE_CHATGPT_OAUTH_AUDIENCE` at their own resource URLs.
4. Redeploy after the configuration changes. A rejected configuration stops the process at startup instead of serving with open tenancy.
5. Run the strict probe; it prints check names and pass/fail only:

   ```text
   node scripts/check-production-cutover.mjs https://<production-host> --profile=readonly
   ```

   `--profile=readonly` cannot be combined with `--allow-static-auth`. Add `--predefined-client` only when the provider has a client registered for ChatGPT in advance.
6. Onboard ChatGPT as above.
7. Only after OAuth is proven, and with separate approval, turn off `NYMREL_REMOTE_ALLOW_STATIC_MCP_TOKENS`, `NYMREL_REMOTE_ALLOW_STATIC_ADMIN_TOKENS`, and `NYMREL_REMOTE_ALLOW_BOOTSTRAP_HTTP`.

## Rollback

- To close the read-only resource without redeploying: unset `NYMREL_REMOTE_AUTHORIZATION_SERVERS` (the route then answers `401` to everything), or remove the subject from `NYMREL_REMOTE_OAUTH_SUBJECT_TENANTS` (`403`). In production the second option requires at least one remaining mapped subject, or unsetting the authorization servers as well.
- To roll back the code: redeploy the previous known-good service revision. The store format is unchanged by this work, so no data migration or re-pairing is involved.
- Static compatibility callers are untouched by either rollback, which is why step 7 above is last and separately approved.

## Release gates

Before describing this as available in regular ChatGPT:

1. ~~Wire the profile into an isolated resource path without changing the full plugin catalog.~~ Done locally.
2. Configure OAuth client onboarding, PKCE S256, refresh-token support, the exact read-only resource audience, and the subject-to-tenant mapping.
3. ~~Run focused HTTP tests proving the read-only catalog is frozen and mutation/execute tools return not-found rather than reaching the broker.~~ Done locally with a test issuer; this proves wiring, not ChatGPT connectivity.
4. Restrict the JalenPC allowed roots.
5. Deploy and run the strict production cutover probe with `--profile=readonly`.
6. Connect it from ChatGPT.com developer mode and prove `list_devices`, `search_content`, and `read_file` against JalenPC.

Mobile remains a separate distribution gate: do not claim iPhone support until the Nymrel app/plugin is available through a ChatGPT distribution path that supports mobile.
