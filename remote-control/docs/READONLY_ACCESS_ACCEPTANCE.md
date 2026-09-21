# Nymrel Remote: prove a read-only device roundtrip

This additive operator CLI continues the PR #33 release candidate. It does not install an app, provision OAuth, change a device, or replace the existing production cutover probe.

## What it proves

The CLI first validates a private nonsecret test plan. It pins the expected OAuth issuer and readonly resource, then calls the existing `checkProductionCutover` in strict readonly mode. Only after those public checks succeed does it send the operator-provided access token to the exact readonly MCP endpoint.

The credentialed sequence is bounded and read-only:

1. Require exactly the six known readonly tools and their readonly/non-destructive annotations.
2. Require the exact authenticated device ID and name to be online and MCP-ready. A heartbeat or ambiguous device name is insufficient.
3. Ask `get_file_info` about the explicitly chosen denied ancestor. Require the native allowed-directory refusal; a generic error, missing path, authentication failure, timeout, or pending call does not pass. This reads no directory listing or file body.
4. Read at most 100 lines of an approved nonsecret README, AGENTS, CLAUDE or presence Markdown file below the selected project root. Require the returned canonical path, line window and SHA-256 to match the operator's independently computed expectation.

The output contains only fixed check names, booleans, timestamp and fixed failure codes. It omits the token, issuer, device identity, paths, file contents and file digest. No real credential is used in the fixture tests.

`roundtrip_pass` means this operator CLI successfully tested one device, one denied ancestor and one known file window. It is **not** ChatGPT attachment, OAuth refresh proof, independent execution attestation, a certification of all filesystem roots, or production-release approval. Those report fields deliberately remain false.

## Prepare on an authorized workstation

Use the exact reviewed source and the existing PR #33 deployment runbook. Do not run this against an unapproved host or provide a static/bootstrap token as a substitute for a real readonly OAuth grant.

Copy `readonly-access-plan.example.json` to a private working location outside version control. Fill the actual expected issuer, authenticated device ID, approved project root, known nonsecret probe path and an existing denied ancestor. Do not guess the device ID or paired tenant. The example intentionally fails validation until completed and approved.

Set `lineCount` to 1–100. The expected digest is SHA-256 over the UTF-8 string formed by splitting the file on CRLF/LF, taking the first `lineCount` entries, and joining them with LF. This is a **line-window digest**, not necessarily the raw-file digest. No trailing newline is added beyond entries already present in that window.

For example, on the operator's own machine, this command prints only that digest:

```sh
node --input-type=module -e "import fs from 'node:fs'; import {createHash} from 'node:crypto'; const s=fs.readFileSync(process.argv[1],'utf8').split(/\r?\n/).slice(0,Number(process.argv[2])).join('\n'); console.log(createHash('sha256').update(s).digest('hex'))" /approved/project/README.md 40
```

Set `nonsecretProbeApproved: true` only after confirming that the selected file/window is safe. Keep `hasPredefinedClient: false` unless an actual client is registered; this is evidence supplied to the existing public probe, not a registration action.

The current shell process must receive `NYMREL_REMOTE_READONLY_ACCESS_TOKEN` through the operator's approved secret-injection mechanism. Do not place it in command arguments, GitHub, an exported receipt, chat, or a checked-in environment file. The CLI deletes the inherited environment entry before running; the token still exists in process memory and this is not secure memory erasure.

```sh
node scripts/verify-readonly-access.mjs --plan /private/readonly-access-plan.json
```

Exit status: 0 for the narrow roundtrip pass, 1 for blocked acceptance, 2 for invalid invocation/unreadable plan. There are no retries, scheduled tasks or automatic durable-call resubmissions. A queued/approval-required read stays blocked; no hidden polling or privilege escalation is attempted.

## Resource and privacy bounds

HTTPS is required. URL userinfo, query strings, fragments, noncanonical base URLs, literal IPs, local/internal hostnames and non-443 ports are refused. Requests are limited to the two explicitly configured origins. Real credentials can be sent only by POST to the exact readonly resource. HTTP redirects are refused, each response is capped at 256 KiB, and each run has a 24-request and 90-second budget. The existing public cutover check may send its fixed invalid-token fixture, never the operator's real token.

These transport controls are **origin pinning, not a network/DNS sandbox**. Use only approved publicly hosted endpoints. The operator plan is trusted local input, not an untrusted web submission. The device agent remains the filesystem authority. Local settings, symlinks, other permitted roots and other clients still need their own review.

Only `get_file_info` is requested outside the project root. If the server mistakenly returns metadata, the test stops before requesting the probe file and does not print that metadata. No credential file is read, no directory is enumerated, and no write/process tool is called.

## Validation and activation status

Implementation baseline: `ae97fe775c5e4ddf33583108f510c23dcdbd2a9e`, PR #33. New files only; the server, auth policy, config, catalog, native backend and CI are unchanged.

Local Node 22.16.0 fixture suite: 22 tests passing. It exercises success, origin/token separation, wrong issuer, missing route, auth rejection, tool-catalog mismatch, device mismatch/offline state, exact root-denial handling, queued calls, path/window/hash mismatch, output redaction, response limits, request budget and CLI input refusal. This is synthetic fixture evidence, not a JalenPC or external OAuth run. Full repository validation and independent review must be recorded against the final submitted commit separately.

During this continuation, Nymrel Remote app discovery returned no matching app. The authorized Supabase connection exposed only an unrelated inactive project, not an existing Nymrel OAuth provider. No unrelated project was restored or repurposed, and no paid resource, identity, credential or new auth grant was created. The historical private-connection receipt is not substituted for a current tool roundtrip.

## Remaining real acceptance

Configure the approved issuer/client path and explicit subject-to-tenant admission, verify the local roots, deploy the reviewed candidate with rollback available, run the strict public probe and this operator test, then complete ChatGPT web sign-in/tool scan and a real ChatGPT file read. Repeat an allowed read after access-token expiration to test actual refresh. Keep the exact deployment/source and private acceptance receipts; do not relabel CLI proof as ChatGPT proof.

Custom MCP developer-mode access for Pro remains a read/fetch web path in the official documentation checked September 20, 2026. iOS distribution is separate; the CLI does not change that boundary.

References:
- Existing architecture and activation gates: `CHATGPT_PRO_READONLY.md`, `RAILWAY_DEPLOYMENT.md` and PR #33.
- OpenAI developer mode: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
