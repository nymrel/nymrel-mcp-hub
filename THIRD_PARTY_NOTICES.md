# Vendored Proof Ledger

This package contains the canonical Nymrel Proof Ledger core under the MIT license.
Source: https://github.com/nymrel/nymrel-proof-ledger
Revision: `09a49a0e66d9443bff979f4d77cf7c0310ef0d8f`.

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
