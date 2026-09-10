[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoRoot,
  [ValidateRange(1, 65535)]
  [int]$Port = 3210
)

$ErrorActionPreference = "Stop"
$resolvedRepoRoot = (Get-Item -LiteralPath $RepoRoot).FullName
$mutexName = "Local\CharacterReferenceBuilder.Server.$Port"
$createdNew = $false
$serverMutex = [System.Threading.Mutex]::new($false, $mutexName, [ref]$createdNew)

if (-not $createdNew) {
  Write-Error "A managed Character Reference Builder server is already running on port $Port."
  exit 2
}

$runtimeDirectory = Join-Path $resolvedRepoRoot "data\runtime"
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$standardOutput = Join-Path $runtimeDirectory "server-$Port.out.log"
$standardError = Join-Path $runtimeDirectory "server-$Port.err.log"
$exitCode = 1

try {
  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
  $env:CRB_PORT = "$Port"
  $env:NODE_ENV = "development"
  $serverProcess = Start-Process `
    -FilePath $nodePath `
    -ArgumentList @("server.js") `
    -WorkingDirectory $resolvedRepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $standardOutput `
    -RedirectStandardError $standardError `
    -PassThru

  $serverProcess.WaitForExit()
  $exitCode = $serverProcess.ExitCode
}
catch {
  $message = $_.Exception.Message
  Add-Content -LiteralPath $standardError -Value $message
  $exitCode = 1
}
finally {
  $serverMutex.ReleaseMutex()
  $serverMutex.Dispose()
}

exit $exitCode
