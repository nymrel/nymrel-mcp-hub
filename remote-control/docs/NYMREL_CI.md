# Nymrel CI

Nymrel CI is the studio-owned execution and evidence layer for validating repository commits without depending on GitHub-hosted Actions capacity.

This document describes the first contract slice only. It does not claim that webhook ingestion, GitHub check-run publishing, ephemeral public-PR workers, artifact storage, or deployment promotion are live.

## Goals

- Keep repository validation runnable when GitHub-hosted runners are unavailable or quota-limited.
- Reuse Nymrel Remote's durable call queue, exactly-once claim behavior, approvals, native process execution, and audit receipts rather than inventing another device daemon.
- Preserve each repository's existing validation commands instead of creating a second test truth.
- Produce deterministic job plans and evidence keyed to an immutable commit SHA.
- Keep execution policy outside repository-controlled manifests: repository code can request capabilities, but it cannot grant itself secrets, broader filesystem roots, network trust, or deployment authority.

## Trust lanes

### Trusted studio lane

Use Nymrel Remote devices only for commits from explicitly approved Nymrel/JalenBuilds repositories and branches. A runner workspace must be a dedicated checkout with the smallest practical filesystem roots and no production credentials in the process environment.

This lane is appropriate for studio-owned branches where the same operators already have code-execution authority on the runner.

### Untrusted contribution lane

Do not execute public-fork or otherwise untrusted pull-request code on a persistent workstation. Run those jobs only in disposable OS/container/VM workers with no long-lived secrets and tightly constrained network and filesystem access.

A future Nymrel CI scheduler must classify trust before dispatch. Approval alone is not a sandbox.

## Repository contract

The initial manifest format is JSON and versioned:

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "verify",
      "command": "npm run verify",
      "cwd": ".",
      "timeoutSeconds": 1200,
      "platform": "any",
      "dependsOn": [],
      "requiresNetwork": false
    }
  ]
}
```

Rules:

- Job ids are unique and stable.
- `cwd` is repository-relative and cannot escape the checkout root.
- Dependencies must exist and form an acyclic graph.
- Repository manifests cannot contain environment-variable values or secrets.
- `requiresNetwork` is a declaration for scheduler policy. It is not an operating-system network sandbox by itself.
- Platform values are `any`, `linux`, `darwin`, or `win32`.
- Manifest and execution-plan hashes are deterministic and should be included in CI evidence.

The canonical location should be `.nymrel/ci.json` once consumers are migrated. During adoption, repositories may generate the same object from their existing one-command validation path.

## Execution model

1. Receive a `push`, `pull_request`, manual, or studio-agent request.
2. Resolve repository + immutable commit SHA.
3. Classify the source as trusted studio code or untrusted contribution code.
4. Load policy from the Nymrel control plane and load the repository CI manifest from the appropriate trusted source.
5. Build a deterministic plan with `buildCiPlan()`.
6. Materialize a clean checkout/worktree for the exact SHA.
7. Dispatch jobs:
   - trusted lane: Nymrel Remote device call(s), normally `start_process`, on an approved CI workspace;
   - untrusted lane: disposable sandbox worker only.
8. Capture bounded stdout/stderr, exit code, duration, manifest hash, plan hash, runner identity, and artifact digests.
9. Append a Nymrel proof/audit receipt.
10. Publish commit status immediately; once a Nymrel GitHub App is installed with check-write permission, publish rich GitHub check runs and annotations.

## GitHub independence boundary

Nymrel CI should use GitHub as source control and an optional status surface, not as the compute scheduler. If GitHub-hosted Actions capacity is exhausted, Nymrel jobs continue to execute because dispatch and compute live on Nymrel infrastructure.

GitHub webhooks and status/check publishing can fail independently; the Nymrel receipt remains authoritative for whether the job actually executed. A GitHub status is a projection of that evidence, not the evidence itself.

## Phased activation

### Phase 0 — contract and local parity

- deterministic manifest and plan validation;
- map existing repo one-command checks into manifests;
- run on trusted studio branches through Nymrel Remote/manual orchestration;
- retain GitHub Actions where available as a comparison signal, not the sole execution path.

### Phase 1 — autonomous trusted CI

- webhook ingestion for approved repositories;
- durable deduplicated queue keyed by repo/SHA/job;
- trusted-runner scheduling;
- bounded logs and artifact digests;
- commit status publishing;
- retry/cancel semantics and concurrency limits.

### Phase 2 — GitHub App checks

- install a Nymrel GitHub App with least-privilege repository metadata/content read plus checks write;
- create/update rich check runs and annotations;
- expose rerun/cancel actions without routing compute through GitHub Actions.

### Phase 3 — disposable public-PR workers

- one-job ephemeral workers;
- no inherited workstation secrets;
- restricted egress and filesystem;
- teardown verification before worker reuse;
- provenance/SBOM and artifact retention policy.

### Phase 4 — studio-wide migration

- migrate required checks repository by repository;
- preserve check names where branch protection depends on them;
- keep deployment/publish jobs separately gated from validation;
- add dashboarding for queue depth, pass rate, duration, flake/retry rate, and runner health.

## Activation gate

Do not call Nymrel CI a full GitHub Actions replacement until all of these are demonstrated with live evidence:

- webhook or scheduler trigger reaches the Nymrel queue;
- an immutable commit is checked out in a clean workspace;
- a real repository validation command executes and returns bounded evidence;
- duplicate delivery cannot cause duplicate execution;
- a failed job is distinguishable from infrastructure failure;
- GitHub status/check projection is proven, or the operator is explicitly using Nymrel receipts as the temporary source of truth;
- untrusted code cannot reach persistent studio machines.
