# Existing @Nymrel app: restricted JalenPC reads

The existing personal ChatGPT `@Nymrel` app is bound to `https://mcp.nymrel.com/mcp`. The hosted server now advertises four public studio utilities and seven OAuth-scoped Remote read tools. In the existing ChatGPT connection, the seven tool schemas are visible after Refresh, but Information still reports `Authorization supported: None` and `Authorization used: None`. A regular conversation reached a "ChatGPT needs more Nymrel access" prompt; it has not completed OAuth or read a local file. The backend plugin route remains disabled in production until the provider and exact subject map are validated.

## Logical resource and boundary

The hosted Nymrel MCP server is the **one OAuth resource** presented to ChatGPT:

```text
resource / access-token audience: https://mcp.nymrel.com/mcp
public ChatGPT app endpoint:      https://mcp.nymrel.com/mcp
Remote backend endpoint:          https://nymrel-remote-production.up.railway.app/nymrel/plugin/readonly/mcp
required scopes:                  devices:read tools:read
```

The hosted server must validate the caller's token and forward only the seven fixed read tools, with the original bearer token, to the backend endpoint. Remote independently verifies signature, exact issuer and audience, expiry, both read scopes, and the exact OAuth subject-to-tenant mapping. It discards any broader token scopes. The backend uses the same read-only broker and native device allowed-root boundary as `/chatgpt/readonly/mcp`, but records calls with `nymrel-plugin-readonly` provenance. `get_read_result` cannot retrieve calls created through a different profile.

Do not forward a `mcp.nymrel.com` audience token to `/chatgpt/readonly/mcp`. That route deliberately requires its own exact Railway URL audience. The backend route is disabled unless `NYMREL_REMOTE_NYMREL_PLUGIN_READONLY_ENABLED=true`; enabling it without an authorization server fails startup. Static compatibility tokens are never accepted there. No shared gateway bearer, model-visible token argument, or caller-selected tenant is part of this design.

## Activation sequence

1. Keep the dedicated `JalenPC-ChatGPTStudio` agent paired to `chatgpt-studio-20260922` and its reviewed staged root. Do not pair the original whole-profile JalenPC device to this tenant.
2. Treat the current **existing** ChatGPT `@Nymrel` connection as an authentication-none registration unless its management page exposes a real OAuth client configuration. The original app submission declared authentication `none`; its current management panel still has no editable callback/client and still reports `Authorization supported: None` after Refresh. Refresh reloads MCP metadata but is not evidence that a previously authless connection acquired an OAuth client. Do not keep refreshing it as a migration strategy.
3. Use an explicit new ChatGPT connection for the OAuth rollout when the existing connection has no client configuration surface. Point it at `https://mcp.nymrel.com/mcp`; use the stable callback `https://chatgpt.com/connector_platform_oauth_redirect`, a predefined public client with token-endpoint authentication `none`, authorization-code + PKCE S256, the exact resource scopes `devices:read tools:read`, and OIDC disabled. Do not enable open DCR merely to preserve the old connection.
4. In Auth0, keep the plugin API audience exactly `https://mcp.nymrel.com/mcp` and grant that ChatGPT client only `devices:read` and `tools:read`. Strict third-party applications require a domain-level login connection; prefer a dedicated Nymrel operator database connection with public signup disabled rather than promoting the existing Google social connection tenant-wide. Keep the Resource Parameter Compatibility Profile enabled so ChatGPT's RFC 8707 `resource` parameter becomes the API audience. Enable API offline access only for the refresh-token acceptance test.
5. Complete one real authorization before changing Remote. Verify the access token privately: RS256 signature through the published JWKS, exact issuer `https://dev-klfweldye4egax5x.us.auth0.com/`, exact audience `https://mcp.nymrel.com/mcp`, both read scopes, expiry, and a stable nonempty application-user `sub`. Verify that the authorization request used PKCE S256. A refresh token is acceptable only when the live flow requested `offline_access` and a later refresh actually succeeds; provider configuration alone is not proof.
6. Only after that first login, set Remote `NYMREL_REMOTE_AUTHORIZATION_SERVERS=https://dev-klfweldye4egax5x.us.auth0.com/`, exact `NYMREL_REMOTE_OAUTH_ISSUER`, `NYMREL_REMOTE_OAUTH_SUBJECT_TENANTS` mapping only that observed `sub` to `chatgpt-studio-20260922`, and `NYMREL_REMOTE_NYMREL_PLUGIN_READONLY_ENABLED=true`. Keep the direct read-only profile's audience unchanged. Missing or mismatched issuer, subject map, or authorization server must remain a startup failure.
7. The hosted Nymrel adapter, exact plugin audience, per-tool OAuth security schemes, and `mcp/www_authenticate` challenges are deployed. Keep the four public studio tools anonymous and revalidate the live eleven-tool catalog plus protected-resource metadata after any provider change.
8. Perform the staged canary only after the backend is enabled: require exactly the isolated ChatGPTStudio device for the mapped tenant; read one pre-approved staged file and compare its expected SHA-256 without printing secrets; confirm a parent/credentials path is denied; exercise `nymrel_remote_get_read_result` for a pending read; then repeat an approved read after the original access token expires to prove refresh. Finally repeat the approved-read and denied-path checks from a new ordinary ChatGPT conversation. Do not claim regular ChatGPT local-file access before that conversation succeeds.

## Rollback

Set `NYMREL_REMOTE_NYMREL_PLUGIN_READONLY_ENABLED=false` and disable the hosted adapter. The backend route then disappears, while the original direct read-only resource and public Nymrel tools retain their prior contracts. Neither flag changes device pairing, allowed roots, or stored calls.

Local backend acceptance: `node --test test/chatgpt-readonly-http.test.js` covers disabled/default behavior, exact audience, static-token denial, mapped tenant isolation, frozen catalog, denied writes, and cross-profile pending-result isolation. These local tests do not prove the hosted adapter, live provider, ChatGPT sign-in, or production file read.
