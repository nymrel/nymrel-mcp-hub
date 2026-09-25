# Vendored Proof Ledger

This package contains the canonical Nymrel Proof Ledger core under the MIT license.
Source: https://github.com/nymrel/nymrel-proof-ledger
Revision: `c0cd721c7435421e9203af0852da7596397b762d`.

The five TypeScript and five Python core modules share the pinned upstream implementation.
All ten modules are copied without changes. Upstream verification now requires
an independently configured expected algorithm with each key; adapters forward
their already-validated context. Git collection defaults off upstream and remains
explicitly disabled by both MCP adapters. No local core patch is needed.
The upstream license is included at `docs/proof-ledger/LICENSE`; source paths and
SHA-256 digests of LF-normalized source are in `docs/proof-ledger/SOURCE.json`.
The upstream Protocol v2 fixture is included in the source repository tests.

Thin MCP adapters are maintained in this repository. They require Protocol v2,
validate signature hex encoding, bind supplied keys to an independently chosen
expected algorithm before calling the canonical verifier, reject
unknown tool arguments, and never enable on-disk artifact checks. The canonical
library's legacy v1 implementation is retained in the verbatim vendor copy but
is not exposed by these tools. Update both runtimes from the same upstream
revision, refresh the source digests and fixtures, and run cross-runtime tests
and independent security review before changing the pin.

# Vendored Crawler Mesh

This package contains a pinned subset of Nymrel Crawler Mesh under the MIT license.
Source: https://github.com/nymrel/nymrel-crawler-mesh
Revision: `b5dcdb971328a07bd77e953935abac1c89e43c99`.

The TypeScript crawler, extractor, cache, Firecrawl-compatibility facade, and network-policy modules required by the Node MCP adapter are copied without changes under `src/vendor/crawler-mesh/`. The Python crawler, extractor, cache, queue, robots, sitemap, rate-limiter, models, and network-policy modules required by the Python MCP adapter are copied without changes under `python/nymrel_mcp_hub/_crawler_mesh/`. The upstream MIT license is included at `docs/crawler-mesh/LICENSE`; source paths and exact upstream Git blob IDs are recorded in `docs/crawler-mesh/SOURCE.json`; the verifier LF-normalizes CRLF checkouts before reconstructing those text blob IDs. The six exact low-severity Bandit findings retained by the verbatim Python copy are reviewed in `docs/crawler-mesh/bandit-reviewed.json`; changed or new findings remain blocking.

`scripts/verify-crawler-mesh-vendor.mjs` recomputes Git blob IDs from the local bytes during the normal package verification gate. The Node and Python MCP adapters remain local to this repository and only shape the public tool contract. Upstream network protections remain authoritative, including public-only HTTP(S), DNS/IP validation, redirect revalidation, response-size limits, robots handling, and bounded concurrency.

The vendored runtime depends on upstream-pinned `undici@8.10.2` for DNS/IP-pinned outbound requests. No Firecrawl Cloud client, Firecrawl API key, or Firecrawl source code is included.

