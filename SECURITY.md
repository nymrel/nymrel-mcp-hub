# Security Policy

## Reporting Security Issues
Nymrel takes security seriously. If you discover a vulnerability in `@nymrel/mcp-hub` or any of the underlying 14 Nymrel open-source tools, please report it responsibly:

- **Primary Contact:** contact@nymrel.com
- **Coordination:** Keep the report private until Nymrel confirms a disclosure plan through the same channel. No fixed response-time or patch SLA is implied by this public repository.
- **Scope:** Command interceptor bypasses, Merkle tree collision vulnerabilities, unauthorized lease takeovers, and secret exfiltration leaks.

## Zero-Trust Architecture
`@nymrel/mcp-hub` is engineered with native zero-dependency isolation:
1. **Pre-execution Firewall:** Every shell command is screened via AST and destructive pattern checks (`nymrel_surety_guard`).
2. **Secret Token Masking:** Exfiltration paths are scrubbed for API keys and JWTs (`nymrel_sandstorm`).
3. **Cryptographic Attestation:** All state transitions and actions generate RFC-6962 SHA-256 Merkle proofs (`nymrel_proof_ledger`).
4. **Fencing Generations:** Distributed leases use monotonically increasing fencing tokens to prevent split-brain writes (`nymrel_swarm_claim`).

## Supply-chain controls

- Pull requests are gated by locked Node installs, pinned Python tooling, cross-platform tests, package-content checks, dependency audits, Ruff, Bandit, and CodeQL.
- GitHub Actions are pinned to full commit SHAs and default to read-only repository permissions.
- Registry publication is tag-only and uses short-lived npm/PyPI OIDC identities inside dedicated environments. The workflow contains no long-lived registry write token.
- Local validation, a GitHub build, an uploaded artifact, and a completed registry publication are distinct proof states; do not report a release as published without the corresponding registry receipt.
