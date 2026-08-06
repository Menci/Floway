# Windows PowerShell 5.1 only runs on Windows and has no $IsWindows automatic
# variable; PowerShell 6+ exposes it on every platform.
function Test-SetupIsWindows {
  ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
}

function Get-SetupPlatform {
  if (Test-SetupIsWindows) { return 'windows' }
  if ($IsMacOS) { return 'macos' }
  return 'linux'
}
