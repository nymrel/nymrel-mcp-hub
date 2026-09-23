# OAuth provider cutover for regular ChatGPT (2026-09-22)

The deployed read-only resource is `https://nymrel-remote-production.up.railway.app/chatgpt/readonly/mcp`. The service verifies OAuth tokens; it does not issue them. The live strict cutover probe currently stops at authorization-server metadata because no provider is configured. No ordinary ChatGPT conversation has read a local file yet.

## Provider choice

| Candidate | Fit for this resource | Exact cutover condition |
| --- | --- | --- |
| [WorkOS AuthKit](https://workos.com/docs/authkit/mcp) | Publishes MCP OAuth metadata, PKCE S256, refresh tokens, CIMD/DCR, and exact Resource Indicators. Preferred new-provider candidate. | Register the literal read-only resource URL. Verify that the ChatGPT client actually receives `devices:read tools:read`; [WorkOS says dynamically registered clients get only standard OIDC scopes unless support configures environment-wide custom scopes](https://workos.com/docs/authkit/connect/token-claims). A predefined OAuth client with assigned scopes is another route if ChatGPT accepts that client. Do not activate from an audience-only test. |
| [Auth0](https://auth0.com/docs/get-started/applications/dynamic-client-registration) | Supports custom API scopes and DCR with PKCE and refresh tokens. Viable if an existing tenant is available. | Register an API whose identifier is the literal read-only resource URL, grant only the two read scopes to third-party clients, and enable [Resource Parameter Compatibility Profile](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0) so ChatGPT's `resource` parameter becomes `aud`. DCR is open registration; subject-to-tenant mapping remains mandatory. |
| [ZITADEL](https://zitadel.com/docs/guides/integrate/dynamic-client-registration) | DCR is available, but its documented handling of `resource` does not establish the exact audience this service requires. | Hold unless a live token and discovery probe prove exact `aud`, scopes, PKCE, and refresh. |

The provider is not selected by this document. [OpenAI's current ChatGPT developer-mode guidance](https://developers.openai.com/chatgpt) supports general MCP tools for Plus and Pro regular conversations. Standard `search` and `fetch` schemas are needed for [company knowledge eligibility](https://developers.openai.com/plugins/build/mcp-server#company-knowledge-compatibility), which is not this rollout target. The six read-only tools must still pass ChatGPT's actual tool scan before availability is claimed.

## Values to configure after the provider is selected

1. Use `https://nymrel-remote-production.up.railway.app/chatgpt/readonly/mcp` as the provider Resource Indicator or API identifier and the expected token `aud`. Do not use `/mcp` or `/chatgpt/mcp` as a substitute.
2. Record the provider's published issuer exactly, including a trailing slash when published. Verify authorization-server discovery advertises authorization code, PKCE S256, refresh tokens/`offline_access`, and the onboarding method ChatGPT can use.
3. Configure the two read scopes and inspect a real token's *claims* in a private local check: `iss`, exact `aud`, stable operator `sub`, `scope`, `exp`, and signing key. Do not store or paste the token in this repository or a PR.
4. Pair the separate `ChatGPTStudio` device under a dedicated tenant with only the operator-selected local roots. Map the exact operator `sub` to that tenant using `NYMREL_REMOTE_OAUTH_SUBJECT_TENANTS`. The existing whole-profile JalenPC device must remain outside that tenant.
5. Set `NYMREL_REMOTE_AUTHORIZATION_SERVERS` and `NYMREL_REMOTE_OAUTH_ISSUER` to the provider issuer; set JWKS or introspection configuration only as required by that provider. Configure production values in the provider's secret store, not Git.
6. Run `node scripts/check-production-cutover.mjs https://nymrel-remote-production.up.railway.app --profile=readonly`. Then connect the URL in ChatGPT Pro developer mode and prove an allowed file read, denied parent/profile/credential roots, and refresh after token expiry.

## Authorization and rollback

External OAuth app/account registration and production credential or environment-secret changes require an exact grant under `portfolio-control/PROTECTED_ACTIONS.md`. Prepare the provider, scope, tenant, and folder-root values for review first; do not ask the operator to approve an abstract provider choice. The operator's folder and provider preferences are pending.

To close the resource if acceptance fails, unset authorization servers or remove the mapped subject as described in [the read-only runbook](CHATGPT_PRO_READONLY.md#rollback). Do not broaden the device root or weaken audience/scope checks to make a provider pass.
