# Regular ChatGPT Pro read-only profile

## Goal

Give ordinary ChatGPT conversations on the web a narrow Nymrel Remote surface for inspecting JalenPC files without depending on ChatGPT Work or Codex.

This profile is intentionally separate from the full public/plugin catalog. It is a compatibility profile for the current ChatGPT Pro custom-MCP capability and must not widen local permissions.

## Tool surface

The profile exposes only:

- `list_devices`
- `read_file`
- `list_directory`
- `get_file_info`
- `search_files`
- `search_content`

The requested OAuth scopes are only `devices:read` and `tools:read`.

It does not expose writes, edits, shell/process execution, process output, process enumeration, or termination. The device agent's existing allowed-directory boundary remains authoritative.

## Integration boundary

`src/chatgpt-readonly-profile.js` provides a drop-in `ChatgptReadonlyMcpEdge` and frozen catalog. The profile reuses the existing encrypted durable-call broker, projected device schemas, device selector, and exactly-once execution path.

## Wiring contract

The production HTTP server should mount this edge on a distinct ChatGPT resource, for example `/chatgpt/readonly/mcp`, with matching protected-resource metadata and an exact resource audience. Do not replace or silently narrow `/chatgpt/mcp`; that endpoint remains the full directory-submission surface.

The read-only resource metadata must advertise only the two read scopes above. Authentication should remain OAuth-based for ChatGPT; do not use the temporary static-token compatibility mode as the public regular-chat solution.

## Release gates

Before describing this as available in regular ChatGPT:

1. Wire the profile into an isolated resource path without changing the full plugin catalog.
2. Configure OAuth client onboarding, PKCE S256, refresh-token support, and the exact read-only resource audience.
3. Run focused HTTP tests proving the read-only catalog is frozen and mutation/execute tools return not-found rather than reaching the broker.
4. Deploy and run the strict production cutover probe against the read-only resource.
5. Connect it from ChatGPT.com developer mode and prove `list_devices`, `search_content`, and `read_file` against JalenPC.

Mobile remains a separate distribution gate: do not claim iPhone support until the Nymrel app/plugin is available through a ChatGPT distribution path that supports mobile.
