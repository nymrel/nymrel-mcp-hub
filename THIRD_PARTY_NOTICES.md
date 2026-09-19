# Vendored Proof Ledger

This package contains the canonical Nymrel Proof Ledger core under the MIT license.
Source: https://github.com/nymrel/nymrel-proof-ledger
Revision: `e149d4448072b1931da25acd27f7d26ef255bbd2`.

The five TypeScript and five Python core modules share the pinned upstream implementation.
Eight modules are copied without changes. Each receipt module has a minimal local
patch adding an optional Git-context opt-out, which the MCP adapters always use.
Canonicalization, envelopes, hashing and signatures are unchanged.
The upstream license is included at `docs/proof-ledger/LICENSE`; source paths and
SHA-256 digests of LF-normalized local source and original receipt modules are in
`docs/proof-ledger/SOURCE.json`; the exact patch is `docs/proof-ledger/disable-git-context.patch`.
The upstream Protocol v2 fixture is included in the source repository tests.

Thin MCP adapters are maintained in this repository. They require Protocol v2,
validate signature hex encoding, bind supplied keys to an independently chosen
expected algorithm before calling the canonical verifier, reject
unknown tool arguments, and never enable on-disk artifact checks. The canonical
library's legacy v1 implementation is retained in the verbatim vendor copy but
is not exposed by these tools. Update both runtimes from the same upstream
revision, refresh the source digests and fixtures, and run cross-runtime tests
and independent security review before changing the pin.
