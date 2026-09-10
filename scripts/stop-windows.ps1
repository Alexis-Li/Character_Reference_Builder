[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 3210
)

$ErrorActionPreference = "Stop"
$repoRoot = (Get-Item -LiteralPath (Join-Path $PSScriptRoot "..")).FullName
$runtimeDirectory = Join-Path $repoRoot "data\runtime"
$statePath = Join-Path $runtimeDirectory "server-$Port.json"

if (-not (Test-Path -LiteralPath $statePath)) {
  Write-Host "No managed Character Reference Builder server is recorded for port $Port."
  exit 0
}

try {
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $hostPid = [int]$state.hostPid
  $process = Get-Process -Id $hostPid -ErrorAction SilentlyContinue

  if (-not $process) {
    Remove-Item -LiteralPath $statePath -Force
    Write-Host "The managed server was already stopped."
    exit 0
  }

  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $hostPid"
  $commandLine = [string]$processInfo.CommandLine
  $expectedScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "server-host.ps1"))
  if ($commandLine -notlike "*$expectedScript*") {
    Write-Error "Refusing to stop process $hostPid because it is not the recorded project server."
    exit 2
  }

  & taskkill.exe /PID $hostPid /T /F | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Windows could not stop the managed server process tree (exit code $LASTEXITCODE)."
    exit $LASTEXITCODE
  }

  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline -and (Get-Process -Id $hostPid -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 250
  }

  Remove-Item -LiteralPath $statePath -Force
  Write-Host "Character Reference Builder stopped on port $Port."
  exit 0
}
catch {
  Write-Error $_.Exception.Message
  exit 1
}
