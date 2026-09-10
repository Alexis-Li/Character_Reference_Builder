function Get-CrbTempRoot {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot
  )

  $configuredRoot = [string]$env:CRB_TEMP_ROOT
  if ([string]::IsNullOrWhiteSpace($configuredRoot)) {
    $localEnvironmentPath = Join-Path $RepoRoot ".env.local"
    if (Test-Path -LiteralPath $localEnvironmentPath) {
      $entry = Get-Content -LiteralPath $localEnvironmentPath |
        Where-Object { $_ -match '^\s*CRB_TEMP_ROOT\s*=' } |
        Select-Object -First 1
      if ($entry) {
        $configuredRoot = ($entry -split '=', 2)[1].Trim().Trim('"').Trim("'")
      }
    }
  }

  if ([string]::IsNullOrWhiteSpace($configuredRoot)) {
    $configuredRoot = Join-Path ([IO.Path]::GetTempPath()) "Character_Reference_Builder"
  }

  return [IO.Path]::GetFullPath(
    [Environment]::ExpandEnvironmentVariables($configuredRoot)
  )
}
