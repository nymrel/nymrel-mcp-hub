$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../bin/watchdog-nymrel-chatgpt-studio.ps1')

function Assert-Equal($actual, $expected, [string]$label) {
    if ($actual -ne $expected) { throw "$label expected '$expected', got '$actual'" }
}

function New-FakeProcess([int]$processId, [int]$parentId, [string]$path) {
    return [pscustomobject]@{ ProcessId = $processId; ParentProcessId = $parentId; CommandLine = ('"C:\node.exe" "{0}"' -f $path) }
}

$supervisor = New-FakeProcess 100 90 $supervisorScript
$agent = New-FakeProcess 200 100 $agentScript
$foreignParent = New-FakeProcess 201 999 $agentScript
$otherInstall = New-FakeProcess 202 100 ($agentScript.Replace('ChatGPTStudio', 'Remote'))
$suffix = New-FakeProcess 203 100 ($agentScript + '.bak')
Assert-Equal (Get-RemoteProcessSnapshot @($supervisor, $agent)).child_count 1 'Exact parent and script'
Assert-Equal (Get-RemoteProcessSnapshot @($supervisor, $foreignParent, $otherInstall, $suffix)).child_count 0 'Reject foreign parent, installation and suffix'
Assert-Equal (Test-ExactScriptArgument ('C:\node.exe ' + $agentScript) $agentScript) $true 'Unquoted script'

# These overrides are local to this test process. No CIM, task action, sleeping,
# or live status-file write occurs in any branch below.
function Get-RemoteHealthSnapshot {
    $result = $script:samples[$script:sampleIndex]
    $script:sampleIndex += 1
    return $result
}
function Start-ScheduledTask { param($TaskName, $ErrorAction); $script:starts += 1 }
function Start-Sleep { param($Seconds); $script:waits += @($Seconds) }
function Write-WatchdogStatus { param($state, $action, $count, $childCount); $script:receipt = @($state, $action, $count, $childCount) }
function New-Snapshot([int]$supervisors, [int]$children) {
    return [pscustomobject]@{ supervisor_count = $supervisors; child_count = $children }
}
function Test-Branch($samples, $state, $code, $starts, $waits, $action) {
    $script:samples = @($samples)
    $script:sampleIndex = 0
    $script:starts = 0
    $script:waits = @()
    $script:receipt = $null
    Assert-Equal (Invoke-RemoteWatchdog) $code "$state exit"
    Assert-Equal $script:receipt[0] $state "$state receipt"
    Assert-Equal $script:receipt[1] $action "$state action"
    Assert-Equal $script:starts $starts "$state starts"
    Assert-Equal ($script:waits -join ',') $waits "$state bounded waits"
    Assert-Equal $script:sampleIndex $script:samples.Count "$state observation count"
}

Test-Branch @((New-Snapshot 1 1)) 'healthy' 0 0 '' 'none'
Test-Branch @((New-Snapshot 1 0), (New-Snapshot 1 0)) 'waiting_for_agent' 1 0 '35' 'none'
Test-Branch @((New-Snapshot 1 0), (New-Snapshot 1 1)) 'healthy' 0 0 '35' 'none'
Test-Branch @((New-Snapshot 2 0)) 'duplicate_supervisors' 1 0 '' 'none'
Test-Branch @((New-Snapshot 1 2)) 'duplicate_agents' 1 0 '' 'none'
Test-Branch @((New-Snapshot 0 0), (New-Snapshot 1 1)) 'recovered' 0 1 '5' 'started_existing_task'
Test-Branch @((New-Snapshot 0 0), (New-Snapshot 1 0), (New-Snapshot 1 1)) 'recovered' 0 1 '5,35' 'started_existing_task'
Test-Branch @((New-Snapshot 0 0), (New-Snapshot 0 0)) 'failed' 1 1 '5' 'start_did_not_create_supervisor'
Test-Branch @((New-Snapshot 1 0), (New-Snapshot 0 0)) 'failed' 1 0 '35' 'none'
Write-Output 'PASS: exact process identity and nine watchdog branches; no live service actions'
