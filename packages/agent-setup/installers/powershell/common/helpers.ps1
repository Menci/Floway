# --- common helpers ---------------------------------------------------------

function Set-SetupProp {
  param($Target, [string]$Name, $Value)
  if ($Target.PSObject.Properties.Name -contains $Name) { $Target.$Name = $Value }
  else { $Target | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function Remove-SetupProp {
  param($Target, [string]$Name)
  if ($Target.PSObject.Properties.Name -contains $Name) { $Target.PSObject.Properties.Remove($Name) }
}

# A null optional value means "remove this managed key"; any other value is set.
function Set-SetupOptionalProp {
  param($Target, [string]$Name, $Value)
  if ($null -eq $Value) { Remove-SetupProp $Target $Name } else { Set-SetupProp $Target $Name $Value }
}

# Redact every occurrence of the API key from text before it is surfaced.
function Protect-SetupSecret {
  param([string]$Text)
  return ($Text -replace [regex]::Escape($SetupApiKey), '***')
}

# Restrict a file to the current user: chmod 0600 on Unix, an inheritance-free
# owner-only ACL on Windows.
function Protect-SetupFile {
  param([string]$Path)
  if (($PSVersionTable.PSVersion.Major -ge 6) -and (-not $IsWindows)) {
    & chmod 600 $Path
    if ($LASTEXITCODE -ne 0) { Stop-Setup "could not restrict $Path to owner-only access." }
    return
  }
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule($rule)
  Set-Acl -Path $Path -AclObject $acl
}

# Terminate a process and its descendants. PowerShell 7's runtime exposes the
# tree-aware Kill(bool) overload; Windows PowerShell 5.1 uses taskkill /T.
function Stop-SetupProcessTree {
  param([System.Diagnostics.Process]$Process)
  $runningOnWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
  if ($runningOnWindows) {
    & taskkill.exe /PID $Process.Id /T /F *> $null
    if ($LASTEXITCODE -ne 0 -and (-not $Process.HasExited)) {
      Stop-Setup "taskkill could not terminate process tree $($Process.Id)."
    }
    return
  }
  try {
    # .NET used by PowerShell 7 supports tree-aware termination on Unix.
    $Process.Kill($true)
  } catch {
    if (-not $Process.HasExited) { Stop-Setup "could not terminate process tree $($Process.Id)." }
  }
}

function Get-SetupPlatform {
  if (($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows) { return 'windows' }
  if ($IsMacOS) { return 'macos' }
  return 'linux'
}

# Run a fixed package-manager command with inherited stdout/stderr. The child
# remains attached to the real terminal, so progress updates and ANSI control
# sequences render in real time without a lossy line-prefix filter.
function Invoke-SetupLiveProcess {
  param([string]$Exe, [string[]]$Arguments, [int]$TimeoutSeconds)
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Exe
  $startInfo.Arguments = ($Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $false
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { Stop-Setup "failed to start $Exe." }
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-SetupProcessTree $process
    $process.WaitForExit()
    Stop-Setup "$Exe timed out after $TimeoutSeconds seconds."
  }
  if ($process.ExitCode -ne 0) { Stop-Setup "$Exe exited with status $($process.ExitCode)." }
}

function Install-SetupHomebrewCask {
  param([string]$Cask)
  $brew = Get-Command brew -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $brew) { Stop-Setup 'Homebrew is required to install agent CLIs on macOS.' }
  $timeoutSeconds = if ($env:AGENT_SETUP_TEST_TIMEOUT_SECONDS) { [int]$env:AGENT_SETUP_TEST_TIMEOUT_SECONDS } else { 600 }
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
  $timeoutSeconds = if ($env:AGENT_SETUP_TEST_TIMEOUT_SECONDS) { [int]$env:AGENT_SETUP_TEST_TIMEOUT_SECONDS } else { 600 }
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
  $timeoutSeconds = if ($env:AGENT_SETUP_TEST_TIMEOUT_SECONDS) { [int]$env:AGENT_SETUP_TEST_TIMEOUT_SECONDS } else { 120 }
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

# Rollback retains a backup when restoration fails so manual recovery remains
# possible, warning with the preserved path and the action to take — matching
# the Bash installer. The AGENT_SETUP_TEST_FAIL_RESTORE hook, read from the
# ambient environment and never emitted by the gateway, forces the restore
# rename to fail so the harness can assert that guidance.
function Restore-SetupManagedFile {
  param([bool]$Existed, [string]$Backup, [string]$Path, [string]$OriginalLabel, [string]$CreatedLabel)
  if ($Existed) {
    if ($Backup -and (Test-Path -LiteralPath $Backup)) {
      try {
        if ($env:AGENT_SETUP_TEST_FAIL_RESTORE) { throw 'test-injected restore failure' }
        # Secret-bearing backups were already owner-only before any mutation.
        # Moving one back preserves that protection without a second operation
        # that could fail after the backup path has been consumed.
        Move-Item -LiteralPath $Backup -Destination $Path -Force
      } catch {
        Write-SetupWarn "could not restore $Path from its backup; your original $OriginalLabel is preserved at $Backup — restore it by hand."
      }
    }
  } elseif (Test-Path -LiteralPath $Path) {
    try {
      Remove-Item -LiteralPath $Path -Force
    } catch {
      Write-SetupWarn "could not remove the $CreatedLabel this run created at $Path — remove it by hand."
    }
  }
}

# Run a child process with its stdout and stderr redirected into in-process
# pipes, bounded by a deadline. On timeout the whole process tree is terminated
# and the call throws; otherwise the exit code and combined stdout+stderr are
# returned. Arguments are fixed internal tokens, never external input.
function Invoke-SetupProcess {
  param([string]$Exe, [string[]]$Arguments, [int]$TimeoutSeconds, [string]$TimeoutMessage)
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Exe
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  # ArgumentList is unavailable in Windows PowerShell 5.1. These arguments are
  # fixed internal tokens, so quoting them with ProcessStartInfo.Arguments is
  # safe and keeps external input out of the child command line.
  $startInfo.Arguments = ($Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { Stop-Setup "failed to start $Exe." }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-SetupProcessTree $process
    $process.WaitForExit()
    Stop-Setup $(if ($TimeoutMessage) { $TimeoutMessage } else { "$Exe timed out after $TimeoutSeconds seconds." })
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  [PSCustomObject]@{ ExitCode = $process.ExitCode; Output = ($stdout + $stderr) }
}
