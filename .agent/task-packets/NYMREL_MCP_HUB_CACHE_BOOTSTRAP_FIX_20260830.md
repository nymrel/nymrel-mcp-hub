# Nymrel MCP Hub cache-bootstrap repair

Date: 2026-08-30
Owner: Codex
Claim: `codex-nymrel-mcp-hub-cache-bootstrap-fix-20260830`
Base: `96874c4efbf09d9717b25815b03410a93da97247`

## Mission

Repair the hosted Node CI bootstrap failure demonstrated by GitHub Actions run
`33288031462` without weakening the exact npm 12 toolchain contract or adopting
the unrelated Dependabot dependency-major branch.

## Evidence and root cause

Every Node job failed inside `actions/setup-node` before dependency installation.
The action's `cache: npm` probe called the runner-bundled npm 11.19.0, while the
repository's deliberate `devEngines` contract requires npm 12.0.2. Python,
CodeQL, packaging, and workflow-security lanes passed independently.

## Bounded change

- Disable setup-node's explicit and implicit package-manager cache bootstrap.
- Continue running every install, verification, and audit command through the
  reviewed `corepack npm@12.0.2` toolchain.
- Add a deterministic regression contract for this ordering boundary.
- Preserve the stale primary checkout and its untracked `.agent` packet exactly.
- Do not modify, merge, or adopt Dependabot PR #3.

## Acceptance

- CI contract tests prove no npm cache probe occurs before npm 12 activation.
- Full Node and Python local contracts remain green where runtimes are available.
- actionlint and zizmor pass.
- The exact candidate receives independent review before publication.
- Hosted PR checks are the final proof of cross-platform repair.

## Honest gates

This lane does not publish npm or PyPI packages, create trusted-publisher
relationships, tag a release, deploy a service, or claim adoption or revenue.
