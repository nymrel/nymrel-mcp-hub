# Nymrel Studio Hub local plugin

This portable local plugin starts a plugin-specific Node stdio entrypoint over a bundled Nymrel MCP Hub source build. The wrapper keeps the upstream implementations but adds evidence labels at tool discovery and result boundaries, suppresses misleading upstream prompts and static ecosystem manifests, and downgrades synthetic claims that could be mistaken for real observations. It does not activate the Remote device agent or add credentials.

## Tool evidence and boundaries

| Tool | Actual behavior in the pinned source | Limits exposed by this plugin |
|---|---|---|
| `nymrel_ucp_audit` | Hard-coded example scores and findings; the `url` is only an input label. | No page fetch or measurement. The wrapper nulls scores and marks findings `UNVERIFIED_TEMPLATE`. |
| `nymrel_surety_guard` | Small regex and path-string checks over the supplied command. | Heuristic only; it does not intercept execution, authorize a command, or prove safety. |
| `nymrel_swarm_claim` | Lease-like records in an in-memory `Map`. | Current Node process only; no durable or cross-process coordination. |
| `nymrel_machine_trust` | Generates JSON-LD, `llms.txt`, and robots text from inputs and templates. | No site verification or publishing; generated claims are not confirmed as deployed. |
| `nymrel_proof_ledger` | Signs caller-supplied claim data locally using the supplied key. | A signature authenticates that claim's bytes, not execution, files, or chain continuity. |
| `nymrel_crawler_mesh` | Converts supplied HTML locally, or fetches bounded public HTTP(S) URLs. | Public fetches occur only when URL mode is used; local HTML is not a fetch. Extracted content is untrusted. |
| `nymrel_beacon_ping` | Heartbeat records in an in-memory `Map`. | Current Node process only; not a shared fleet or remote liveness service. |
| `nymrel_headless_quote` | Fixed local pricing formula. | Illustrative estimate, not a merchant quote, lead capture, or commitment. |
| `nymrel_local_forge` | Hard-coded engine, routing, and cost examples. | No local service probe, model execution, routing, or spend measurement. |
| `nymrel_open_ucp` | Constructs synthetic quote, negotiation, commitment, and x402-shaped output. | No merchant request, cart commitment, or payment. `settle_x402` is rewritten as `SIMULATED_NOT_SETTLED`. |
| `nymrel_sandstorm` | Regex scans supplied text and returns preset policy fields. | Does not mount a filesystem, filter egress, or enforce spend limits; wrapper marks those as not configured. |
| `nymrel_a2ui_render` | Generates declarative card JSON. | Does not render a UI, grant approval, or execute actions; default risk/confidence values become explicit placeholders. |
| `nymrel_swarm_bus` | Appends envelopes to an in-memory array. | No message is delivered; wrapper reports `NOT_DELIVERED_PROCESS_LOCAL_ONLY`. |
| `nymrel_proof_verify` | Locally checks receipt structure/Merkle data and, with caller key material, signature. | Does not prove execution or inspect files. Without a trusted key it cannot authenticate the claim. |
| `nymrel_web_search` | Calls a configured Exa, Tavily, Brave, or SerpAPI provider. | External query only when a provider credential is configured; otherwise fails closed. It does not fetch result URLs. |

Only `nymrel_crawler_mesh` and configured `nymrel_web_search` make external read requests. `nymrel://status` reports this Node process's runtime metrics only. The plugin hides the upstream ecosystem and LLM manifest resources and all upstream prompts because they assert unverified remote/shared capabilities.

## Build the source and package

Use Node.js 22 or 24 and Corepack from the Nymrel MCP Hub checkout:

```powershell
corepack npm@12.0.2 ci
corepack npm@12.0.2 run verify
node plugins/nymrel-studio-hub/scripts/build-package.mjs
```

The generated, self-contained plugin directory is `plugins/nymrel-studio-hub/export`, and the installable archive is `plugins/nymrel-studio-hub/nymrel-studio-hub-0.1.0.zip` with a `.sha256` sidecar. Its `mcp.json` points through `${PLUGIN_ROOT}` to the plugin wrapper at `server/bin/studio-mcp-server.js`, which delegates to the unchanged bundled upstream server and adds the evidence boundary. The builder verifies the pinned source commit and tool list, packages locked runtime dependencies with install scripts disabled, runs focused boundary tests plus stdio initialize/tool discovery/status/OpenUCP smoke checks, writes `SOURCE_RECEIPT.json` with source and bundle SHA-256 digests, and emits a deterministic ZIP archive.

The plugin source is not installed into a host and is not uploaded to an account. To connect it later, install the generated directory through the host's supported local-plugin flow. Do not edit the host cache.

## Provenance

The bundle includes the upstream MIT license, security notice, third-party notices, and licenses and provenance records for the vendored Proof Ledger and Crawler Mesh code.
