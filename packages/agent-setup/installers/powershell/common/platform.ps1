# Windows PowerShell 5.1 only runs on Windows and has no $IsWindows automatic
# variable; PowerShell 6+ exposes it on every platform.
function Test-SetupIsWindows {
  ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
}

# The AGENT_SETUP_TEST_TIMEOUT_SECONDS hook, read from the ambient environment
# and never emitted by the gateway, lets the harness shorten every wall-clock
# limit; otherwise the caller-supplied default applies.
function Get-SetupTimeoutSeconds {
  param([int]$Default)
  if ($env:AGENT_SETUP_TEST_TIMEOUT_SECONDS) { [int]$env:AGENT_SETUP_TEST_TIMEOUT_SECONDS } else { $Default }
}

function Get-SetupPlatform {
  # The AGENT_SETUP_TEST_FORCE_WINDOWS hook lets the harness exercise
  # Windows-only config-path branches on a non-Windows host; it must not
  # affect Test-SetupIsWindows, whose callers also gate owner-only ACL APIs
  # that do not exist on Linux.
  if ($env:AGENT_SETUP_TEST_FORCE_WINDOWS) { return 'windows' }
  if (Test-SetupIsWindows) { return 'windows' }
  if ($IsMacOS) { return 'macos' }
  return 'linux'
}
