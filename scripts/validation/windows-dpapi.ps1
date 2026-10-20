[CmdletBinding()]
param([switch]$CreateTestUser)
$ErrorActionPreference = 'Stop'
if (-not $CreateTestUser -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'This orchestrator creates a disposable local user. Run only on a fresh GitHub-hosted Windows runner with -CreateTestUser. It refuses daily-use computers.'
}
if (-not $env:CRB_TEMP_ROOT) { throw 'Set CRB_TEMP_ROOT to the project ../.tmp directory.' }
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$parent = [IO.Path]::GetFullPath((Join-Path $env:CRB_TEMP_ROOT 'validation/windows-dpapi'))
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$testRoot = Join-Path $parent ('crb-dpapi-' + [Guid]::NewGuid().ToString('N'))
$userName = 'crbqa' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'windows-credentials.cjs'
$testUser = $null
$process = $null
try {
  & $node $script owner $testRoot
  if ($LASTEXITCODE -ne 0) { throw 'Owner DPAPI setup failed.' }
  $password = ConvertTo-SecureString ('Crb!9' + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force
  $testUser = New-LocalUser -Name $userName -Password $password -AccountExpires (Get-Date).AddHours(1) -Description 'Disposable CRB synthetic DPAPI verification' -UserMayNotChangePassword
  $sid = $testUser.SID.Value
  $usersGroup = Get-LocalGroup -SID 'S-1-5-32-545'
  Add-LocalGroupMember -Group $usersGroup -Member $testUser
  & icacls.exe $testRoot /grant "*${sid}:(OI)(CI)M" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot grant access to synthetic test ciphertext.' }
  $credential = [PSCredential]::new("$env:COMPUTERNAME\$userName", $password)
  # Password stays in a PSCredential, never an argument, environment value or log.
  $arguments = @('"' + $script + '"', 'foreign', '"' + $testRoot + '"')
  $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $repoRoot -Credential $credential -LoadUserProfile -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(90000)) { $process.Kill(); throw 'Foreign-user verification timed out.' }
  if ($process.ExitCode -ne 0) { throw "Foreign-user verification failed ($($process.ExitCode))." }
  & $node $script verify $testRoot
  if ($LASTEXITCODE -ne 0) { throw 'Owner follow-up verification failed.' }
  Copy-Item -LiteralPath (Join-Path $testRoot 'result.json') -Destination (Join-Path $parent 'result.json')
}
finally {
  if ($process -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
  if ($testUser) {
    $current = Get-LocalUser -Name $userName -ErrorAction SilentlyContinue
    if ($current -and $current.SID.Value -eq $testUser.SID.Value) { Remove-LocalUser -SID $testUser.SID }
  }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  if ((Split-Path $resolved -Parent) -ne $parent -or (Split-Path $resolved -Leaf) -notmatch '^crb-dpapi-[0-9a-f]{32}$') { throw 'Refuse cleanup outside owned synthetic directory.' }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
