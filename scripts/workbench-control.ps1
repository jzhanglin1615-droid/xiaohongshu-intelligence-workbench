[CmdletBinding()]
param(
  [ValidateSet("Start", "Stop", "Restart", "Status")]
  [string]$Action = "Start",
  [ValidateRange(1024, 65535)]
  [int]$Port = 4173,
  [switch]$OpenBrowser,
  [ValidateRange(3, 120)]
  [int]$StartupTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$serverPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "apps/workbench-ui/server.mjs"))
$controlRoot = Join-Path $projectRoot "state/service-control"
$logRoot = Join-Path $controlRoot "logs"
$receiptRoot = Join-Path $controlRoot "receipts"
$statePath = Join-Path $controlRoot "workbench-service.json"
$healthUrl = "http://127.0.0.1:$Port/api/health"
$workbenchUrl = "http://127.0.0.1:$Port/#overview"

function Ensure-ControlDirectories {
  New-Item -ItemType Directory -Force -Path $controlRoot, $logRoot, $receiptRoot | Out-Null
}

function Write-JsonAtomic([string]$Path, [object]$Value) {
  $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporaryPath -Encoding utf8
  Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Write-Receipt([string]$Operation, [string]$Status, [hashtable]$Details) {
  Ensure-ControlDirectories
  $now = [DateTimeOffset]::UtcNow
  $receipt = [ordered]@{
    schemaVersion = 1
    receiptId = "service-$($now.ToString('yyyyMMddTHHmmssfffZ'))-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    operation = $Operation
    status = $Status
    generatedAt = $now.ToString("o")
    projectRoot = $projectRoot
    port = $Port
    details = $Details
  }
  $receiptPath = Join-Path $receiptRoot "$($receipt.receiptId).json"
  Write-JsonAtomic -Path $receiptPath -Value $receipt
  return [pscustomobject]@{ receipt = $receipt; receiptPath = $receiptPath }
}

function Read-ControlState {
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json }
  catch { return $null }
}

function Get-Health {
  try {
    $result = Invoke-RestMethod -Method Get -Uri $healthUrl -TimeoutSec 2
    if ($result.status -eq "READY" -and $result.service -eq "xhs-intelligence-workbench") { return $result }
  } catch { }
  return $null
}

