# Nymrel Studio Platform Standard

Research basis: September 2026 deep research across current primary documentation for agent search, crawling/browser automation, MCP/agent frameworks, web hosting, and cross-platform app development.

## Principle

Own the interfaces, evaluation corpus, provenance, security policy, and routing data. Treat vendors as replaceable adapters.

Do not give every agent a browser. Use progressive escalation:

1. **Search/discovery** for candidate sources.
2. **Fetch/extract/crawl** only for selected sources or bounded sites.
3. **Privileged browser execution** only when JavaScript, login state, forms, or interaction is required.

This reduces latency, cost, prompt-injection exposure, and unnecessary credential scope.

## Web access defaults

| Capability | Studio default | Secondary / special case |
| --- | --- | --- |
| Agent-oriented search | Exa | Tavily |
| Independent fallback | Brave Search | — |
| Exact Google/SERP/localization | SerpAPI | — |
| Extraction / bounded crawl | Nymrel Crawler Mesh | Apify for specialized external Actors |
| Stateful browser | Browserbase + Stagehand | Sandboxed Playwright |
| Model-native cited research | OpenAI / Claude / Gemini native search | Use when synthesis is intentionally coupled to the model |
| Agent/tool interoperability | MCP + typed internal APIs | A2A for cross-agent messaging |

### Nymrel Web Access Gateway

All studio agents should call a capability contract rather than a vendor SDK directly:

```text
search(query, provider?, mode?, freshness?, locale?, domains?)
fetch(url)
crawl(url, depth, limits)
browse(task, session_policy)
research(question, effort)
```

Current MCP implementation:

- `nymrel_web_search`: normalized discovery across Exa, Tavily, Brave Search, and SerpAPI.
- `nymrel_crawler_mesh`: extraction/crawling escalation layer. PR #69 is the live-runtime implementation path.
- Browser execution remains a separately privileged service; it should not be embedded into the search tool.

### Routing

- Normal search: Exa -> Tavily -> Brave -> SerpAPI.
- Research search: same provider order; Tavily uses advanced search when selected.
- Exact SERP: SerpAPI -> Brave -> Exa -> Tavily.
- Missing provider credentials are skipped only in `auto` mode.
- Provider errors are recorded and the next configured provider is tried in `auto` mode.
- If no provider succeeds, return an explicit error. Never invent results.

### Credentials and policy

Search credentials are server-owned environment configuration:

- `EXA_API_KEY`
- `TAVILY_API_KEY`
- `BRAVE_SEARCH_API_KEY`
- `SERPAPI_API_KEY`

Never accept provider keys as MCP tool arguments. Never return keys in tool output. Browser credentials should be short-lived, scoped, brokered, and isolated from ordinary search sessions.

Internet content is untrusted data. It must never be treated as higher-priority instructions than the agent/system policy.

## Evaluation contract

Provider choice is empirical. Benchmark on studio workloads and record:

- authoritative-source hit rate;
- citation/support rate;
- freshness;
- duplicate rate;
- p50/p95 latency;
- cost per successfully supported answer;
- locale/language quality;
- provider failure/fallback rate;
- crawler escalation rate;
- browser escalation rate.

Store provider, query hash, URL, retrieval timestamp, content hash, extraction method, latency, cost, and citation linkage when evidence is persisted.

## Web product defaults

### Product/application sites

Default:

```text
Next.js -> Vercel
Postgres/Supabase where relational data and portability matter
Firebase when prototype velocity is the dominant constraint
```

Use this for authenticated products, AI interfaces, commerce, dashboards, and dynamic sites.

### Content-first sites

Default:

```text
Astro -> Cloudflare
```

Use for documentation, publications, SEO/content properties, and low-cost high-performance sites.

### Design-led marketing

- Framer for rapid campaign and marketing sites.
- Webflow when a visual CMS/editorial workflow is a first-class requirement.
- Prefer a headless CMS when content must serve several products/channels.

### CMS

- Sanity: flexible structured content and custom editorial tooling.
- Contentful: governance-heavy/multi-channel editorial organizations.
- Strapi/self-hosted: control-sensitive workloads.

Keep a `StudioContentClient` adapter boundary so presentation code does not depend directly on one CMS.

## Mobile defaults

Default:

```text
React Native + Expo
EAS for build / submit / OTA workflows
```

Alternatives:

- Flutter when a controlled cross-platform rendering model is worth standardizing on Dart.
- Native Swift/SwiftUI or Kotlin/Compose when deep platform APIs, UX, or performance justify separate codebases.
- PWA first when app-store distribution and deepest native APIs are unnecessary.

Clients should authenticate to a studio-owned API boundary; do not hand a general-purpose agent unrestricted end-user backend credentials.

## Agent orchestration defaults

- LangGraph/LangChain: neutral default when provider interchangeability matters.
- Microsoft Agent Framework: Microsoft/.NET/Azure engagements.
- Google ADK: Gemini/GCP engagements.
- OpenAI Agents/Responses stack: OpenAI-first products where native tools reduce infrastructure.

MCP is the external tool interoperability layer, not a replacement for low-latency typed internal service APIs.

## Production gates

Before introducing a new vendor or promoting an integration:

1. Prove it improves the fixed studio evaluation set or fills a missing capability.
2. Define provider timeout, retry, and fallback behavior.
3. Document rate limits and unit economics.
4. Review retention, DPA/ZDR availability, subprocessors, and data residency as needed.
5. Keep secrets out of prompts and request bodies unless the provider protocol requires them.
6. Preserve source URL and retrieval timestamp for external evidence.
7. Add deterministic regressions for fail-closed behavior.
8. Keep browser actions behind explicit privilege/policy boundaries.
9. Preserve an exit path: adapter interface, exportable data, or standard runtime.

## Current implementation sequence

1. Ship `nymrel_web_search` and its normalized provider contract.
2. Reconcile/merge Crawler Mesh PR #69 after its review and validation, rather than duplicating crawler work.
3. Add a browser-execution service behind a separate privileged tool boundary.
4. Add the shared provider evaluation corpus and telemetry.
5. Apply the web/mobile reference stacks to new studio products, then migrate existing products only where the payoff exceeds churn.
