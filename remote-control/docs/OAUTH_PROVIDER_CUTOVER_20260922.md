# OAuth provider cutover for regular ChatGPT (2026-09-22)

The deployed read-only resource is `https://nymrel-remote-production.up.railway.app/chatgpt/readonly/mcp`. The service verifies OAuth tokens; it does not issue them. The live strict cutover probe currently stops at authorization-server metadata because no provider is configured in Remote. ChatGPT's MCP app form also reports that this resource does not yet implement OAuth. No ordinary ChatGPT conversation has read a local file yet.

## Auth0 setup in progress

An Auth0 free tenant now has a custom API named `Nymrel Remote ChatGPT Read Only`. Its immutable API identifier is the exact read-only MCP resource URL above. The API has only `devices:read` and `tools:read`; delegated access requires an explicit per-app grant, and machine clients are disallowed. No ChatGPT client or user has been granted access. The tenant's Resource Parameter Compatibility Profile is on, while open Dynamic Client Registration and Client ID Metadata Document (CIMD) registration remain off. The production Remote issuer, JWKS, and subject-to-tenant settings have not been changed.

ChatGPT's current MCP app form offers a **User-Defined OAuth Client** with public-client `none` token authentication and optional client-secret methods. Its advanced settings also show CIMD and DCR as unavailable until discovery supports them. A predefined public client is therefore a possible free-plan route if Auth0 can bind that client to this API, the exact ChatGPT callback, PKCE, refresh tokens, and a domain-level operator login connection. The form's callback URL is generated for the current connection draft; copy it when registering the client rather than assuming an older callback pattern. The draft has not been created.

The alternative CIMD import is unproven on Auth0 Free. [ChatGPT advertises both `none` and `private_key_jwt`](https://developers.openai.com/plugins/build/auth), while [Auth0 says Private Key JWT requires Enterprise](https://auth0.com/docs/get-started/applications/configure-private-key-jwt). Do not pay for an upgrade, enable open DCR, or claim CIMD compatibility without a successful free-plan import and token exchange.

## Provider choice

| Candidate | Fit for this resource | Exact cutover condition |
| --- | --- | --- |
| [WorkOS AuthKit](https://workos.com/docs/authkit/mcp) | Publishes MCP OAuth metadata, PKCE S256, refresh tokens, CIMD/DCR, and exact Resource Indicators. Fallback if Auth0 cannot complete a free-plan client flow. | Register the literal read-only resource URL. Verify that the ChatGPT client actually receives `devices:read tools:read`; [WorkOS says dynamically registered clients get only standard OIDC scopes unless support configures environment-wide custom scopes](https://workos.com/docs/authkit/connect/token-claims). A predefined OAuth client with assigned scopes is another route if ChatGPT accepts that client. Do not activate from an audience-only test. |
| [Auth0](https://auth0.com/docs/get-started/applications/third-party-applications/security-controls) | Selected free tenant; the exact API and read scopes exist. | Register one verified ChatGPT client using a method the free plan supports, grant only the two read scopes, and prove the `resource` parameter becomes the exact `aud`. Keep open DCR off; subject-to-tenant mapping remains mandatory. |
| [ZITADEL](https://zitadel.com/docs/guides/integrate/dynamic-client-registration) | DCR is available, but its documented handling of `resource` does not establish the exact audience this service requires. | Hold unless a live token and discovery probe prove exact `aud`, scopes, PKCE, and refresh. |

Auth0 is the current provider candidate, but no client grant or live token has passed. [OpenAI's current ChatGPT developer-mode guidance](https://developers.openai.com/chatgpt) supports general MCP tools for Plus and Pro regular conversations. Standard `search` and `fetch` schemas are needed for [company knowledge eligibility](https://developers.openai.com/plugins/build/mcp-server#company-knowledge-compatibility), which is not this rollout target. The seven read-only tools must still pass ChatGPT's actual tool scan before availability is claimed.

## Values to configure for cutover

1. Use `https://nymrel-remote-production.up.railway.app/chatgpt/readonly/mcp` as the provider Resource Indicator or API identifier and the expected token `aud`. Do not use `/mcp` or `/chatgpt/mcp` as a substitute.
2. Record the provider's published issuer exactly, including a trailing slash when published. Verify authorization-server discovery advertises authorization code, PKCE S256, refresh tokens/`offline_access`, and the onboarding method ChatGPT can use.
3. Configure the two read scopes and inspect a real token's *claims* in a private local check: `iss`, exact `aud`, stable operator `sub`, `scope`, `exp`, and signing key. Do not store or paste the token in this repository or a PR.
4. The separate `ChatGPTStudio` device is paired and online in dedicated tenant `chatgpt-studio-20260922` with only the staged four-file share; production listed no other device in that tenant. Map the exact operator `sub` to it using `NYMREL_REMOTE_OAUTH_SUBJECT_TENANTS`. The existing whole-profile JalenPC device remains outside that tenant.
5. Set `NYMREL_REMOTE_AUTHORIZATION_SERVERS` and `NYMREL_REMOTE_OAUTH_ISSUER` to the provider issuer; set JWKS or introspection configuration only as required by that provider. Configure production values in the provider's secret store, not Git.
6. Run `node scripts/check-production-cutover.mjs https://nymrel-remote-production.up.railway.app --profile=readonly --predefined-client` only after a predefined client exists (omit the final flag for CIMD). Then connect the URL in ChatGPT Pro developer mode and prove an allowed file read, denied parent/profile/credential roots, and refresh after token expiry. A passing metadata probe alone does not prove that Auth0 issued a usable token or that ChatGPT can complete sign-in.

## Authorization and rollback

External OAuth app/account registration and production credential or environment-secret changes require an exact grant under `portfolio-control/PROTECTED_ACTIONS.md`. The staged four-file share and Auth0 API are already fixed for this rollout; keep the subject mapping scoped to the separate ChatGPTStudio tenant. Do not expand the device's local root during cutover.

To close the resource if acceptance fails, unset authorization servers or remove the mapped subject as described in [the read-only runbook](CHATGPT_PRO_READONLY.md#rollback). Do not broaden the device root or weaken audience/scope checks to make a provider pass.
