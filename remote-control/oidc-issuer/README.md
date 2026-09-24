# OIDC issuer and Google interaction acceptance slice

This isolated, private package evaluates a self-hosted issuer for the **existing**
Nymrel MCP resource, `https://mcp.nymrel.com/mcp`. It uses maintained
`oidc-provider` 9.12.2 for protocol handling. It does not start with Remote,
change its dependencies, or configure any account. The prerequisite protocol and
storage slice came from PR #52. This follow-up adds an HTTP entrypoint and Google
interaction layer, with mocked upstream acceptance. It remains undeployed and
requires the operational and live acceptance gates below.

## Run

Use Node 24, then in this directory:

```sh
npm ci --ignore-scripts
npm test
```

Tests bind only an ephemeral `127.0.0.1` port and use generated fixture keys,
invented identity/client values and a temporary SQLite database. They never
contact Google, Auth0, ChatGPT or production Remote. The protocol-only fixture in
`checks/acceptance.mjs` directly supplies identity; **do not copy its routes into a
service**. The HTTP suite uses the real handlers and mocked Google discovery,
token endpoint and JWKS, verifying signed ID tokens and upstream PKCE.
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
- Google login uses maintained `openid-client` 6.8.8 with signature verification
  explicitly enabled, exact Google issuer and client audience, nonce, state and
  S256 PKCE. Only the configured Google subject can finish login. HTTP forms never
  accept a subject, account ID or identity assertion.
- Login start and consent are same-origin POST forms with one-use CSRF values in
  server-side SQLite bindings. Google callback state is bound to the browser cookie
  and provider interaction. Atomic, stage-specific binding consumption prevents
  concurrent completion of the same HTTP interaction step. Altered cookies and
  cross-browser/interaction substitutions are denied.
- The stable upstream callback is `<issuer>/google/callback`. After verification,
  the browser returns to the original interaction path, where the provider's signed
  interaction cookie must match before login completes. Consent is a separate
  authenticated action. Binding cookies are HttpOnly, SameSite=Lax and Secure with
  a `__Host-` prefix outside offline fixtures. A browser supports one active binding;
  starting another interaction invalidates its preceding binding.
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
revocation. Authorization denial cases require their exact protocol status/error;
valid-client PKCE errors must redirect with matching state and issuer. Every
observed authorization callback is checked for RFC9207 issuer identification.
Regression checks show that an injected HTTP 500 and an error redirect missing
`iss` cannot pass these assertions. No live ChatGPT, Google or production acceptance
is claimed. The HTTP suite additionally proves a complete mocked Google login and
explicit consent through downstream code exchange, and rejects wrong Google state,
nonce, signature, audience, issuer, expiry and subject, plus CSRF/origin failure,
identity injection, altered cookies, callback replay and interaction substitution.

## Entrypoint configuration

`node bin/server.mjs` requires `NYMREL_OIDC_CONFIG_FILE` naming a private JSON file.
Its fields are the `createIssuer` configuration (`issuer`, `clientId`, `callback`,
`identity` with Google `issuer`, allowed `subject` and stable internal `accountId`,
private `jwks`, `cookieKeys`, and `databasePath`) plus `google.clientId`,
`google.clientSecret`, and optional `trustProxy`. No credentials or safe defaults
are supplied. The entrypoint rejects offline mode and requires an HTTPS issuer
origin with no trailing slash/path. The Google redirect registered upstream must
be exactly `<issuer>/google/callback`; it is distinct from ChatGPT's callback.

It listens only on `127.0.0.1` (`PORT`, default 3100). A locally trusted TLS proxy
is required. If `trustProxy` is enabled, that proxy must replace forwarding headers
and prevent untrusted direct ingress. Do not deploy behind an unreviewed proxy or
change binding to a public interface without reviewing this trust boundary.
Request/header timeouts are set; broader capacity limits and operational
monitoring remain required. The HTTP factory's custom Google transport is accepted
only in offline mode, for tests.

### HTTP abuse bounds

Every HTTP factory instance has three process-wide token buckets: 60 authorization,
interaction and other requests; 20 Google callback requests; and 60 token/revocation
requests. Each bucket starts full and replenishes its capacity over 60 seconds,
with no accumulated credit beyond one burst. All methods and failed attempts count.
Only exact GET discovery and JWKS routes are exempt. Admission happens before
provider dispatch, body parsing, binding access/consumption or upstream Google calls.
Exhaustion returns HTTP 429, a whole-second `Retry-After`, `Cache-Control: no-store`,
and a JSON `temporarily_unavailable` error. A retry still needs valid, unexpired
OAuth/CSRF material; throttling does not extend its lifetime.

These budgets are deliberately shared for this single-operator issuer. Cookies,
interaction IDs, claimed IPs and proxy headers cannot create fresh buckets, and
limiter memory is constant. A caller can exhaust a shared budget and temporarily
delay legitimate users; upstream ingress controls and monitoring are still needed.
Limits reset on process restart and do not coordinate across processes or hosts.
Keep one issuer instance; review limits and deployment ingress behavior before
activation. The optional test clock is accepted only in offline mode.

Offline tests prove burst and gradual refill bounds, independent budgets, concurrent
callback abuse, resistance to changing cookies/forwarding headers, and recovery.
A throttled valid Google callback makes no upstream request and keeps its pending
login; a throttled valid token exchange leaves its code usable after retry. The
mocked full login/consent/token flow continues to pass with the limiter enabled.

## Required before deployment

1. Register and validate the actual Google client under a separate approved action.
   Verify the allowlisted subject through that client and retain its stable internal
   mapping. Test Google error/cancel handling and cookie behavior in real browsers.
   Mocked cryptographic verification does not establish live Google compatibility.
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
   tests, pruning, a process ownership lock, monitoring, ingress rate controls, dependency
   updates, HTTPS/reverse-proxy settings and key rotation. Node's SQLite API/runtime
   compatibility and crash recovery need deployment-environment validation.
6. Test concurrent code/refresh replay and crash recovery under the chosen process
   model. This suite tests sequential reuse; do not run several issuer processes
   against this adapter. The provider performs read/consume as separate operations.
   Additional protocol acceptance still required: wrong client/callback at token
   exchange, refresh scope/resource escalation and actual downstream token expiration.
   (The HTTP tests now cover altered binding cookies and interaction substitution.)
   Current tests must not
   be represented as covering those cases.
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
This slice remains insufficient for unattended production deployment.