function Get-OwnedProcess([int]$ProcessId) {
  if ($ProcessId -le 0) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $null }
  $normalizedCommand = ([string]$process.CommandLine).Replace("\", "/")
  $absoluteServerPath = $serverPath.Replace("\", "/")
  $relativeServerPath = "apps/workbench-ui/server.mjs"
  $hasAbsolutePath = $normalizedCommand.IndexOf($absoluteServerPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  $hasRelativePath = $normalizedCommand.IndexOf($relativeServerPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  if (-not $hasAbsolutePath -and -not $hasRelativePath) { return $null }
  if ($hasRelativePath -and -not $hasAbsolutePath) {
    $health = Get-Health
    if ($null -eq $health -or [int]$health.pid -ne $ProcessId) { return $null }
  }
  return $process
}

function Show-Result([object]$Value) {
  $Value | ConvertTo-Json -Depth 12
}

function Get-ServiceStatus {
  $state = Read-ControlState
  $health = Get-Health
  $owned = $null
  if ($null -ne $state -and $null -ne $state.pid) { $owned = Get-OwnedProcess -ProcessId ([int]$state.pid) }
  $status = if ($null -ne $health) { "RUNNING" } elseif ($null -ne $owned) { "STARTING_OR_UNHEALTHY" } else { "STOPPED" }
  return [ordered]@{
    status = $status
    service = "xhs-intelligence-workbench"
    port = $Port
    url = $workbenchUrl
    pid = if ($null -ne $health) { [int]$health.pid } elseif ($null -ne $state) { $state.pid } else { $null }
    startedAt = if ($null -ne $health) { $health.startedAt } elseif ($null -ne $state) { $state.startedAt } else { $null }
    statePath = $statePath
    health = $health
  }
}

function Start-Workbench {
  Ensure-ControlDirectories
  $existingHealth = Get-Health
  if ($null -ne $existingHealth) {
    $existingState = [ordered]@{
      schemaVersion = 1
      service = "xhs-intelligence-workbench"
      pid = [int]$existingHealth.pid
      port = $Port
      url = $workbenchUrl
      startedAt = $existingHealth.startedAt
      observedAt = [DateTimeOffset]::UtcNow.ToString("o")
      serverPath = $serverPath
      ownership = "HEALTH_VERIFIED"
    }
    Write-JsonAtomic -Path $statePath -Value $existingState
    $written = Write-Receipt -Operation "START" -Status "ALREADY_RUNNING" -Details @{ pid = [int]$existingHealth.pid; healthUrl = $healthUrl }
    if ($OpenBrowser) { Start-Process $workbenchUrl | Out-Null }
    Show-Result ([ordered]@{ status = "ALREADY_RUNNING"; pid = [int]$existingHealth.pid; url = $workbenchUrl; receiptPath = $written.receiptPath })
    return
  }

  $portableNode = Join-Path $projectRoot "runtime/node.exe"
  $nodeCommand = if (Test-Path -LiteralPath $portableNode -PathType Leaf) { $portableNode } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
  if (-not $nodeCommand) { throw "NODE_NOT_FOUND: use the Windows portable release, or install Node.js 24 or newer." }
  $nodeVersionText = (& $nodeCommand --version).Trim().TrimStart("v")
  $nodeMajor = [int]($nodeVersionText.Split(".")[0])
  if ($nodeMajor -lt 24) { throw "NODE_VERSION_UNSUPPORTED: found $nodeVersionText, require 24 or newer." }

  $setupScript = Join-Path $projectRoot "scripts/setup-local.mjs"
  & $nodeCommand $setupScript | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "LOCAL_SETUP_FAILED: could not initialize empty local data." }

  $timestamp = [DateTimeOffset]::UtcNow.ToString("yyyyMMdd-HHmmssfff")
  $stdoutPath = Join-Path $logRoot "workbench-$timestamp.out.log"
  $stderrPath = Join-Path $logRoot "workbench-$timestamp.err.log"
  $previousPort = [Environment]::GetEnvironmentVariable("XHS_WORKBENCH_PORT", "Process")
  try {
    [Environment]::SetEnvironmentVariable("XHS_WORKBENCH_PORT", [string]$Port, "Process")
    $process = Start-Process -FilePath $nodeCommand `
      -ArgumentList @("--use-env-proxy", "--experimental-strip-types", $serverPath) `
      -WorkingDirectory $projectRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -PassThru
  } finally {
    [Environment]::SetEnvironmentVariable("XHS_WORKBENCH_PORT", $previousPort, "Process")
  }

  $startedAt = [DateTimeOffset]::UtcNow.ToString("o")
  Write-JsonAtomic -Path $statePath -Value ([ordered]@{
    schemaVersion = 1
    service = "xhs-intelligence-workbench"
    pid = $process.Id
    port = $Port
    url = $workbenchUrl
    startedAt = $startedAt
    observedAt = $startedAt
    serverPath = $serverPath
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    ownership = "STARTED_BY_CONTROL_SCRIPT"
  })

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($StartupTimeoutSeconds)
  $health = $null
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    if ($process.HasExited) { break }
    $health = Get-Health
    if ($null -ne $health -and [int]$health.pid -eq $process.Id) { break }
    Start-Sleep -Milliseconds 250
  }
  if ($null -eq $health -or [int]$health.pid -ne $process.Id) {
    $exitCode = if ($process.HasExited) { $process.ExitCode } else { $null }
    $written = Write-Receipt -Operation "START" -Status "FAILED" -Details @{ pid = $process.Id; exitCode = $exitCode; stdoutPath = $stdoutPath; stderrPath = $stderrPath }
    throw "WORKBENCH_START_FAILED: health check did not become ready. Receipt: $($written.receiptPath)"
  }

  $readyState = Read-ControlState
  $readyState.startedAt = $health.startedAt
  $readyState.observedAt = [DateTimeOffset]::UtcNow.ToString("o")
  Write-JsonAtomic -Path $statePath -Value $readyState
  $written = Write-Receipt -Operation "START" -Status "SUCCEEDED" -Details @{ pid = $process.Id; healthUrl = $healthUrl; stdoutPath = $stdoutPath; stderrPath = $stderrPath }
  if ($OpenBrowser) { Start-Process $workbenchUrl | Out-Null }
  Show-Result ([ordered]@{ status = "RUNNING"; pid = $process.Id; url = $workbenchUrl; statePath = $statePath; receiptPath = $written.receiptPath })
}

function Stop-Workbench {
  Ensure-ControlDirectories
  $state = Read-ControlState
  if ($null -eq $state -or $null -eq $state.pid) {
    $written = Write-Receipt -Operation "STOP" -Status "ALREADY_STOPPED" -Details @{}
    Show-Result ([ordered]@{ status = "ALREADY_STOPPED"; receiptPath = $written.receiptPath })
    return
  }
  $processId = [int]$state.pid
  $owned = Get-OwnedProcess -ProcessId $processId
  if ($null -eq $owned) {
    $written = Write-Receipt -Operation "STOP" -Status "STALE_STATE_CLEARED" -Details @{ recordedPid = $processId }
    Move-Item -LiteralPath $statePath -Destination "$statePath.stale-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmssfff'))" -Force
    Show-Result ([ordered]@{ status = "STOPPED"; stalePid = $processId; receiptPath = $written.receiptPath })
    return
  }
  Stop-Process -Id $processId
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
  while ([DateTimeOffset]::UtcNow -lt $deadline -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 200 }
  if (Get-Process -Id $processId -ErrorAction SilentlyContinue) { throw "WORKBENCH_STOP_TIMEOUT: process $processId is still running." }
  $stoppedStatePath = "$statePath.stopped-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmssfff'))"
  Move-Item -LiteralPath $statePath -Destination $stoppedStatePath -Force
  $written = Write-Receipt -Operation "STOP" -Status "SUCCEEDED" -Details @{ pid = $processId; archivedStatePath = $stoppedStatePath }
  Show-Result ([ordered]@{ status = "STOPPED"; pid = $processId; receiptPath = $written.receiptPath })
}

switch ($Action) {
  "Start" { Start-Workbench }
  "Stop" { Stop-Workbench }
  "Restart" { Stop-Workbench; Start-Workbench }
  "Status" {
    $status = Get-ServiceStatus
    $written = Write-Receipt -Operation "STATUS" -Status $status.status -Details @{ pid = $status.pid; url = $status.url }
    $status.receiptPath = $written.receiptPath
    Show-Result $status
  }
}
