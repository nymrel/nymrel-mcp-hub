# Contributing to @nymrel/mcp-hub

Thank you for contributing to the Nymrel Model Context Protocol (MCP) Unified Server.

## Development Principles
1. **Zero External Runtime Dependencies:** Standard Node.js and Python built-ins only.
2. **Dual-Audience Contract:** Everything built must look visually stunning for humans and expose structured, verifiable JSON-LD machine trust.
3. **Warm Paper Design Aesthetics:** `#FAF8F2` warm cream, `#2A332E` cedar green, `#A8541F` terracotta.
4. **Fail-closed validation:** All tool registrations, JSON-RPC endpoints, dual-language runtimes, package checks, and audits must pass before submission.
5. **Dual-era wire discipline:** Modern `2026-07-28` responses require per-request metadata and modern result envelopes; initialize-era responses must stay free of modern-only fields. TypeScript and Python behavior must remain identical.

## Build and Test Instructions
```bash
corepack npm@12.0.2 ci
corepack npm@12.0.2 run verify
corepack npm@12.0.2 audit --audit-level=high
corepack npm@12.0.2 audit --omit=dev --audit-level=high
corepack npm@12.0.2 install-scripts ls

python -m pip install --requirement requirements-dev.txt
python -m pip install --editable .
python -m pip check
python -m ruff check python tests
python -m bandit -q -r python/nymrel_mcp_hub
python -m pytest -q
python -m pip uninstall --yes nymrel-mcp-hub
python -m pip_audit --strict
python -m build --outdir dist-py
python -m twine check dist-py/*
```

Supported runtime lines are Node.js 22/24 and Python 3.11-3.14. Do not bypass locked installs, exact development tools, audits, or package validation with fallback installers or warning-only shell clauses.

Protocol changes must prove direct and stdio behavior for both eras. At minimum, retain legacy initialization and response-shape tests, modern `server/discover` and inline-request tests, unsupported-version and malformed-metadata tests, notification silence, and cross-engine parity.

Publication remains separate from pull-request validation. A matching `v<package-version>` tag may start the tag-only release workflow, but npm/PyPI trusted-publisher configuration and protected `npm`/`pypi` environments remain external operator gates.
