[CmdletBinding()]
param(
  [string]$NodeVersion = "24.19.0",
  [string]$NodeArchive
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "Build requires PowerShell 7 or newer (pwsh) to preserve UTF-8 filenames."
}
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$distRoot = Join-Path $projectRoot "dist"
New-Item -ItemType Directory -Force -Path $distRoot | Out-Null

$archiveName = "node-v$NodeVersion-win-x64.zip"
$releaseBase = "https://nodejs.org/download/release/v$NodeVersion"
$checksumsPath = Join-Path $distRoot "SHASUMS256-v$NodeVersion.txt"
$nodeZipPath = if ($NodeArchive) { [IO.Path]::GetFullPath($NodeArchive) } else { Join-Path $distRoot $archiveName }
if (-not $NodeArchive -and -not (Test-Path -LiteralPath $nodeZipPath -PathType Leaf)) {
  Invoke-WebRequest -Uri "$releaseBase/$archiveName" -OutFile $nodeZipPath -UseBasicParsing
}
if (-not (Test-Path -LiteralPath $nodeZipPath -PathType Leaf)) { throw "Node archive not found: $nodeZipPath" }
Invoke-WebRequest -Uri "$releaseBase/SHASUMS256.txt" -OutFile $checksumsPath -UseBasicParsing
$checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+$([regex]::Escape($archiveName))$" } | Select-Object -First 1
if (-not $checksumLine) { throw "Official checksum for $archiveName was not found." }
$expectedHash = ($checksumLine -split '\s+')[0].ToUpperInvariant()
$actualHash = (Get-FileHash -LiteralPath $nodeZipPath -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) { throw "Node archive SHA256 mismatch. Refusing to package it." }

$stageRoot = Join-Path $distRoot ("stage-" + [guid]::NewGuid().ToString("N"))
$extractRoot = Join-Path $stageRoot "_node-extract"
$packageRoot = Join-Path $stageRoot "小红书内容情报台"
New-Item -ItemType Directory -Force -Path $extractRoot, $packageRoot | Out-Null
try {
  Expand-Archive -LiteralPath $nodeZipPath -DestinationPath $extractRoot
  $nodeRoot = Join-Path $extractRoot "node-v$NodeVersion-win-x64"
  foreach ($name in @("node.exe", "LICENSE")) {
    if (-not (Test-Path -LiteralPath (Join-Path $nodeRoot $name) -PathType Leaf)) { throw "Official Node archive is missing $name." }
  }

  $trackedFiles = @(& git -C $projectRoot -c core.quotePath=false ls-files)
  if ($LASTEXITCODE -ne 0 -or $trackedFiles.Count -eq 0) { throw "A committed Git checkout is required for safe packaging." }
  foreach ($relative in $trackedFiles) {
    if ($relative -match '^(state|artifacts|dist|runtime)/') { throw "Private or generated path entered the release list: $relative" }
    $source = Join-Path $projectRoot $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Tracked file missing: $relative" }
    $destination = Join-Path $packageRoot $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
  }
  $runtimeRoot = Join-Path $packageRoot "runtime"
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  Copy-Item -LiteralPath (Join-Path $nodeRoot "node.exe") -Destination (Join-Path $runtimeRoot "node.exe")
  Copy-Item -LiteralPath (Join-Path $nodeRoot "LICENSE") -Destination (Join-Path $runtimeRoot "NODE-LICENSE.txt")

  $commit = (& git -C $projectRoot rev-parse --short=8 HEAD).Trim()
  $outputPath = Join-Path $distRoot "xiaohongshu-workbench-windows-x64-$commit.zip"
  if (Test-Path -LiteralPath $outputPath) { throw "Release archive already exists: $outputPath" }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $packageRoot,
    $outputPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $true,
    [System.Text.Encoding]::UTF8
  )
  [pscustomobject]@{
    archive = $outputPath
    sha256 = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash
    nodeVersion = $NodeVersion
    trackedFileCount = $trackedFiles.Count
  } | ConvertTo-Json
} finally {
  $verifiedStage = [IO.Path]::GetFullPath($stageRoot)
  $verifiedDist = [IO.Path]::GetFullPath($distRoot).TrimEnd('\') + '\'
  if (-not $verifiedStage.StartsWith($verifiedDist, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe temporary path: $verifiedStage" }
  if (Test-Path -LiteralPath $verifiedStage) { Remove-Item -LiteralPath $verifiedStage -Recurse -Force }
}
