# Floway Agent Setup installer (PowerShell). The gateway prepends the
# language-native assignment prefix before this fixed body.
#
# Each served script targets exactly one agent and rolls back that agent's
# configuration as one transaction on failure.

# --- output layer -----------------------------------------------------------
#
# Setup-owned output follows Homebrew's compact visual language: blue `==>`
# notices introduce major phases, while warnings and errors color only their
# labels. Phase details remain subordinate instead of competing for attention.
# Native package managers inherit the terminal directly, preserving their ANSI
# colors, carriage-return progress, buffering, and cursor behavior.
#
# stdout color rides the host: `Write-Host -ForegroundColor` colors an
# interactive console yet writes no escape sequences when redirected/captured,
# so it is the correct stdout mechanism on both Windows PowerShell 5.1 and
# PowerShell 7. stderr goes through [Console]::Error, colored with ANSI only for
# an interactive error stream with NO_COLOR unset — a redirected capture stays
# escape-free. UTF-8 output makes the box-drawing glyphs render on 5.1 too.
function Write-SetupHostLine {
  param([string]$Text, [System.ConsoleColor]$Color, [switch]$Plain)
  if ($Plain -or $script:SetupNoColor) { Write-Host $Text } else { Write-Host $Text -ForegroundColor $Color }
}

# Console.ForegroundColor works in Windows PowerShell 5.1 without requiring VT
# mode and still writes the text to stderr. The forced-color branch is test-only:
# redirected streams cannot expose host color, so it emits ANSI for assertions.
function Write-SetupErrLine {
  param([string]$Text, [System.ConsoleColor]$Color, [string]$TestAnsiCode)
  if ($script:SetupErrColor) {
    $previous = [Console]::ForegroundColor
    try { [Console]::ForegroundColor = $Color; [Console]::Error.WriteLine($Text) }
    finally { [Console]::ForegroundColor = $previous }
  } elseif ($script:SetupForceColor -and (-not $script:SetupNoColor)) {
    [Console]::Error.WriteLine("$($script:SetupEsc)[${TestAnsiCode}m$Text$($script:SetupEsc)[0m")
  } else {
    [Console]::Error.WriteLine($Text)
  }
}

function Write-SetupNotice {
  param([string]$Text)
  if ($script:SetupNoColor) { Write-Host "==> $Text"; return }
  if ($script:SetupOutAnsi) {
    Write-Host "$($script:SetupEsc)[34m==>$($script:SetupEsc)[0m $($script:SetupEsc)[1m$Text$($script:SetupEsc)[0m"
    return
  }
  Write-Host '==>' -ForegroundColor Blue -NoNewline
  Write-Host " $Text" -ForegroundColor White
}

# Console.Error is used directly so diagnostics remain on stderr while only the
# Homebrew-style label receives color.
function Write-SetupDiagnostic {
  param([string]$Label, [string]$Text, [System.ConsoleColor]$Color, [string]$TestAnsiCode)
  if ($script:SetupErrColor) {
    $previous = [Console]::ForegroundColor
    try {
      [Console]::ForegroundColor = $Color
      [Console]::Error.Write("${Label}:")
      [Console]::ForegroundColor = $previous
      [Console]::Error.WriteLine(" $Text")
    } finally {
      [Console]::ForegroundColor = $previous
    }
  } elseif ($script:SetupForceColor -and (-not $script:SetupNoColor)) {
    [Console]::Error.WriteLine("$($script:SetupEsc)[${TestAnsiCode}m${Label}:$($script:SetupEsc)[0m $Text")
  } else {
    [Console]::Error.WriteLine("${Label}: $Text")
  }
}

function Write-SetupTitle { Write-SetupNotice 'Floway Agent Setup' }
function Write-SetupMetadata { param([string]$Label, [string]$Value) Write-Host "${Label}: $Value" }
function Write-SetupPhase { param([string]$Name) Write-SetupNotice $Name }
function Write-SetupInfo { param([string]$Text) Write-SetupHostLine $Text -Plain }
function Write-SetupSuccess { param([string]$Text) Write-SetupHostLine "✨ $Text" -Plain }
function Write-SetupWarn { param([string]$Text) Write-SetupDiagnostic 'Warning' $Text Yellow '93' }
function Write-SetupError { param([string]$Text) Write-SetupDiagnostic 'Error' $Text Red '91' }
function Write-SetupFatal { param([string]$Text) Write-SetupDiagnostic 'Error' $Text Red '91' }

