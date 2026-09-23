# Nymrel Remote cloud-recovery release candidate, 2026-09-20

Branch `studio/remote-cloud-recovery-20260920`, based on `origin/main` at `28aef5c`. This is a reviewable candidate. Publication and hosted validation are tracked on its draft PR. It has not been merged or deployed and makes no claim that ChatGPT can connect.

## Included reviewed-candidate commits

Each commit was taken with `git cherry-pick -x` from the exact ref below, with its original author preserved. All applied without conflicts. At the integration checkpoint, the copied PR25 and PR27 files matched their source branches; the implementation below then deliberately extended some of those files. The source branches were not modified.

| PR | Source ref | Source commit | Subject |
| --- | --- | --- | --- |
| 25 | `chatgpt/nymrel-remote-cutover-20260916` | `2f0fc6a` | test(remote): add production cutover probe |
| 25 | | `ee7247c` | test(remote): verify OAuth cutover metadata |
| 25 | | `90aeaa3` | fix(remote): redact cutover probe CLI output |
| 25 | | `8eb5d5b` | test(remote): require OAuth client onboarding |
| 25 | | `288ce64` | test(remote): validate resource scopes at resource metadata |
| 25 | | `093ea03` | test(remote): cover standards-aligned OAuth scope discovery |
| 25 | | `6f84a9a` | test(remote): preserve exact authorization issuer |
| 27 | `chatgpt/nymrel-remote-pro-readonly-20260916` | `8945c8b` | feat(remote): add regular ChatGPT read-only profile |
| 28 | `chatgpt/nymrel-remote-pro-read-cutover-20260917` | `49127f5` | fix(remote): start ChatGPT OAuth at read scope |
| 29 | `chatgpt/nymrel-remote-preserve-oauth-issuer-20260917` | `059a757` | fix(remote): preserve exact OAuth issuer identifiers |

## Omitted refs

Both refs exist. Neither is needed for a coherent read-only cloud release, so neither was integrated.

| PR | Source ref | Commit | Reason |
| --- | --- | --- | --- |
| 22 | `chatgpt/native-windows-regression-20260913` | `ff45b3a` | Fixes process-output polling in the device agent. The read-only profile has no process tools, and the fix only takes effect after an agent update and restart on JalenPC, which is outside this release. It remains a valid independent fix for `/chatgpt/mcp` users. |
| 26 | `chatgpt/nymrel-remote-openai-domain-20260916` | `5735c28` | Adds the OpenAI apps domain-verification challenge route. That is a directory-submission requirement, not a requirement for a developer-mode connector on the operator's own account. It touches `src/chatgpt-server.js` and `src/config.js` and will need a small rebase onto this branch when it is wanted. |

## Work added on top

- `src/oauth-principal-policy.js`: explicit subject-to-tenant mapping, enforced through the single factory every HTTP entry point uses for external OAuth.
- `src/chatgpt-server.js`: `/chatgpt/readonly/mcp` and its protected-resource metadata, OAuth-only, exact audience, read scopes only.
- `src/server.js`, `src/config.js`: the same policy on `/mcp` and the `/v1/*` operator API, and fail-closed production configuration.
- `scripts/check-production-cutover.mjs`: `--profile=readonly`.
- Tests: `test/chatgpt-readonly-http.test.js`, `test/oauth-principal-policy.test.js`, `test/production-cutover-readonly.test.js`.
- Docs: `CHATGPT_PRO_READONLY.md` (provider requirements, configuration names, restricted local roots, onboarding, deployment, rollback), `RAILWAY_DEPLOYMENT.md`, `PRODUCTION_READINESS.md`, `.env.example`.

## Behavior change reviewers should weigh

Before this candidate, an external OAuth token with no tenant claim landed in the `default` tenant, and a token with a tenant claim selected that tenant. Now an external subject that is not in `NYMREL_REMOTE_OAUTH_SUBJECT_TENANTS` is denied everywhere, and production refuses to start with authorization servers but no mapping. Production has no authorization server configured today, so no current caller is affected; static compatibility tokens behave exactly as before.

## Not done here

No deployment, merge, provider or account provisioning, secret access, token minting, DNS, pairing, agent restart, or agent configuration change. See `CHATGPT_PRO_READONLY.md` for the operator inputs that remain.

## Independent integration review

Codex independently reran the full suite (88 passed, no skips) and found a startup
lease leak when a shared read-only audience was rejected after runtime creation.
A production-mode regression reproduced the retained lease. Audience validation
and facade verifier construction now precede runtime creation; the regression
requires no leftover lease and a successful subsequent valid startup. This does
not relax audience or subject admission checks.
