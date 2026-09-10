# Nymrel Remote ChatGPT plugin

Nymrel Remote exposes two MCP surfaces from the same control plane:

- `/mcp` is the full operator/developer surface. It dynamically projects each paired device's local tool catalog and keeps pairing, call administration, audit, and other operator controls available.
- `/chatgpt/mcp` is the stable ChatGPT plugin surface. Its action names and schemas do not change when a device is paired, revoked, renamed, or re-paired.

The public ChatGPT endpoint is intentionally a facade over the existing broker. It does not create a second execution path. A stable action such as `read_file` resolves the requested `device` to the current projected device tool, removes the routing-only `device` field, and then enters the same Nymrel policy, encrypted durable-call, schema-hash, approval, and exactly-once execution flow used by `/mcp`.

## Stable public actions

The ChatGPT plugin exposes only the user-facing remote development actions:

- `list_devices`
- `read_file`
- `list_directory`
- `get_file_info`
- `search_files`
- `search_content`
- `write_file`
- `edit_block`
- `start_process`
- `read_process_output`
- `interact_with_process`
- `list_sessions`
- `list_processes`
- `kill_process`

Pairing approval, device revocation, delete/move primitives, raw call administration, audit administration, and other internal/operator tools remain on `/mcp` rather than being frozen into the public plugin snapshot.

## Device selection

Every device-backed public action accepts an optional `device` string. It may be a paired device id or an exact device name such as `JalenPC`.

When `device` is omitted, Nymrel Remote selects the device only if there is exactly one eligible device (preferring an online and ready device). Ambiguous selections fail closed and require the caller to name the device.

The selector is routing metadata only. It is never forwarded into the local filesystem or process tool arguments.

## OAuth resource

The ChatGPT surface is a separate OAuth resource from the generic MCP endpoint:

```text
https://<host>/chatgpt/mcp
```

Protected Resource Metadata is published at:

```text
https://<host>/.well-known/oauth-protected-resource/chatgpt/mcp
```

The recommended production audience is the exact ChatGPT MCP URL. Set it explicitly when the authorization server requires a configured audience:

```text
NYMREL_REMOTE_CHATGPT_OAUTH_AUDIENCE=https://<host>/chatgpt/mcp
```

The public endpoint asks only for these scopes:

```text
devices:read
tools:read
tools:write
tools:execute
tools:network
```

`start_process` and `interact_with_process` require both the normal execute policy and `tools:network`, because an arbitrary process may communicate with external systems. The underlying Nymrel policy/approval path remains authoritative.

## Review annotations

All public tools explicitly declare `readOnlyHint`, `openWorldHint`, and `destructiveHint`.

File overwrite/edit actions and process termination are marked destructive. Arbitrary process start/interaction are marked both destructive and open-world. `read_process_output` is marked non-read-only because a default read advances the retained-session cursor even though it does not change the user's filesystem.

## No widget dependency

The first release is tool-only. It does not require a ChatGPT widget or an iframe CSP. The existing Nymrel Remote web dashboard remains an operator surface outside the plugin.

## Submission artifact

`chatgpt-app-submission.json` contains the review-facing app metadata, tool-hint justifications, five positive tests, and three negative tests for the stable `/chatgpt/mcp` surface. Do not submit the dynamic `/mcp` endpoint as the public plugin URL.
