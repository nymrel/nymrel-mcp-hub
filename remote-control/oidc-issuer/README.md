# Offline OIDC issuer acceptance slice

This isolated, private package evaluates a self-hosted issuer for the **existing**
Nymrel MCP resource, `https://mcp.nymrel.com/mcp`. It uses maintained
`oidc-provider` 9.12.2 for protocol handling. It does not start with Remote,
change its dependencies, expose a production executable, or configure any account.
The local acceptance server exists only inside the test suite.

## Run

Use Node 24, then in this directory:

```sh
npm ci --ignore-scripts
npm test
```

Tests bind only an ephemeral `127.0.0.1` port and use generated fixture keys,
invented identity/client values and a temporary SQLite database. They never
contact Google, Auth0, ChatGPT or production Remote. Test interaction routes
deliberately supply a fixture identity; **do not copy those routes into a service**.
Acceptance is named outside Node's automatic test discovery so the main Remote
suite does not unexpectedly acquire this optional package's dependency.

## Implemented boundary

- One predefined public client and one exact HTTPS callback supplied by the caller.
- Authorization code with required S256 PKCE; no DCR, CIMD or client credentials.
- GET authorization requests must name exactly one resource, the existing plugin
  URL. Unknown resource indicators and scopes are rejected. MCP JWT access tokens
  contain that single audience and only `devices:read tools:read`.
- OIDC `openid` and `offline_access`; only `sub` is released. `email` and `profile`
  are deliberately not advertised because this slice has no verified profile store.
- One explicitly allowed upstream issuer/subject maps to a stable internal subject.
  Remote must independently map that internal subject to the existing restricted
  `chatgpt-studio-20260922` tenant.
- Separate server-side login completion and consent approval helpers; no web route
  exposes them. Their caller must verify upstream authentication, bind the result
  to this interaction and perform CSRF checks before invoking them.
- Caller-provided private RS256 keys and cookie keys; no generated/default keys in
  the library. Persist these outside source control before any future deployment.
- SQLite storage for codes, sessions, grants and refresh tokens, with expiration,
  consumption, indexed lookups and grant-wide revocation. A single issuer process
  and local durable disk are required. This is not a multi-host storage adapter.
- Five-minute access tokens, one-minute codes and one-day refresh/session/grant
  lifetimes. Refresh rotation and reuse-family revocation are enabled.

The integration tests prove discovery, success/error redirect issuer identifiers,
code exchange, backend signature/audience verification, code replay rejection,
identity denial, client/callback/resource/scope/PKCE denial, persisted refresh after
issuer reconstruction, refresh rotation/reuse rejection and explicit revocation.
They separately exercise SQLite restart, indexes, consumption, expiry and grant
revocation. No live ChatGPT, Google or production acceptance is claimed.

## Required before deployment

1. Implement Google OIDC login using a maintained client, validating signature,
   issuer, audience, nonce and state. Allow only the approved Google subject. Bind
   it to the original interaction with an authenticated server-side session; do not
   accept identity assertions from request JSON or trust email alone. Add real
   consent views, CSRF checks and tests for cross-interaction substitution.
2. Copy the callback from the **existing Nymrel connector** management page. The
   callback used in tests is invented. OpenAI permits the stable
   `https://chatgpt.com/connector_platform_oauth_redirect` when discovery advertises
   issuer identification and every success/error redirect includes matching `iss`;
   otherwise use the connection-specific callback. Verify the real flow.
3. Test the actual ChatGPT scope and refresh request. This fixture requests
   `offline_access` with `prompt=consent`, as required by the provider's OIDC policy.
   A request omitting that consent prompt may not receive a refresh token. Do not
   declare refresh compatibility from this fixture alone or silently bypass consent.
4. For workspace domain restrictions, implement verified email claims and a working
   UserInfo endpoint, then advertise `email`. The current sub-only configuration
   does **not** support that optional enterprise capability. Test UserInfo token
   handling separately from the MCP resource token.
5. Protect the SQLite database, WAL files, backups and key store with host access
   controls; they contain live authorization material. Establish backups, restore
   tests, pruning, a process ownership lock, monitoring, rate limits, dependency
   updates, HTTPS/reverse-proxy settings and key rotation. Node's SQLite API/runtime
   compatibility and crash recovery need deployment-environment validation.
6. Test concurrent code/refresh replay and crash recovery under the chosen process
   model. This suite tests sequential reuse; do not run several issuer processes
   against this adapter. The provider performs read/consume as separate operations.
7. Publish matching protected-resource metadata at the existing gateway and configure
   both gateway and Remote to verify the exact new issuer, audience and mapped
   subject. Keep the four anonymous public tools working. Prove seven read tools,
   an allowed staged file, denied parent/credential roots, and refresh after expiry
   through an actual ChatGPT conversation. Retain a rollback that removes the issuer
   or subject mapping and disables the read bridge.

Revoking a refresh family prevents further refresh. Already-issued JWT access
tokens can remain valid for five minutes plus Remote's clock skew because Remote
verifies them locally. Immediate shutdown uses Remote's admission/issuer controls;
this slice does not pretend JWT revocation propagates through local verification.

Google OAuth registration, new issuer hosting/DNS, persistent production secrets,
and live cutover remain separate protected actions. The Auth0-only c170 grant does
not authorize them. No production settings or credentials are included here.

## Sources and choice

- [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth):
  discovery, predefined clients, S256, exact resource/callback/issuer and UserInfo.
- [oidc-provider](https://github.com/panva/node-oidc-provider) and its
  [configuration](https://github.com/panva/node-oidc-provider/blob/main/docs/README.md):
  OIDC/PKCE/resource indicators and production storage/interaction responsibilities.
- [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect).

The library avoids Auth0's domain-level connection promotion and supports the
resource-indicator protocol. It also transfers identity-service operations to us.
This slice is intentionally insufficient for unattended production deployment.
