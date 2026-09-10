# Nymrel Remote live deployment receipt — 2026-09-09

## Deployed source

- Repository: `nymrel/nymrel-mcp-hub`
- Branch: `main`
- Source merge: `2221226688e5c825f4034d155091cc47e6255330`
- Railway project: `Nymrel Remote`
- Railway service: `nymrel-remote`
- Production deployment: `9085cbc5-63b8-45aa-8f71-6a0ad77596a6`
- Public origin: `https://nymrel-remote-production.up.railway.app`

## Persisted infrastructure

- One active replica in Railway's `sfo` region.
- Plan-default persistent volume `05ede45a-77b1-4435-b59e-bf0b1b6e406d` is mounted at `/data`.
- Durable store path is `/data/state.json`.
- Runtime starts through the volume-safe entrypoint and drops to UID/GID 1000 after mount preparation.
- Three independent 32-byte service keys and a separate bootstrap credential are stored as provider-managed environment variables. Values are intentionally absent from this receipt.

## Live verification

The exact production deployment produced these receipts:

- `GET /healthz` returned 200 and `status: ok`.
- `GET /readyz` returned 200, `status: ready`, and `audit.valid: true`.
- `GET /privacy`, `/terms`, and `/support` returned 200.
- Both protected-resource metadata endpoints returned 200 with the expected `/mcp` and `/chatgpt/mcp` resource values.
- Unauthenticated POSTs to both MCP endpoints returned 401 with Bearer `WWW-Authenticate` challenges.
- Railway reported the `/data` volume mount before starting the container.

## Temporary bootstrap posture

Static MCP tokens, static admin tokens, and the bootstrap HTTP route remain enabled only for initial private device enrollment. They are not the final public authentication posture.

## Remaining environment gates

1. Install and pair the native Nymrel Remote supervisor on JalenPC.
2. Prove remote read, write, process, restart recovery, and revoke/re-pair flows against JalenPC.
3. Configure an external OAuth/OIDC authorization server with exact audiences and refresh-token support.
4. Disable the three temporary static/bootstrap flags after OAuth and device recovery are proven.
5. Run an independent Cursor review against this receipt and the current source before calling the service generally available.

Do not mark any remaining gate complete without a receipt from the live environment.
