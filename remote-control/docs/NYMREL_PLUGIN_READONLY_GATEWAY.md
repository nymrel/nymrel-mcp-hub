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
2. First resolve OAuth configuration on the **existing** ChatGPT connection. Its current management panel shows no editable callback or client and retains `None` after Refresh. A separate new-app form offers the stable callback `https://chatgpt.com/connector_platform_oauth_redirect` for this URL and allows OIDC to be turned off; that does not prove the existing connection uses it. Configure a legitimate third-party provider client for authorization code + PKCE S256, refresh, and an access token whose `aud` is exactly `https://mcp.nymrel.com/mcp`. An Auth0 API with that plugin audience and only `devices:read tools:read` now exists. Auth0's strict third-party restrictions and Google-connection domain-level requirement must be resolved without widening access outside the grant. Provider/client creation, user signup, and production identity settings follow the studio's protected-action grants.
3. Set Remote's existing `NYMREL_REMOTE_AUTHORIZATION_SERVERS`, exact `NYMREL_REMOTE_OAUTH_ISSUER`, and `NYMREL_REMOTE_OAUTH_SUBJECT_TENANTS` so the operator's actual application-user `sub` maps only to `chatgpt-studio-20260922`. Enable the backend flag after validating the provider. Keep the direct read-only profile's audience unchanged.
4. The hosted `@Nymrel` adapter, exact plugin audience, and per-tool OAuth challenges are deployed. Keep the four public studio tools anonymous; revalidate the hosted metadata after any provider change.
5. Refresh the **existing** ChatGPT Nymrel app after its OAuth client is usable, then test from a new ordinary conversation: discover the narrow device; read the staged index; search; retrieve a pending result; deny an outside path; and verify the public utilities still work without linking. Repeat after token refresh. If the existing connection cannot adopt OAuth, assess a new connection explicitly rather than assuming Refresh migrated its authorization state.

## Rollback

Set `NYMREL_REMOTE_NYMREL_PLUGIN_READONLY_ENABLED=false` and disable the hosted adapter. The backend route then disappears, while the original direct read-only resource and public Nymrel tools retain their prior contracts. Neither flag changes device pairing, allowed roots, or stored calls.

Local backend acceptance: `node --test test/chatgpt-readonly-http.test.js` covers disabled/default behavior, exact audience, static-token denial, mapped tenant isolation, frozen catalog, denied writes, and cross-profile pending-result isolation. These local tests do not prove the hosted adapter, live provider, ChatGPT sign-in, or production file read.
