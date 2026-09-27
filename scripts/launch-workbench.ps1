param(
  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$controlScript = Join-Path $PSScriptRoot "workbench-control.ps1"
$appUrl = "http://127.0.0.1:4173/#overview"

$chromeCandidates = @(
  @(
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
)
$chromeExecutable = $chromeCandidates | Select-Object -First 1

if ($VerifyOnly) {
  [pscustomobject]@{
    appUrl = $appUrl
    chromeExecutable = $chromeExecutable
    chromeFound = [bool]$chromeExecutable
  } | ConvertTo-Json -Compress
  exit 0
}

& $controlScript -Action Start | Out-Null

if ($chromeExecutable) {
  Start-Process -FilePath $chromeExecutable -ArgumentList "--app=$appUrl"
} else {
  Start-Process $appUrl
}
