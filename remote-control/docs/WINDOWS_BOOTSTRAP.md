# Windows bootstrap

Use this path to install the native Nymrel Remote agent on an owned Windows computer without installing Desktop Commander or running `npx`.

## Requirements

- Windows PowerShell 5.1 or newer.
- Node.js 22 or 24 available as `node.exe` on `PATH`.
- Outbound HTTPS access to GitHub and the configured Nymrel Remote origin.
- Permission to create a limited, current-user Task Scheduler task.

## JalenPC production bootstrap

Open PowerShell as the normal `johns` user. Administrator elevation is not required. Download the reviewed script to a file before executing it:

```powershell
$bootstrap = Join-Path $env:TEMP 'bootstrap-nymrel-remote-windows.ps1'
Invoke-WebRequest -UseBasicParsing `
  -Uri 'https://raw.githubusercontent.com/nymrel/nymrel-mcp-hub/main/remote-control/bin/bootstrap-nymrel-remote-windows.ps1' `
  -OutFile $bootstrap
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $bootstrap
```

The bootstrap resolves `main` to an immutable Git commit, downloads that source archive, installs it below `%LOCALAPPDATA%\Nymrel\Remote\app`, and creates a limited `Nymrel Remote` task for future logons. It pins only nonsecret device configuration in the local launcher. The installer fails closed if Task Scheduler accepts the start request but the supervisor does not remain running. No control-plane key, bootstrap credential, OAuth token, or device token is embedded in the script or scheduled-task command.

The default allowed root is the current user's profile directory. To narrow it:

```powershell
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File $bootstrap `
  -AllowedDirectory 'C:\Users\johns\Desktop'
```

To exclude a private path inside an allowed root, pass one or more absolute paths. The native agent also blocks common credential filenames and directories. A later bootstrap run without `-DeniedReadPath` retains that instance's saved exclusions. To clear them, invoke the script directly from PowerShell with `& $bootstrap -DeniedReadPath @()` and the same instance options.

```powershell
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File $bootstrap `
  -AllowedDirectory 'C:\Users\johns\Desktop' `
  -DeniedReadPath 'C:\Users\johns\Desktop\private'
```

## Separate ChatGPT Studio device

Keep the existing `Nymrel Remote` installation intact when it serves other clients. A second instance has its own runtime directory, device credential, log, task, and pinned allowed roots. Use a reviewed folder path that does not contain credentials or private browser data:

```powershell
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File $bootstrap `
  -Ref '<reviewed-40-character-commit-sha>' `
  -InstanceName ChatGPTStudio `
  -TaskName 'Nymrel Remote ChatGPT Studio' `
  -DeviceName 'JalenPC-ChatGPTStudio' `
  -AllowedDirectory '<reviewed-studio-folder>'
```

This uses `%LOCALAPPDATA%\Nymrel\ChatGPTStudio`. It does not overwrite the first instance's User environment variables. The launcher must carry its own explicit server URL, device file, allowed directories, and working directory. Pair the new code with a token for a **separate tenant**, then map only the operator's ChatGPT OAuth subject to that tenant. Pairing under the existing broad-root device's tenant would let ChatGPT list that device too.

The bootstrap refuses a `ChatGPTStudio` install when `-AllowedDirectory` is omitted, names the whole user profile or an ancestor such as `C:\Users`, or traverses a linked directory. This check runs before any source download or scheduled-task change. It still cannot decide whether a chosen subfolder contains sensitive files, so review every selected root before pairing.

Add `-PreflightOnly` to the command above to validate the server URL, instance values, and selected roots without downloading source or changing the scheduled task. A successful check prints `NYMREL_REMOTE_BOOTSTRAP_PREFLIGHT=OK`; it does not pair or start a device.

For a first, inspectable root, `scripts/stage-chatgpt-studio-share.mjs` can copy only exact `.md` and `.txt` files named in a private manifest into a **new** folder. For example, save a JSON manifest outside Git with `{"version":1,"files":[{"source":"C:\\path\\to\\reviewed-file.md","target":"studio/reviewed-file.md"}]}`, then run `node scripts/stage-chatgpt-studio-share.mjs --manifest <absolute-json-path> --output <new-absolute-share-directory>`. It refuses an existing destination, linked source or output parent, unsafe target names, and oversized files. The resulting `INDEX.md` lists only names, sizes, and hashes. Review every staged file before using that folder as `-AllowedDirectory`; this utility does not scan file contents for secrets, keep them in sync, pair a device, or authorize ChatGPT. Additional project roots can be considered after the first narrow roundtrip.

To remove just this instance's autostart, run its installer with both `-InstanceName ChatGPTStudio` and `-TaskName 'Nymrel Remote ChatGPT Studio'`, plus `-Uninstall`. Device credentials and logs remain for review.

A new device prints one machine-readable line:

```text
NYMREL_REMOTE_PAIRING_CODE=ABCD-EFGH
```

Approve only that short-lived code through an authenticated Nymrel Remote operator path. Do not copy the device credential file or any service secret into chat, tickets, logs, or source control.

An already paired installation prints:

```text
NYMREL_REMOTE_STATUS=ONLINE
```

## Local files

```text
%LOCALAPPDATA%\Nymrel\Remote\app          installed source
%LOCALAPPDATA%\Nymrel\Remote\device.json paired device credential
%LOCALAPPDATA%\Nymrel\Remote\run.ps1     allowlisted nonsecret launcher
%LOCALAPPDATA%\Nymrel\Remote\run.cmd     Task Scheduler entrypoint
%LOCALAPPDATA%\Nymrel\Remote\supervisor.log
%LOCALAPPDATA%\Nymrel\Remote\supervisor.log.1   previous rotation
%LOCALAPPDATA%\Nymrel\Remote\launcher-stderr.log raw Node stderr from the last launch; empty unless the supervisor failed before its log opened
```

The supervisor restarts the native device agent with bounded exponential backoff. Native stderr remains diagnostic output in the launcher, so transient event-channel reconnect warnings are logged without Windows PowerShell terminating the long-running supervisor. The controlled computer accepts no inbound connection; the agent connects outbound to the Nymrel Remote control plane.

The supervisor writes `supervisor.log` itself as UTF-8 with one ISO-8601 UTC timestamp and stream tag (`[supervisor]`, `[agent]`, `[agent:err]`) per line, and rotates it once to `supervisor.log.1` when it passes 5 MB. Read it with any text tool:

```powershell
Get-Content "$env:LOCALAPPDATA\Nymrel\Remote\supervisor.log" -Tail 50 -Wait
```

A run of `Event channel lost; durable queue reconciliation remains active` lines is the advisory SSE doorbell reconnecting after the hosting edge closed the stream. Calls still execute through the durable queue on the heartbeat/reconciliation cycle; use the timestamps to judge whether reconnects are rare or continuous before treating them as an outage.

## Update or repair

Run the same bootstrap command again. The installer resolves the selected ref to a current immutable commit, stages the replacement, preserves `device.json`, and leaves the previous app directory as a local rollback copy until the next successful update.

To install an exact reviewed commit instead of `main`:

```powershell
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File $bootstrap `
  -Ref '<40-character-commit-sha>'
```

## Uninstall autostart

From the installed package directory:

```powershell
& "$env:LOCALAPPDATA\Nymrel\Remote\app\bin\install-nymrel-remote-windows.ps1" -Uninstall
```

This removes the Task Scheduler task and launchers but preserves device credentials and logs for explicit operator review or manual deletion.
