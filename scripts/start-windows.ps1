[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 3210
)

$ErrorActionPreference = "Stop"
$repoRoot = (Get-Item -LiteralPath (Join-Path $PSScriptRoot "..")).FullName
$runtimeDirectory = Join-Path $repoRoot "data\runtime"
$statePath = Join-Path $runtimeDirectory "server-$Port.json"
$hostScript = Join-Path $PSScriptRoot "server-host.ps1"
$url = "http://127.0.0.1:$Port"

function Get-ListeningProcessId {
  try {
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($connection) {
      return [int]$connection.OwningProcess
    }
  }
  catch {
    $line = netstat -ano -p TCP | Select-String -Pattern (":$Port\s+\S+\s+LISTENING\s+(\d+)$") | Select-Object -First 1
    if ($line -and $line.Matches.Count -gt 0) {
      return [int]$line.Matches[0].Groups[1].Value
    }
  }
  return $null
}

function Test-ServerReady {
  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -lt 500
  }
  catch {
    return $false
  }
}

function Remove-StateFile {
  if (Test-Path -LiteralPath $statePath) {
    Remove-Item -LiteralPath $statePath -Force
  }
}

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

if (Test-Path -LiteralPath $statePath) {
  try {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $managedProcess = Get-Process -Id ([int]$state.hostPid) -ErrorAction SilentlyContinue
    if ($managedProcess) {
      if (Test-ServerReady) {
        Write-Host "Character Reference Builder is already running at $url"
        Start-Process $url | Out-Null
        exit 0
      }

      Write-Host "A managed server is still starting on port $Port; waiting for it to become ready..."
      $deadline = (Get-Date).AddSeconds(30)
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if (Test-ServerReady) {
          Start-Process $url | Out-Null
          Write-Host "Character Reference Builder is ready at $url"
          exit 0
        }
        if (-not (Get-Process -Id ([int]$state.hostPid) -ErrorAction SilentlyContinue)) {
          break
        }
      }

      Write-Error "The managed server did not become ready. Check data\runtime\server-$Port.err.log."
      exit 1
    }

    Remove-StateFile
  }
  catch {
    Remove-StateFile
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules"))) {
  Write-Error "Dependencies are not installed. Run npm ci, then start again."
  exit 2
}

$portOwner = Get-ListeningProcessId
if ($portOwner) {
  Write-Error "Port $Port is already occupied by process $portOwner. Stop that process or start with another port, for example start-windows.cmd 3211."
  exit 2
}

$hostArguments = @(
  "-NoLogo",
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$hostScript`"",
  "-RepoRoot", "`"$repoRoot`"",
  "-Port", "$Port"
)
$hostProcess = Start-Process -FilePath "powershell.exe" -ArgumentList $hostArguments -WindowStyle Hidden -PassThru
$state = @{
  version = 1
  hostPid = $hostProcess.Id
  port = $Port
  startedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8

$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  if (Test-ServerReady) {
    Write-Host "Character Reference Builder is ready at $url"
    Start-Process $url | Out-Null
    exit 0
  }

  if (-not (Get-Process -Id $hostProcess.Id -ErrorAction SilentlyContinue)) {
    $errorLog = Join-Path $runtimeDirectory "server-$Port.err.log"
    $details = if (Test-Path -LiteralPath $errorLog) { Get-Content -LiteralPath $errorLog -Tail 12 } else { "No server log was written." }
    Remove-StateFile
    Write-Error ("The server stopped before becoming ready.`n" + ($details -join "`n"))
    exit 1
  }
}

Write-Error "The server did not become ready within 45 seconds. Check data\runtime\server-$Port.err.log."
exit 1
