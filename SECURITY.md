# Security Policy

## Reporting Security Issues
Nymrel and JalenBuilds LLC take security seriously. If you discover a vulnerability in `@nymrel/mcp-hub` or any of the underlying 14 Nymrel open-source tools, please report it responsibly:

- **Primary Contact:** contact@jalenbuilds.com
- **Response SLA:** Acknowledgement within 24 hours; patch deployment within 72 hours.
- **Scope:** Command interceptor bypasses, Merkle tree collision vulnerabilities, unauthorized lease takeovers, and secret exfiltration leaks.

## Zero-Trust Architecture
`@nymrel/mcp-hub` is engineered with native zero-dependency isolation:
1. **Pre-execution Firewall:** Every shell command is screened via AST and destructive pattern checks (`nymrel_surety_guard`).
2. **Secret Token Masking:** Exfiltration paths are scrubbed for API keys and JWTs (`nymrel_sandstorm`).
3. **Cryptographic Attestation:** All state transitions and actions generate RFC-6962 SHA-256 Merkle proofs (`nymrel_proof_ledger`).
4. **Fencing Generations:** Distributed leases use monotonically increasing fencing tokens to prevent split-brain writes (`nymrel_swarm_claim`).
