function Install-SetupHomebrewCask {
  param([string]$Cask)
  $brew = Get-Command brew -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $brew) { Stop-Setup 'Homebrew is required to install agent CLIs on macOS.' }
  $timeoutSeconds = Get-SetupTimeoutSeconds 600
  Invoke-SetupLiveProcess -Exe $brew.Source -Arguments @('install', '--cask', $Cask) -TimeoutSeconds $timeoutSeconds
}

# npm on Windows is commonly a .cmd launcher, which ProcessStartInfo cannot
# execute directly with UseShellExecute disabled. A fresh copy of the current
# PowerShell host resolves that launcher while preserving inherited terminal
# output and the same process-tree timeout.
function Install-SetupNpmPackage {
  param([string]$Package)
  $npm = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $npm) { Stop-Setup 'npm was selected for installation but is no longer available.' }
  $hostCommand = Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $hostExe = if ($hostCommand) { $hostCommand.Source } else { [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName }
  $npmLiteral = "'" + $npm.Source.Replace("'", "''") + "'"
  $packageLiteral = "'" + $Package.Replace("'", "''") + "'"
  $command = "& $npmLiteral install --global $packageLiteral; exit `$LASTEXITCODE"
  $timeoutSeconds = Get-SetupTimeoutSeconds 600
  Invoke-SetupLiveProcess -Exe $hostExe -Arguments @('-NoProfile', '-NonInteractive', '-Command', $command) -TimeoutSeconds $timeoutSeconds
}

# Execute a downloaded installer in a fresh interpreter. The script travels
# through stdin, while the API key exists only as a variable in this parent
# process and its identically named environment variables were removed. The
# official installer therefore cannot read the credential.
function Invoke-SetupInterpreterBody {
  param([string]$Body, [int]$TimeoutSeconds, [string]$Exe, [string]$Arguments)
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Exe
  $startInfo.Arguments = $Arguments
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $false
  $startInfo.RedirectStandardInput = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { Stop-Setup "failed to start the installer interpreter." }
  $process.StandardInput.Write($Body)
  $process.StandardInput.WriteLine()
  $process.StandardInput.Close()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-SetupProcessTree $process
    $process.WaitForExit()
    Stop-Setup "the installer timed out after $TimeoutSeconds seconds."
  }
  if ($process.ExitCode -ne 0) { Stop-Setup "the installer exited with status $($process.ExitCode)." }
}

function Invoke-SetupPowerShellBody {
  param([string]$Body, [int]$TimeoutSeconds, [switch]$BypassExecutionPolicy)
  $pwsh = Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $exe = if ($pwsh) { $pwsh.Source } else { [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName }
  $executionPolicy = if ($BypassExecutionPolicy) { '-ExecutionPolicy Bypass ' } else { '' }
  Invoke-SetupInterpreterBody -Body $Body -TimeoutSeconds $TimeoutSeconds -Exe $exe -Arguments "-NoProfile -NonInteractive ${executionPolicy}-Command -"
}

function Invoke-SetupShellBody {
  param([string]$Body, [int]$TimeoutSeconds)
  $bash = Get-Command bash -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $bash) { Stop-Setup 'bash is required to run the official installer on macOS and Linux.' }
  Invoke-SetupInterpreterBody -Body $Body -TimeoutSeconds $TimeoutSeconds -Exe $bash.Source -Arguments '-s'
}

# Download an installer, refuse anything that is not a script (region blocks and
# captive portals serve HTML in place of the installer), then run it.
function Invoke-SetupRemoteInstaller {
  param([string]$Uri, [switch]$BypassExecutionPolicy, [switch]$Shell)
  $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 60
  $body = [string]$response.Content
  $contentType = [string]$response.Headers['Content-Type']
  $looksLikeHtml = $contentType -match '(?i)^text/html(?:;|$)' -or $body -match '(?is)^\s*(?:<!doctype\s+html|<html(?:\s|>))'
  if ([string]::IsNullOrWhiteSpace($body) -or $looksLikeHtml) {
    Stop-Setup "the installer download was HTML or empty, not an executable script (a login or region-block page?)."
  }
  $timeoutSeconds = Get-SetupTimeoutSeconds 120
  if ($Shell) { Invoke-SetupShellBody -Body $body -TimeoutSeconds $timeoutSeconds }
  else { Invoke-SetupPowerShellBody -Body $body -TimeoutSeconds $timeoutSeconds -BypassExecutionPolicy:$BypassExecutionPolicy }
}

function Get-SetupCliExe {
  param([string]$Name, [string]$Label, [string[]]$Candidates)
  $found = New-Object System.Collections.Generic.List[string]
  $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { $found.Add($command.Source) }
  foreach ($candidate in $Candidates) {
    if ((Test-Path -LiteralPath $candidate) -and (-not $found.Contains($candidate))) { $found.Add($candidate) }
  }
  if ($found.Count -eq 0) { return $null }
  if ($found.Count -gt 1) { Write-SetupWarn "multiple $Label installations detected; using $($found[0])" }
  return $found[0]
}
