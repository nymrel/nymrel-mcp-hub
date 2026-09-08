# Architecture

## Components

### Stateless MCP edge

The public `/mcp` endpoint authenticates the caller, validates the current MCP request contract, dynamically exposes tools from the caller's tenant devices, evaluates capability policy, and creates durable calls. No correctness decision depends on an MCP transport session.

### Durable broker

The broker owns the call state machine:

```text
awaiting_approval -> queued -> executing -> completed
                         \-> expired
awaiting_approval -> cancelled
executing -> failed
```

Only a queued call can be atomically claimed. A second concurrent claim fails. Calls are scoped to one tenant, principal, device, original tool name, projected tool name, and schema hash.

### Device agent

The agent makes outbound HTTPS/SSE requests to the control plane and separately supervises a local stdio MCP server. It reconciles the durable queue on heartbeat and after reconnect, so an SSE event can be dropped without losing work. Before execution, it verifies the local tool still exists and its schema hash still matches the call.

### Local MCP runtime

Nymrel Remote does not vendor a shell/filesystem engine. It bridges to an installed local MCP server. DesktopCommanderMCP is a useful default because it is independently available under the MIT license, but the bridge is generic.

## Schema integrity

During registration, each input schema is validated and hashed. Projection copies the complete input schema rather than reconstructing selected fields. The hash is carried through the durable call and checked again on the device immediately before execution. This avoids the class of relay bug where a local tool is valid but an intermediate connector exposes it with an empty or degraded schema.

## Delivery semantics

The SSE `call` event is a doorbell only. The source of truth is the durable store. Execution requires an atomic state transition from `queued` to `executing`; event duplication therefore does not imply execution duplication.

## Cryptographic separation

- `NYMREL_REMOTE_SIGNING_KEY`: internal signed compatibility/device tokens.
- `NYMREL_REMOTE_DATA_KEY`: AES-256-GCM task/result encryption and MRTR request state.
- `NYMREL_REMOTE_AUDIT_KEY`: HMAC chain for audit receipts.

They must be different values in production.

## Current scale boundary

The JSON store is atomic and cross-process locked, but the SSE fanout and waiter registry are in process. Production therefore runs exactly one active control-plane server replica with a persistent filesystem. A future multi-replica version must replace both durable storage and event fanout with shared transactional infrastructure before claiming horizontal scalability.
