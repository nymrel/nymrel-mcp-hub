# Security Policy

## Reporting Security Issues

Nymrel maintains `@nymrel/mcp-hub` through JalenBuilds LLC. Report suspected vulnerabilities privately and include the affected revision, reproduction steps, expected behavior, and observed impact.

- **Primary contact:** contact@nymrel.com
- **Coordination:** Keep the report private until Nymrel confirms a disclosure plan through the same channel. No fixed response-time or patch SLA is implied by this public repository.
- **Relevant scope:** protocol-validation bypasses, unsafe command-classification results, proof-verification defects, lease or fencing errors, credential disclosure, package-boundary violations, and release-workflow integrity issues.

Do not include live credentials, private customer data, or destructive proof-of-concept payloads in a public issue.

## Security Boundary

The hub exposes tools that inspect commands, generate or verify proofs, coordinate leases, and identify likely secret material. These tools are application-level guardrails; this repository does not claim that they replace operating-system isolation, network enforcement, credential rotation, sandboxing, or independent authorization controls.

Consumers remain responsible for applying least privilege, isolating untrusted workloads, validating tool results at the enforcement point, and protecting secrets outside the MCP process.

## Supply-Chain Controls

- Pull requests are intended to use locked Node installs, pinned Python tooling, cross-platform tests, package-content checks, dependency audits, Ruff, Bandit, and CodeQL.
- GitHub Actions are pinned to full commit SHAs and default to read-only repository permissions where practical.
- Registry publication is tag-only and requests short-lived npm/PyPI OIDC identities inside dedicated environments.
- Registry trusted-publisher relationships and protected environments are external operator gates.
- Local validation, a GitHub build, an uploaded artifact, a tag, and completed registry publication are distinct proof states. Do not report a release as published without the corresponding registry receipt.