# Report a primary error to stderr and unwind. The agent boundary recognizes the
# 'setup-handled' marker as already reported, so no line is ever duplicated.
function Stop-Setup { param([string]$Message) Write-SetupError $Message; throw 'setup-handled' }

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

# --- Claude Code ------------------------------------------------------------

# Install the official Claude Code package. The
# AGENT_SETUP_TEST_INSTALL_CLAUDE_SCRIPT hook — read from the ambient
# environment, never emitted by the gateway — substitutes a fake installer
# under test.
function Install-SetupClaude {
  if ($env:AGENT_SETUP_TEST_INSTALL_CLAUDE_SCRIPT) {
    Write-SetupInfo 'Claude Code CLI not found; running the test installer'
    $timeoutSeconds = if ($env:AGENT_SETUP_TEST_TIMEOUT_SECONDS) { [int]$env:AGENT_SETUP_TEST_TIMEOUT_SECONDS } else { 120 }
    $installer = Invoke-SetupProcess -Exe $env:AGENT_SETUP_TEST_INSTALL_CLAUDE_SCRIPT -Arguments @() -TimeoutSeconds $timeoutSeconds
    if ($installer.ExitCode -ne 0) { Stop-Setup "the test installer hook failed." }
    return
  }
  if ($env:AGENT_SETUP_TEST_CLAUDE_URL) {
    Write-SetupInfo 'Claude Code CLI not found; running the test installer download'
    Invoke-SetupRemoteInstaller -Uri $env:AGENT_SETUP_TEST_CLAUDE_URL
    return
  }
  $platform = Get-SetupPlatform
  $npm = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  switch ($platform) {
    'macos' {
      $brew = Get-Command brew -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($brew) {
        Write-SetupInfo 'Claude Code CLI not found; installing with Homebrew'
        Install-SetupHomebrewCask -Cask 'claude-code'
      } elseif ($npm) {
        Write-SetupInfo 'Claude Code CLI not found; installing with npm'
        Install-SetupNpmPackage -Package '@anthropic-ai/claude-code'
      } else {
        # Ref: https://code.claude.com/docs/en/setup
        Write-SetupInfo 'Claude Code CLI not found; installing from downloads.claude.ai'
        Invoke-SetupRemoteInstaller -Uri 'https://downloads.claude.ai/claude-code-releases/bootstrap.sh' -Shell
      }
    }
    'windows' {
      if ($npm) {
        Write-SetupInfo 'Claude Code CLI not found; installing with npm'
        Install-SetupNpmPackage -Package '@anthropic-ai/claude-code'
      } else {
        # Ref: https://code.claude.com/docs/en/setup
        Write-SetupInfo 'Claude Code CLI not found; installing from downloads.claude.ai'
        Invoke-SetupRemoteInstaller -Uri 'https://downloads.claude.ai/claude-code-releases/bootstrap.ps1'
      }
    }
    'linux' {
      if ($npm) {
        Write-SetupInfo 'Claude Code CLI not found; installing with npm'
        Install-SetupNpmPackage -Package '@anthropic-ai/claude-code'
      } else {
        # Ref: https://code.claude.com/docs/en/setup
        Write-SetupInfo 'Claude Code CLI not found; installing from downloads.claude.ai'
        Invoke-SetupRemoteInstaller -Uri 'https://downloads.claude.ai/claude-code-releases/bootstrap.sh' -Shell
      }
    }
  }
}

function Restore-SetupClaudeSettings {
  Restore-SetupManagedFile -Existed $script:ClaudeSettingsExisted -Backup $script:ClaudeSettingsBackup -Path $script:ClaudeSettingsPath -OriginalLabel 'file' -CreatedLabel 'Claude settings'
}

