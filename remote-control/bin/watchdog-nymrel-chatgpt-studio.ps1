# Source for the existing JalenPC ChatGPTStudio watchdog task. This script does
# not register a task or manage credentials; deploy to its existing action path.
$ErrorActionPreference = 'Stop'

$taskName = 'Nymrel Remote ChatGPT Studio'
$supervisorScript = 'C:\Users\johns\AppData\Local\Nymrel\ChatGPTStudio\app\bin\nymrel-remote-supervisor.js'
$agentScript = 'C:\Users\johns\AppData\Local\Nymrel\ChatGPTStudio\app\bin\nymrel-remote-agent.js'
$statusPath = 'C:\Users\johns\AppData\Local\Nymrel\ChatGPTStudio\watchdog-status.json'

function Test-ExactScriptArgument([string]$commandLine, [string]$scriptPath) {
    # Delimit the whole argument: another installation or a .bak suffix is not
    # the supervised agent, even when its command line contains a similar name.
    return $commandLine -match ('(?:^|\s)"?' + [regex]::Escape($scriptPath) + '"?(?=\s|$)')
}

function Get-RemoteProcessSnapshot([object[]]$processes) {
    $supervisors = @($processes | Where-Object {
        Test-ExactScriptArgument $_.CommandLine $supervisorScript
    })
    $children = @()
    if ($supervisors.Count -eq 1) {
        $children = @($processes | Where-Object {
            $_.ParentProcessId -eq $supervisors[0].ProcessId -and
            (Test-ExactScriptArgument $_.CommandLine $agentScript)
        })
    }
    return [pscustomobject]@{
        supervisor_count = $supervisors.Count
        child_count = $children.Count
    }
}

function Get-RemoteHealthSnapshot {
    $processes = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction Stop)
    return Get-RemoteProcessSnapshot $processes
}

function Write-WatchdogStatus([string]$state, [string]$action, [int]$count, [int]$childCount) {
    $status = [ordered]@{
        observed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        state = $state
        action = $action
        supervisor_count = $count
        child_count = $childCount
    }
    $temporaryPath = "$statusPath.tmp"
    [System.IO.File]::WriteAllText(
        $temporaryPath,
        ($status | ConvertTo-Json -Compress),
        [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryPath -Destination $statusPath -Force
}

function Invoke-RemoteWatchdog {
    $action = 'none'
    try {
        $snapshot = Get-RemoteHealthSnapshot
        if ($snapshot.supervisor_count -eq 0) {
            Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
            $action = 'started_existing_task'
            Start-Sleep -Seconds 5
            $snapshot = Get-RemoteHealthSnapshot
        }

        if ($snapshot.supervisor_count -eq 1 -and $snapshot.child_count -eq 0) {
            # The supervisor owns child recovery (maximum default backoff 30s).
            # Allow one backoff window plus startup time; never replace a live
            # supervisor or start a second copy because its child is absent.
            Start-Sleep -Seconds 35
            $snapshot = Get-RemoteHealthSnapshot
        }

        if ($snapshot.supervisor_count -gt 1) {
            Write-WatchdogStatus 'duplicate_supervisors' $action $snapshot.supervisor_count $snapshot.child_count
            return 1
        }
        if ($snapshot.supervisor_count -eq 0) {
            $failureAction = if ($action -eq 'started_existing_task') { 'start_did_not_create_supervisor' } else { 'none' }
            Write-WatchdogStatus 'failed' $failureAction 0 0
            return 1
        }
        if ($snapshot.child_count -ne 1) {
            $state = if ($snapshot.child_count -eq 0) { 'waiting_for_agent' } else { 'duplicate_agents' }
            Write-WatchdogStatus $state $action 1 $snapshot.child_count
            return 1
        }

        $state = if ($action -eq 'started_existing_task') { 'recovered' } else { 'healthy' }
        Write-WatchdogStatus $state $action 1 1
        return 0
    } catch {
        try {
            Write-WatchdogStatus 'failed' 'watchdog_exception' 0 0
        } catch {
            # Preserve the original failure code if status storage is unavailable.
        }
        return 1
    }
}

# Dot-sourcing exposes pure process classification and allows tests to replace
# observation/action functions without inspecting or changing any live service.
if ($MyInvocation.InvocationName -ne '.') {
    exit (Invoke-RemoteWatchdog)
}
