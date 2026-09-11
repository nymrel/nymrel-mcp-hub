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
```

The supervisor restarts the native device agent with bounded exponential backoff. Native stderr remains diagnostic output in the launcher, so transient event-channel reconnect warnings are logged without Windows PowerShell terminating the long-running supervisor. The controlled computer accepts no inbound connection; the agent connects outbound to the Nymrel Remote control plane.

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