# Surgically merge the managed keys into the Claude settings file: validate the
# existing document, back it up, construct and validate the replacement in the
# same directory, then atomically rename it into place with owner-only access.
function Write-SetupClaudeSettings {
  $configDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
  $script:ClaudeSettingsPath = Join-Path $configDir 'settings.json'
  $script:ClaudeSettingsBackup = $null
  $script:ClaudeSettingsExisted = $false
  if (-not (Test-Path -LiteralPath $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
  }

  $document = $null
  if (Test-Path -LiteralPath $script:ClaudeSettingsPath) {
    $script:ClaudeSettingsExisted = $true
    $raw = Get-Content -Raw -LiteralPath $script:ClaudeSettingsPath
    try { $document = $raw | ConvertFrom-Json } catch { Stop-Setup "$($script:ClaudeSettingsPath) is not valid JSON; leaving it untouched." }
    if ($document -isnot [System.Management.Automation.PSCustomObject]) { Stop-Setup "existing Claude settings root is not a JSON object." }
    if (($document.PSObject.Properties.Name -contains 'env') -and ($document.env -isnot [System.Management.Automation.PSCustomObject])) {
      Stop-Setup "existing Claude settings env is not a JSON object."
    }
    # DateTimeOffset.ToUnixTimeMilliseconds is unavailable on the .NET
    # Framework version bundled with the Windows PowerShell 5.1 baseline.
    $stamp = [long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds
    $script:ClaudeSettingsBackup = "$($script:ClaudeSettingsPath).floway-backup.$stamp.$PID"
    try {
      Copy-Item -LiteralPath $script:ClaudeSettingsPath -Destination $script:ClaudeSettingsBackup
      Protect-SetupFile $script:ClaudeSettingsBackup
    } catch {
      if (Test-Path -LiteralPath $script:ClaudeSettingsBackup) {
        Remove-Item -LiteralPath $script:ClaudeSettingsBackup -Force
      }
      $script:ClaudeSettingsBackup = $null
      throw
    }
  } else {
    $document = [PSCustomObject]@{}
  }

  if ($document.PSObject.Properties.Name -notcontains 'env') {
    $document | Add-Member -NotePropertyName env -NotePropertyValue ([PSCustomObject]@{})
  }
  Set-SetupProp $document.env 'ANTHROPIC_BASE_URL' $SetupEndpoint
  Set-SetupProp $document.env 'ANTHROPIC_AUTH_TOKEN' $SetupApiKey
  Set-SetupOptionalProp $document.env 'ANTHROPIC_MODEL' $SetupClaudeModel
  Set-SetupOptionalProp $document.env 'ANTHROPIC_DEFAULT_OPUS_MODEL' $SetupClaudeDefaultOpusModel
  Set-SetupOptionalProp $document.env 'ANTHROPIC_DEFAULT_SONNET_MODEL' $SetupClaudeDefaultSonnetModel
  Set-SetupOptionalProp $document.env 'ANTHROPIC_DEFAULT_HAIKU_MODEL' $SetupClaudeDefaultHaikuModel
  if ($SetupClaudeModelDiscovery) { Set-SetupProp $document.env 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY' '1' }
  else { Remove-SetupProp $document.env 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY' }
  Set-SetupOptionalProp $document 'effortLevel' $SetupClaudeEffortLevel

  $stage = "$($script:ClaudeSettingsPath).floway-stage.$PID"
  try {
    # The stage exists and is owner-only before any secret JSON is written.
    [System.IO.File]::Create($stage).Dispose()
    Protect-SetupFile $stage
    $json = $document | ConvertTo-Json -Depth 100
    # Write UTF-8 without a BOM on every PowerShell version so downstream JSON
    # parsers accept the file.
    [System.IO.File]::WriteAllText($stage, $json, (New-Object System.Text.UTF8Encoding($false)))
    $check = Get-Content -Raw -LiteralPath $stage | ConvertFrom-Json
    if (($check.env.ANTHROPIC_BASE_URL -ne $SetupEndpoint) -or ($check.env.ANTHROPIC_AUTH_TOKEN -ne $SetupApiKey)) {
      Stop-Setup "staged Claude settings failed validation."
    }
    # Windows PowerShell 5.1 only runs on Windows and has no $IsWindows
    # automatic variable; PowerShell 6+ exposes it on every platform.
    $runningOnWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
    if ($script:ClaudeSettingsExisted -and $runningOnWindows) {
      # File.Replace preserves the destination ACL, so tighten it first rather
      # than letting a permissive historical DACL survive the atomic replace.
      Protect-SetupFile $script:ClaudeSettingsPath
      [System.IO.File]::Replace($stage, $script:ClaudeSettingsPath, $null)
    } else {
      # Move-Item is an atomic same-filesystem rename on Unix and creates a new
      # target on Windows. Windows replacing an existing target uses File.Replace.
      Move-Item -LiteralPath $stage -Destination $script:ClaudeSettingsPath -Force
    }
  } catch {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force }
    Restore-SetupClaudeSettings
    throw
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

function Write-SetupClaudeVersion {
  param([string]$Exe)
  $timeoutSeconds = if ($env:AGENT_SETUP_TEST_TIMEOUT_SECONDS) { [int]$env:AGENT_SETUP_TEST_TIMEOUT_SECONDS } else { 30 }
  $version = Invoke-SetupProcess -Exe $Exe -Arguments @('--version') -TimeoutSeconds $timeoutSeconds -TimeoutMessage '``claude --version`` timed out.'
  if ($version.ExitCode -ne 0) { Stop-Setup "``claude --version`` failed." }
  Write-SetupInfo "Claude Code version: $($version.Output.Trim())"
}

# Install, then configure Claude Code as one transactional settings write. A
# freshly installed CLI is never uninstalled when configuration fails.
function Set-SetupClaude {
  Write-SetupPhase 'Installing Claude Code'
  # Ref: https://docs.claude.com/en/docs/claude-code/troubleshoot-install
  $candidates = @(
    (Join-Path $HOME '.local/bin/claude'),
    (Join-Path $HOME '.local/bin/claude.exe'),
    (Join-Path $HOME '.claude/local/claude')
  )
  if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.local\bin\claude.exe') }
  $exe = Get-SetupCliExe -Name claude -Label 'Claude Code' -Candidates $candidates
  if (-not $exe) {
    Install-SetupClaude
    $exe = Get-SetupCliExe -Name claude -Label 'Claude Code' -Candidates $candidates
    if (-not $exe) { Stop-Setup "Claude Code CLI is unavailable and could not be installed." }
  } else {
    Write-SetupInfo 'Claude Code is already installed.'
  }
  Write-SetupClaudeVersion -Exe $exe

  Write-SetupPhase 'Configuring Claude Code'
  Write-SetupClaudeSettings
  Write-SetupInfo ('Written to `' + $script:ClaudeSettingsPath + '`.')
  Write-SetupSuccess "Claude Code configured."
}

# --- Codex ------------------------------------------------------------------

# Install the official Codex package. CODEX_NON_INTERACTIVE keeps the direct
# installer from prompting. Package sources:
# https://github.com/openai/codex/blob/d3fc1950a920f98e7fa9f11056667cdf911c38df/README.md#L18-L37
# The AGENT_SETUP_TEST_INSTALL_CODEX_SCRIPT hook —
# read from the ambient environment, never emitted by the gateway — substitutes
# a fake installer under test.
function Install-SetupCodex {
  $hadNonInteractive = Test-Path Env:CODEX_NON_INTERACTIVE
  $previousNonInteractive = $env:CODEX_NON_INTERACTIVE
  try {
    $env:CODEX_NON_INTERACTIVE = 'true'
    if ($env:AGENT_SETUP_TEST_INSTALL_CODEX_SCRIPT) {
      Write-SetupInfo 'Codex CLI not found; running the test installer'
      $timeoutSeconds = if ($env:AGENT_SETUP_TEST_TIMEOUT_SECONDS) { [int]$env:AGENT_SETUP_TEST_TIMEOUT_SECONDS } else { 120 }
      $installer = Invoke-SetupProcess -Exe $env:AGENT_SETUP_TEST_INSTALL_CODEX_SCRIPT -Arguments @() -TimeoutSeconds $timeoutSeconds
      if ($installer.ExitCode -ne 0) { Stop-Setup "the test codex installer hook failed." }
      return
    }
    if ($env:AGENT_SETUP_TEST_CODEX_URL) {
      Write-SetupInfo 'Codex CLI not found; running the test installer download'
      Invoke-SetupRemoteInstaller -Uri $env:AGENT_SETUP_TEST_CODEX_URL -BypassExecutionPolicy
      return
    }
    $platform = Get-SetupPlatform
    $npm = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    switch ($platform) {
      'macos' {
        $brew = Get-Command brew -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($brew) {
          Write-SetupInfo 'Codex CLI not found; installing with Homebrew'
          Install-SetupHomebrewCask -Cask 'codex'
        } elseif ($npm) {
          Write-SetupInfo 'Codex CLI not found; installing with npm'
          Install-SetupNpmPackage -Package '@openai/codex'
        } else {
          # This source is published byte-for-byte as the GitHub release installer.
          # Ref: https://github.com/openai/codex/blob/d3fc1950a920f98e7fa9f11056667cdf911c38df/scripts/install/install.sh
          Write-SetupInfo 'Codex CLI not found; installing from GitHub'
          Invoke-SetupRemoteInstaller -Uri 'https://raw.githubusercontent.com/openai/codex/refs/heads/main/scripts/install/install.sh' -Shell
        }
      }
      'windows' {
        if ($npm) {
          Write-SetupInfo 'Codex CLI not found; installing with npm'
          Install-SetupNpmPackage -Package '@openai/codex'
        } else {
          # This source is published byte-for-byte as the GitHub release installer.
          # Ref: https://github.com/openai/codex/blob/d3fc1950a920f98e7fa9f11056667cdf911c38df/scripts/install/install.ps1
          Write-SetupInfo 'Codex CLI not found; installing from GitHub'
          Invoke-SetupRemoteInstaller -Uri 'https://raw.githubusercontent.com/openai/codex/refs/heads/main/scripts/install/install.ps1'
        }
      }
      'linux' {
        if ($npm) {
          Write-SetupInfo 'Codex CLI not found; installing with npm'
          Install-SetupNpmPackage -Package '@openai/codex'
        } else {
          # This source is published byte-for-byte as the GitHub release installer.
          # Ref: https://github.com/openai/codex/blob/d3fc1950a920f98e7fa9f11056667cdf911c38df/scripts/install/install.sh
          Write-SetupInfo 'Codex CLI not found; installing from GitHub'
          Invoke-SetupRemoteInstaller -Uri 'https://raw.githubusercontent.com/openai/codex/refs/heads/main/scripts/install/install.sh' -Shell
        }
      }
    }
  } finally {
    if ($hadNonInteractive) { $env:CODEX_NON_INTERACTIVE = $previousNonInteractive }
    else { Remove-Item Env:CODEX_NON_INTERACTIVE -ErrorAction SilentlyContinue }
  }
}

# Back up the config and provider token before any mutation, recording the
# absence of each so rollback can distinguish "restore" from "remove".
function Backup-SetupCodexFiles {
  $script:CodexConfigExisted = $false
  $script:CodexTokenExisted = $false
  $script:CodexConfigBackup = $null
  $script:CodexTokenBackup = $null
  # DateTimeOffset.ToUnixTimeMilliseconds is unavailable on the .NET Framework
  # version bundled with the Windows PowerShell 5.1 baseline.
  $stamp = [long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds
  if (Test-Path -LiteralPath $script:CodexConfigPath) {
    $script:CodexConfigExisted = $true
    $script:CodexConfigBackup = "$($script:CodexConfigPath).floway-backup.$stamp.$PID"
    Copy-Item -LiteralPath $script:CodexConfigPath -Destination $script:CodexConfigBackup
  }
  if (Test-Path -LiteralPath $script:CodexTokenPath) {
    $script:CodexTokenExisted = $true
    $script:CodexTokenBackup = "$($script:CodexTokenPath).floway-backup.$stamp.$PID"
    try {
      Copy-Item -LiteralPath $script:CodexTokenPath -Destination $script:CodexTokenBackup
      Protect-SetupFile $script:CodexTokenBackup
    } catch {
      if (Test-Path -LiteralPath $script:CodexTokenBackup) {
        Remove-Item -LiteralPath $script:CodexTokenBackup -Force
      }
      $script:CodexTokenBackup = $null
      throw
    }
  }
}

function Restore-SetupCodexFiles {
  Restore-SetupManagedFile -Existed $script:CodexConfigExisted -Backup $script:CodexConfigBackup -Path $script:CodexConfigPath -OriginalLabel 'file' -CreatedLabel 'Codex config'
  Restore-SetupManagedFile -Existed $script:CodexTokenExisted -Backup $script:CodexTokenBackup -Path $script:CodexTokenPath -OriginalLabel 'provider token' -CreatedLabel 'Codex provider token'
}

# Drive `codex app-server` over redirected stdin/stdout/stderr: initialize ->
# initialized -> config/batchWrite. stderr is drained asynchronously so a chatty
# server cannot fill the pipe buffer and deadlock. Each response read is bounded
# by the remaining deadline; a timeout terminates the process tree. Unrelated
# notifications are demultiplexed by id. Returns the batchWrite result object.
function Invoke-SetupCodexAppServerBatchWrite {
  param([string]$Exe, $Edits, [int]$TimeoutSeconds)
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Exe
  $startInfo.Arguments = 'app-server --listen stdio://'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { Stop-Setup "failed to start the Codex app-server." }
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $budgetMs = $TimeoutSeconds * 1000
  $result = $null
  try {
    $readMatching = {
      param([int]$WantId)
      while ($true) {
        $remaining = $budgetMs - $watch.ElapsedMilliseconds
        if ($remaining -le 0) { Stop-Setup "the Codex app-server timed out before confirming the configuration." }
        $task = $process.StandardOutput.ReadLineAsync()
        if (-not $task.Wait([int]$remaining)) { Stop-Setup "the Codex app-server timed out before confirming the configuration." }
        $line = $task.GetAwaiter().GetResult()
        if ($null -eq $line) { Stop-Setup "the Codex app-server exited before confirming the configuration." }
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $msg = $line | ConvertFrom-Json } catch { Stop-Setup "the Codex app-server returned a malformed response." }
        if ($msg.id -ne $WantId) { continue }
        if ($null -ne $msg.error) { Stop-Setup "the Codex app-server reported an error writing the configuration." }
        return $msg.result
      }
    }
    $initReq = @{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{ clientInfo = @{ name = 'floway-setup'; title = $null; version = '1' }; capabilities = $null } } | ConvertTo-Json -Depth 10 -Compress
    $process.StandardInput.WriteLine($initReq)
    [void](& $readMatching 1)
    $process.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"initialized"}')
    $batchReq = @{ jsonrpc = '2.0'; id = 2; method = 'config/batchWrite'; params = @{ edits = $Edits } } | ConvertTo-Json -Depth 10 -Compress
    $process.StandardInput.WriteLine($batchReq)
    $result = (& $readMatching 2)
  } finally {
    try { $process.StandardInput.Close() } catch { }
    if (-not $process.WaitForExit(1000)) {
      Stop-SetupProcessTree $process
      $process.WaitForExit()
    }
    $null = $stderrTask.GetAwaiter().GetResult()
  }
  return $result
}

# Build the base-config edit batch and write it through the app-server. Model
# and effort are opaque, forwarded verbatim, and cleared with JSON null ($null)
# when unset. A batch status of `ok` or `okOverridden` confirms the intended
# base config; `okOverridden` is reported with its non-secret layer metadata.
function Write-SetupCodexConfig {
  param([string]$Exe)
  $codexBase = ($SetupEndpoint.TrimEnd('/')) + '/azure-api.codex'
  $runningOnWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
  $auth = if ($runningOnWindows) {
    [ordered]@{
      command = 'powershell'
      args = @('-NoProfile', '-Command', '$h = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ''.codex'' }; [IO.File]::ReadAllText((Join-Path $h ''floway-token''))')
    }
  } else {
    [ordered]@{
      command = 'sh'
      args = @('-c', 'cat "${CODEX_HOME:-$HOME/.codex}/floway-token"')
    }
  }
  # Command auth opts a provider into online model refresh. The actor marker
  # enables Codex's client-owned search and image extensions for this provider.
  # https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/models-manager/src/manager.rs#L413-L415
  # https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/model-provider-info/src/lib.rs#L396-L408
  $edits = @(
    @{ keyPath = 'model_provider'; mergeStrategy = 'replace'; value = 'floway' },
    @{ keyPath = 'model_providers.floway.name'; mergeStrategy = 'replace'; value = 'Floway' },
    @{ keyPath = 'model_providers.floway.base_url'; mergeStrategy = 'replace'; value = $codexBase },
    @{ keyPath = 'model_providers.floway.auth'; mergeStrategy = 'replace'; value = $auth },
    @{ keyPath = 'model_providers.floway.wire_api'; mergeStrategy = 'replace'; value = 'responses' },
    @{ keyPath = 'model_providers.floway.supports_websockets'; mergeStrategy = 'replace'; value = $true },
    @{ keyPath = 'model_providers.floway.http_headers'; mergeStrategy = 'replace'; value = @{ 'x-openai-actor-authorization' = '1' } },
    @{ keyPath = 'features.apps'; mergeStrategy = 'replace'; value = $false },
    @{ keyPath = 'features.standalone_web_search'; mergeStrategy = 'replace'; value = $true },
    @{ keyPath = 'model'; mergeStrategy = 'replace'; value = $SetupCodexModel },
    @{ keyPath = 'model_reasoning_effort'; mergeStrategy = 'replace'; value = $SetupCodexReasoningEffort }
  )
  $timeoutSeconds = if ($env:AGENT_SETUP_TEST_TIMEOUT_SECONDS) { [int]$env:AGENT_SETUP_TEST_TIMEOUT_SECONDS } else { 60 }
  $result = Invoke-SetupCodexAppServerBatchWrite -Exe $Exe -Edits $edits -TimeoutSeconds $timeoutSeconds
  $status = [string]$result.status
  if ($status -eq 'okOverridden') {
    $message = if ($result.overriddenMetadata -and $result.overriddenMetadata.message) { [string]$result.overriddenMetadata.message } else { 'an override layer applies' }
    $layer = 'unknown'
    if ($result.overriddenMetadata -and $result.overriddenMetadata.overridingLayer -and $result.overriddenMetadata.overridingLayer.name) {
      $layer = [string]$result.overriddenMetadata.overridingLayer.name.type
    }
    Write-SetupWarn "Codex configuration is overridden by a higher-precedence layer ($message; layer: $layer)."
  } elseif ($status -ne 'ok') {
    Stop-Setup "the Codex app-server did not confirm the configuration (status: $status)."
  }
  $filePath = [string]$result.filePath
  if ([string]::IsNullOrWhiteSpace($filePath)) {
    Stop-Setup "the Codex app-server did not report the written config path."
  }
  return $filePath
}

# Store the selected API key as a provider-scoped command-auth token. The private
# stage is validated byte-for-byte, then atomically replaced. auth.json is an
# account-owned Codex file and is never read or changed here.
function Write-SetupCodexToken {
  $stage = "$($script:CodexTokenPath).floway-stage.$PID"
  try {
    [System.IO.File]::Create($stage).Dispose()
    Protect-SetupFile $stage
    [System.IO.File]::WriteAllText($stage, $SetupApiKey, (New-Object System.Text.UTF8Encoding($false)))
    if ([System.IO.File]::ReadAllText($stage) -cne $SetupApiKey) {
      Stop-Setup "staged Codex provider token failed validation."
    }
    $runningOnWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
    if ($script:CodexTokenExisted -and $runningOnWindows) {
      # File.Replace preserves the destination ACL, so tighten it first.
      Protect-SetupFile $script:CodexTokenPath
      [System.IO.File]::Replace($stage, $script:CodexTokenPath, $null)
    } else {
      Move-Item -LiteralPath $stage -Destination $script:CodexTokenPath -Force
    }
  } catch {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force }
    throw
  }
}

function Write-SetupCodexVersion {
  param([string]$Exe)
  $timeoutSeconds = if ($env:AGENT_SETUP_TEST_TIMEOUT_SECONDS) { [int]$env:AGENT_SETUP_TEST_TIMEOUT_SECONDS } else { 30 }
  $version = Invoke-SetupProcess -Exe $Exe -Arguments @('--version') -TimeoutSeconds $timeoutSeconds -TimeoutMessage '``codex --version`` timed out.'
  if ($version.ExitCode -ne 0) { Stop-Setup "``codex --version`` failed." }
  Write-SetupInfo "Codex version: $($version.Output.Trim())"
}

# Install, then configure Codex as one transactional config/token write. A
# freshly installed CLI is never uninstalled when configuration fails.
function Set-SetupCodex {
  Write-SetupPhase 'Installing Codex'
  # Ref: https://github.com/openai/codex/blob/main/scripts/install/install.sh
  $candidates = @(
    (Join-Path $HOME '.local/bin/codex'),
    (Join-Path $HOME '.local/bin/codex.exe')
  )
  if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.local\bin\codex.exe') }
  $exe = Get-SetupCliExe -Name codex -Label Codex -Candidates $candidates
  if (-not $exe) {
    Install-SetupCodex
    $exe = Get-SetupCliExe -Name codex -Label Codex -Candidates $candidates
    if (-not $exe) { Stop-Setup "Codex CLI is unavailable and could not be installed." }
  } else {
    Write-SetupInfo 'Codex is already installed.'
  }
  Write-SetupCodexVersion -Exe $exe

  Write-SetupPhase 'Configuring Codex'
  $script:CodexHomeDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
  $script:CodexConfigPath = Join-Path $script:CodexHomeDir 'config.toml'
  $script:CodexTokenPath = Join-Path $script:CodexHomeDir 'floway-token'
  if (-not (Test-Path -LiteralPath $script:CodexHomeDir)) {
    New-Item -ItemType Directory -Path $script:CodexHomeDir -Force | Out-Null
  }
  Backup-SetupCodexFiles
  try {
    Write-SetupCodexToken
  } catch {
    Write-SetupWarn "Codex provider-token staging failed; rolling back configuration and token."
    Restore-SetupCodexFiles
    throw
  }
  try {
    $writtenConfigPath = Write-SetupCodexConfig -Exe $exe
  } catch {
    Write-SetupWarn "Codex configuration failed; rolling back configuration and token."
    Restore-SetupCodexFiles
    throw
  }
  Write-SetupInfo ('Written to `' + $writtenConfigPath + '`.')
  Write-SetupInfo ('Written to `' + $script:CodexTokenPath + '`.')
  Write-SetupSuccess "Codex configured."
}

# --- run --------------------------------------------------------------------

function Main {
  $ErrorActionPreference = 'Stop'
  if (-not (Test-Path Variable:SetupEndpoint)) { $SetupEndpoint = $null }
  # Keep native command failures from auto-throwing on PowerShell 7.3+ so the
  # explicit exit-code checks remain authoritative across versions.
  $PSNativeCommandUseErrorActionPreference = $false

  Remove-Item Env:SETUP_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:SetupApiKey -ErrorAction SilentlyContinue

  try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
  $script:SetupNoColor = [bool]$env:NO_COLOR
  $script:SetupForceColor = [bool]$env:AGENT_SETUP_TEST_FORCE_COLOR
  $script:SetupErrColor = (-not [Console]::IsErrorRedirected) -and (-not $script:SetupNoColor)
  $script:SetupEsc = [char]27
  $supportsVt = try { [bool]$Host.UI.SupportsVirtualTerminal } catch { $false }
  $script:SetupOutAnsi = $supportsVt -and (-not [Console]::IsOutputRedirected) -and (-not $script:SetupNoColor)

  Write-SetupTitle
  if ([string]::IsNullOrWhiteSpace($SetupEndpoint)) {
    Write-SetupFatal "`$SetupEndpoint must be set to this gateway origin (e.g. https://gateway.example)."
    return 1
  }
  if ($SetupEndpoint -notmatch '^https?://.+') {
    Write-SetupFatal "`$SetupEndpoint must be an http(s) origin, got $SetupEndpoint"
    return 1
  }
  if ($SetupAgent -notin @('claude', 'codex')) {
    Write-SetupFatal "unknown setup agent: $SetupAgent"
    return 1
  }
  Write-SetupMetadata 'Endpoint' $SetupEndpoint
  Write-SetupMetadata 'API Key' $SetupApiKeyName

  # Each primary error is already reported at its detection site. The boundary
  # surfaces any unexpected exception after redaction and returns a nonzero
  # status without adding a redundant single-agent summary.
  if ($SetupAgent -eq 'claude') {
    try {
      Set-SetupClaude
    } catch {
      if ($_.Exception.Message -ne 'setup-handled') { Write-SetupError (Protect-SetupSecret ([string]$_.Exception.Message)) }
      return 1
    }
  } else {
    try {
      Set-SetupCodex
    } catch {
      if ($_.Exception.Message -ne 'setup-handled') { Write-SetupError (Protect-SetupSecret ([string]$_.Exception.Message)) }
      return 1
    }
  }
  return 0
}

exit (Main)
