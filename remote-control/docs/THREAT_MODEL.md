# Threat Model

## Assets

- authority to invoke tools on paired computers
- device registration/tool schemas
- tool arguments and results
- device credentials and operator access tokens
- server signing/data/audit keys
- tenant and audit state

## Trust boundaries

1. AI client to public MCP edge
2. operator browser/API to control plane
3. control plane to outbound device channel
4. device agent to local stdio MCP child
5. local MCP child to the operating system

## Threats and controls

| Threat | Primary controls |
|---|---|
| Cross-tenant device/call access | tenant-bound principals and query checks |
| Stolen public MCP token used for another service | OAuth audience validation |
| Malicious web page targets localhost/public MCP | Origin validation |
| Routing/header ambiguity | modern MCP protocol/method/name/parameter mirror checks |
| Tool schema degraded by relay | exact schema projection + registration hash + pre-execution hash check |
| Duplicate realtime delivery | durable atomic queued-to-executing claim |
| Lost realtime delivery | durable polling reconciliation |
| DB/state-file disclosure | AES-256-GCM task/result envelopes; token hashes for pairing codes |
| Audit modification | chained HMAC receipts |
| Replay/cross-user MRTR approval | AEAD requestState bound to principal, tenant, args hash, tool name, schema, expiry, and call state |
| Destructive tool invoked silently | policy classification; writes/execute gated; known destructive operations deny by default |
| Unknown tool bypasses policy | unknown classification denies by default |
| Revoked device keeps executing | token generation check + revoked device check on every authenticated device operation |
| Expired/offline device accumulates work | offline/mcp-not-ready calls are rejected before enqueue |
| Compromised local MCP process | local child supervised but not trusted as a security sandbox; use OS isolation for high risk |
| Secrets leak through logs | access logs omit bodies/query/tokens; device logs omit task args/results; audit stores hashes |

## Explicit non-goals in this release

- defending against an attacker who already has the OS privileges of the account running the local MCP server
- remote GUI/video streaming
- multi-replica active/active hosting
- end-to-end encryption that prevents the control-plane process from seeing plaintext during an authorized call
- replacing endpoint protection, MFA, OS sandboxing, or a managed authorization server
