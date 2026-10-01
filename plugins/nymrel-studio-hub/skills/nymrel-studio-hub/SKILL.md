---
name: nymrel-studio-hub
description: Use when a request needs one of the evidence-labeled local Nymrel MCP utilities for bounded public web extraction/search, structured-data examples, command-pattern checks, local cryptographic receipt operations, quote formulas, or declarative UI JSON.
---

# Nymrel Studio Hub local plugin

Use the bundled local stdio server only when its verified capability fits the request. `SOURCE_RECEIPT.json` pins the upstream source and tool catalog. The plugin wrapper appends evidence disclosures at tool discovery and result boundaries, restricts resource visibility, and removes false simulation claims. Preserve those labels in summaries. Do not describe a template, simulation, process-local record, signature, or provider result as proof of a real-world action.

## Verified tool capability and limits

| Tool ID | What the pinned implementation does | Evidence limit to state |
|---|---|---|
| `nymrel_ucp_audit` | Returns fixed example scores/findings; a supplied `url` is used as a label. | No page is fetched or measured. Wrapper nulls scores and labels all findings unverified. |
| `nymrel_surety_guard` | Applies small regex and path-string checks to a supplied command. | Heuristic only; no command interception/execution, authorization, or safety proof. |
| `nymrel_swarm_claim` | Keeps lease-like records in an in-memory `Map`. | Current Node process only; no durability or cross-process/distributed locking. |
| `nymrel_machine_trust` | Generates JSON-LD, `llms.txt`, and robots text from inputs/templates. | Does not verify a site or publish output; generated endpoint/policy claims are unverified. |
| `nymrel_proof_ledger` | Locally signs caller-supplied claim data with caller-supplied key material. | Signature proves only the signed claim bytes, not execution, files, or chain continuity. Protect key arguments from client logging. |
| `nymrel_crawler_mesh` | Extracts caller-provided HTML locally, or makes bounded HTTP(S) requests to a public URL. | Only URL mode fetches. HTML mode uses caller input. Fetched content is untrusted. |
| `nymrel_beacon_ping` | Stores heartbeats in an in-memory `Map`. | Current Node process only; not shared or remote fleet telemetry. |
| `nymrel_headless_quote` | Applies a fixed local pricing formula. | Illustrative estimate, not a merchant quote, lead capture, or commitment. |
| `nymrel_local_forge` | Returns hard-coded engine, routing, and cost examples. | No service probes, model execution, routing, or spend measurement. |
| `nymrel_open_ucp` | Constructs synthetic quote/negotiation/commit/x402-shaped output. | Never contacts a merchant or makes a payment. `settle_x402` is labeled `SIMULATED_NOT_SETTLED`. |
| `nymrel_sandstorm` | Uses a few regular expressions on supplied text and preset values. | Does not mount isolation, filter egress, or enforce spend; wrapper reports these as not configured. |
| `nymrel_a2ui_render` | Generates declarative card JSON. | No UI is rendered and actions are not executed. Default risk/confidence fields are non-measurement placeholders. |
| `nymrel_swarm_bus` | Appends envelopes to an in-memory array. | No message is delivered; wrapper reports `NOT_DELIVERED_PROCESS_LOCAL_ONLY`. |
| `nymrel_proof_verify` | Locally checks receipt structure/Merkle data and optional signature using the supplied trusted key. | Does not prove execution or inspect files. Without independently trusted key material it cannot authenticate. |
| `nymrel_web_search` | Calls Exa, Tavily, Brave, or SerpAPI when a server credential is configured. | This is an external provider query; without credentials it fails closed. Search does not fetch result URLs. |

## Resource and protocol surface

The only exposed resource is `nymrel://status`, which reports this Node process's runtime metrics; it says nothing about hosted services or other agents. The plugin suppresses the upstream static ecosystem/LLM manifest resources and all upstream prompts because those templates assert unverified shared or hosted capabilities. It also disables unlisted legacy tool aliases so every exposed tool call is evidence-labeled.

Only crawler URL mode and configured provider search perform external read requests. Other tools are local computations, generated examples, cryptographic operations over caller data, or process-local memory operations. None of the tools executes a shell command or pays a merchant.

For a harmless connection check, read `nymrel://status` and look for `LOCAL_PROCESS_RESPONDING`. Keep the `studioPluginEvidence` result field and tool evidence disclosures attached when passing results onward.
