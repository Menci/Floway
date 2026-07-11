# Floway agent setup installer (PowerShell).
#
# Fixed, checked-in body. The language-native assignment prefix (the $Floway*
# variables and a trace-suppressing `Set-PSDebug -Off`) is prepended per
# request by the gateway, so this file starts straight at the installer logic.
#
# Claude Code and Codex are configured as independent transactional units: a
# failure in one neither rolls back nor skips the other, and any selected-agent
# failure makes the whole script exit non-zero. Each agent runs inside its own
# try/catch so a terminating error is contained and rolled back rather than
# aborting the other agent.

$ErrorActionPreference = 'Stop'
# Keep native (non-cmdlet) command failures from auto-throwing on PowerShell
# 7.3+, so explicit $LASTEXITCODE checks stay authoritative across versions.
$PSNativeCommandUseErrorActionPreference = $false

# The server prefix uses ordinary variables, but defensively remove identically
# named ambient environment variables so installers and CLI subprocesses cannot
# inherit the API key.
Remove-Item Env:FLOWAY_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:FlowayApiKey -ErrorAction SilentlyContinue

# --- common helpers ---------------------------------------------------------

function Set-FlowayProp {
  param($Target, [string]$Name, $Value)
  if ($Target.PSObject.Properties.Name -contains $Name) { $Target.$Name = $Value }
  else { $Target | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function Remove-FlowayProp {
  param($Target, [string]$Name)
  if ($Target.PSObject.Properties.Name -contains $Name) { $Target.PSObject.Properties.Remove($Name) }
}

# A null optional value means "remove this managed key"; any other value is set.
function Set-FlowayOptionalProp {
  param($Target, [string]$Name, $Value)
  if ($null -eq $Value) { Remove-FlowayProp $Target $Name } else { Set-FlowayProp $Target $Name $Value }
}

# Redact every occurrence of the API key from text before it is surfaced.
function Protect-FlowaySecret {
  param([string]$Text)
  return ($Text -replace [regex]::Escape($FlowayApiKey), '***')
}

# Restrict a file to the current user: chmod 0600 on Unix, an inheritance-free
# owner-only ACL on Windows.
function Protect-FlowayFile {
  param([string]$Path)
  if (($PSVersionTable.PSVersion.Major -ge 6) -and (-not $IsWindows)) {
    & chmod 600 $Path
    if ($LASTEXITCODE -ne 0) { throw "could not restrict $Path to mode 0600." }
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
function Stop-FlowayProcessTree {
  param([System.Diagnostics.Process]$Process)
  $runningOnWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
  if ($runningOnWindows) {
    & taskkill.exe /PID $Process.Id /T /F *> $null
    if ($LASTEXITCODE -ne 0 -and (-not $Process.HasExited)) {
      throw "taskkill could not terminate process tree $($Process.Id)."
    }
    return
  }
  try {
    # .NET used by PowerShell 7 supports tree-aware termination on Unix.
    $Process.Kill($true)
  } catch {
    if (-not $Process.HasExited) { throw "could not terminate process tree $($Process.Id)." }
  }
}

# Execute a downloaded PowerShell installer in a fresh interpreter. The script
# travels through stdin, while the API key exists only as a variable in this
# parent process and its identically named environment variables were removed.
# The official installer therefore cannot read the credential.
function Invoke-FlowayPowerShellBody {
  param([string]$Body, [int]$TimeoutSeconds)
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $startInfo.Arguments = '-NoProfile -NonInteractive -Command -'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw "failed to start the installer interpreter." }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.StandardInput.Write($Body)
  $process.StandardInput.WriteLine()
  $process.StandardInput.Close()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-FlowayProcessTree $process
    $process.WaitForExit()
    throw "the installer timed out after $TimeoutSeconds seconds."
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($stdout) { Write-Host $stdout.TrimEnd() }
  if ($stderr) { Write-Host $stderr.TrimEnd() }
  if ($process.ExitCode -ne 0) { throw "the installer exited with status $($process.ExitCode)." }
}

# Download an installer, refuse anything that is not a script (region blocks and
# captive portals serve HTML in place of the installer), then run it.
function Invoke-FlowayRemoteInstaller {
  param([string]$Uri)
  $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 60
  $body = [string]$response.Content
  $contentType = [string]$response.Headers['Content-Type']
  $looksLikeHtml = $contentType -match '(?i)^text/html(?:;|$)' -or $body -match '(?is)^\s*(?:<!doctype\s+html|<html(?:\s|>))'
  if ([string]::IsNullOrWhiteSpace($body) -or $looksLikeHtml) {
    throw "the installer download was HTML or empty, not an executable script (a login or region-block page?)."
  }
  $timeoutSeconds = if ($env:FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS) { [int]$env:FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS } else { 120 }
  Invoke-FlowayPowerShellBody -Body $body -TimeoutSeconds $timeoutSeconds
}

# --- Claude Code ------------------------------------------------------------

# Resolve the Claude Code executable. The PATH winner is authoritative; known
# official user-local locations are also consulted so an install that is not on
# PATH is still found, and so multiple installations can be flagged.
# Ref: https://docs.claude.com/en/docs/claude-code/troubleshoot-install
function Get-FlowayClaudeExe {
  $found = New-Object System.Collections.Generic.List[string]
  $command = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { $found.Add($command.Source) }
  $candidates = @(
    (Join-Path $HOME '.local/bin/claude'),
    (Join-Path $HOME '.local/bin/claude.exe'),
    (Join-Path $HOME '.claude/local/claude')
  )
  if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.local\bin\claude.exe') }
  foreach ($candidate in $candidates) {
    if ((Test-Path -LiteralPath $candidate) -and (-not $found.Contains($candidate))) { $found.Add($candidate) }
  }
  if ($found.Count -eq 0) { return $null }
  if ($found.Count -gt 1) { Write-Host "Floway: multiple Claude Code installations detected; using $($found[0])." }
  return $found[0]
}

# Install the official user-local Claude Code build. The
# FLOWAY_INSTALLER_TEST_INSTALL_CLAUDE_SCRIPT hook — read from the ambient
# environment, never emitted by the gateway — substitutes a fake installer
# under test.
function Install-FlowayClaude {
  if ($env:FLOWAY_INSTALLER_TEST_INSTALL_CLAUDE_SCRIPT) {
    $timeoutSeconds = if ($env:FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS) { [int]$env:FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS } else { 120 }
    $installer = Invoke-FlowayProcess -Exe $env:FLOWAY_INSTALLER_TEST_INSTALL_CLAUDE_SCRIPT -Arguments @() -TimeoutSeconds $timeoutSeconds
    if ($installer.ExitCode -ne 0) { throw "the test installer hook failed." }
    return
  }
  # Ref: https://docs.claude.com/en/docs/claude-code/setup ("Native Install").
  $installerUri = if ($env:FLOWAY_INSTALLER_TEST_CLAUDE_URL) { $env:FLOWAY_INSTALLER_TEST_CLAUDE_URL } else { 'https://claude.ai/install.ps1' }
  Invoke-FlowayRemoteInstaller -Uri $installerUri
}

# Restore the settings file to its pre-run state: replace it from the backup
# when one exists, or remove the file entirely when this run created it.
function Restore-FlowayClaudeSettings {
  if ($script:ClaudeSettingsExisted) {
    if ($script:ClaudeSettingsBackup -and (Test-Path -LiteralPath $script:ClaudeSettingsBackup)) {
      Move-Item -LiteralPath $script:ClaudeSettingsBackup -Destination $script:ClaudeSettingsPath -Force
      Protect-FlowayFile $script:ClaudeSettingsPath
    }
  } elseif (Test-Path -LiteralPath $script:ClaudeSettingsPath) {
    Remove-Item -LiteralPath $script:ClaudeSettingsPath -Force
  }
}

# Surgically merge the managed keys into the Claude settings file: validate the
# existing document, back it up, construct and validate the replacement in the
# same directory, then atomically rename it into place with owner-only access.
function Write-FlowayClaudeSettings {
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
    try { $document = $raw | ConvertFrom-Json } catch { throw "$($script:ClaudeSettingsPath) is not valid JSON; leaving it untouched." }
    if ($document -isnot [System.Management.Automation.PSCustomObject]) { throw "existing Claude settings root is not a JSON object." }
    if (($document.PSObject.Properties.Name -contains 'env') -and ($document.env -isnot [System.Management.Automation.PSCustomObject])) {
      throw "existing Claude settings env is not a JSON object."
    }
    # DateTimeOffset.ToUnixTimeMilliseconds is unavailable on the .NET
    # Framework version bundled with the Windows PowerShell 5.1 baseline.
    $stamp = [long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds
    $script:ClaudeSettingsBackup = "$($script:ClaudeSettingsPath).floway-backup.$stamp.$PID"
    try {
      Copy-Item -LiteralPath $script:ClaudeSettingsPath -Destination $script:ClaudeSettingsBackup
      Protect-FlowayFile $script:ClaudeSettingsBackup
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
  Set-FlowayProp $document.env 'ANTHROPIC_BASE_URL' $FlowayBaseUrl
  Set-FlowayProp $document.env 'ANTHROPIC_AUTH_TOKEN' $FlowayApiKey
  Set-FlowayOptionalProp $document.env 'ANTHROPIC_MODEL' $FlowayClaudeModel
  Set-FlowayOptionalProp $document.env 'ANTHROPIC_DEFAULT_SONNET_MODEL' $FlowayClaudeDefaultSonnetModel
  Set-FlowayOptionalProp $document.env 'ANTHROPIC_DEFAULT_HAIKU_MODEL' $FlowayClaudeDefaultHaikuModel
  if ($FlowayClaudeModelDiscovery) { Set-FlowayProp $document.env 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY' '1' }
  else { Remove-FlowayProp $document.env 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY' }
  Set-FlowayOptionalProp $document 'effortLevel' $FlowayClaudeEffortLevel

  $stage = "$($script:ClaudeSettingsPath).floway-stage.$PID"
  try {
    # The stage exists and is owner-only before any secret JSON is written.
    [System.IO.File]::Create($stage).Dispose()
    Protect-FlowayFile $stage
    $json = $document | ConvertTo-Json -Depth 100
    # Write UTF-8 without a BOM on every PowerShell version so downstream JSON
    # parsers accept the file.
    [System.IO.File]::WriteAllText($stage, $json, (New-Object System.Text.UTF8Encoding($false)))
    $check = Get-Content -Raw -LiteralPath $stage | ConvertFrom-Json
    if (($check.env.ANTHROPIC_BASE_URL -ne $FlowayBaseUrl) -or ($check.env.ANTHROPIC_AUTH_TOKEN -ne $FlowayApiKey)) {
      throw "staged Claude settings failed validation."
    }
    # Windows PowerShell 5.1 only runs on Windows and has no $IsWindows
    # automatic variable; PowerShell 6+ exposes it on every platform.
    $runningOnWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
    if ($script:ClaudeSettingsExisted -and $runningOnWindows) {
      # File.Replace preserves the destination ACL, so tighten it first rather
      # than letting a permissive historical DACL survive the atomic replace.
      Protect-FlowayFile $script:ClaudeSettingsPath
      [System.IO.File]::Replace($stage, $script:ClaudeSettingsPath, $null)
    } else {
      # Move-Item is an atomic same-filesystem rename on Unix and creates a new
      # target on Windows. Windows replacing an existing target uses File.Replace.
      Move-Item -LiteralPath $stage -Destination $script:ClaudeSettingsPath -Force
    }
  } catch {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force }
    Restore-FlowayClaudeSettings
    throw
  }
}

# Confirm the gateway's authenticated model directory answers. No inference
# request is issued. The key travels in an in-process header table, never in a
# process argument list.
function Invoke-FlowayProcess {
  param([string]$Exe, [string[]]$Arguments, [int]$TimeoutSeconds)
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
  if (-not $process.Start()) { throw "failed to start $Exe." }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-FlowayProcessTree $process
    $process.WaitForExit()
    throw "$Exe timed out after $TimeoutSeconds seconds."
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  [PSCustomObject]@{ ExitCode = $process.ExitCode; Output = ($stdout + $stderr) }
}

function Test-FlowayModelDirectory {
  $headers = @{
    'Authorization'     = "Bearer $FlowayApiKey"
    'x-api-key'         = $FlowayApiKey
    'anthropic-version' = '2023-06-01'
  }
  $uri = ($FlowayBaseUrl.TrimEnd('/')) + '/v1/models'
  try {
    Invoke-WebRequest -Uri $uri -Headers $headers -Method Get -UseBasicParsing -TimeoutSec 30 | Out-Null
    return $true
  } catch {
    return $false
  }
}

# Verify the Claude configuration without inference: reparse the written
# settings, print the raw CLI version, reach the authenticated model directory,
# and run `claude doctor` when the subcommand exists. Doctor output is redacted
# before it is surfaced.
function Invoke-FlowayClaudeVerify {
  param([string]$Exe)
  $document = Get-Content -Raw -LiteralPath $script:ClaudeSettingsPath | ConvertFrom-Json
  if (($document.env.ANTHROPIC_BASE_URL -ne $FlowayBaseUrl) -or ($document.env.ANTHROPIC_AUTH_TOKEN -ne $FlowayApiKey)) {
    throw "the written Claude settings did not reparse as expected."
  }

  $timeoutSeconds = if ($env:FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS) { [int]$env:FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS } else { 30 }
  $version = Invoke-FlowayProcess -Exe $Exe -Arguments @('--version') -TimeoutSeconds $timeoutSeconds
  if ($version.ExitCode -ne 0) { throw "``claude --version`` failed." }
  Write-Host "Floway: Claude Code version: $($version.Output.Trim())"

  if (-not (Test-FlowayModelDirectory)) {
    throw "could not reach the authenticated model directory at $($FlowayBaseUrl.TrimEnd('/'))/v1/models"
  }
  Write-Host "Floway: reached the authenticated model directory (no inference issued)."

  $doctorHelp = Invoke-FlowayProcess -Exe $Exe -Arguments @('doctor', '--help') -TimeoutSeconds $timeoutSeconds
  if ($doctorHelp.ExitCode -eq 0) {
    $doctor = Invoke-FlowayProcess -Exe $Exe -Arguments @('doctor') -TimeoutSeconds $timeoutSeconds
    if ($doctor.ExitCode -ne 0) {
      Write-Host "Floway: claude doctor reported a problem:`n$(Protect-FlowaySecret $doctor.Output)"
      throw "claude doctor reported a problem."
    }
    Write-Host "Floway: claude doctor reported no blocking issues."
  } elseif ($doctorHelp.Output -match '(?i)(unknown|unrecognized|invalid|no such).*(command|subcommand).*doctor|doctor.*(unknown|unrecognized|invalid).*(command|subcommand)') {
    Write-Host "Floway: this Claude Code build has no doctor command; skipping that check."
  } else {
    Write-Host "Floway: claude doctor capability check failed:`n$(Protect-FlowaySecret $doctorHelp.Output)"
    throw "claude doctor capability check failed."
  }
}

# Configure Claude Code as one transactional unit. Verification failure rolls
# back the settings write; a freshly installed CLI is never uninstalled.
function Set-FlowayClaude {
  Write-Host "Floway: configuring Claude Code..."
  $exe = Get-FlowayClaudeExe
  if (-not $exe) {
    Write-Host "Floway: Claude Code CLI not found; installing the official user-local build..."
    Install-FlowayClaude
    $exe = Get-FlowayClaudeExe
    if (-not $exe) { throw "Claude Code CLI is unavailable and could not be installed." }
  }
  Write-FlowayClaudeSettings
  try {
    Invoke-FlowayClaudeVerify $exe
  } catch {
    Write-Host "Floway: Claude Code verification failed; rolling back settings."
    Restore-FlowayClaudeSettings
    throw
  }
  Write-Host "Floway: Claude Code configured."
}

# --- Codex ------------------------------------------------------------------

# Codex configuration is implemented in the next task. Throwing keeps a
# selected-but-unconfigured Codex from being summarized as done.
function Set-FlowayCodex {
  throw "Codex configuration is not implemented in this build yet."
}

# --- run --------------------------------------------------------------------

$script:ClaudeResult = 'skipped'
$script:CodexResult = 'skipped'
$overall = 0

if ($FlowayInstallClaude) {
  try {
    Set-FlowayClaude
    $script:ClaudeResult = 'configured'
  } catch {
    Write-Host "Floway: Claude Code setup failed: $(Protect-FlowaySecret ([string]$_.Exception.Message))"
    $script:ClaudeResult = 'failed'
    $overall = 1
  }
}

if ($FlowayInstallCodex) {
  try {
    Set-FlowayCodex
    $script:CodexResult = 'configured'
  } catch {
    Write-Host "Floway: Codex setup failed: $(Protect-FlowaySecret ([string]$_.Exception.Message))"
    $script:CodexResult = 'failed'
    $overall = 1
  }
}

Write-Host ""
Write-Host "Floway agent setup summary:"
Write-Host "  Claude Code: $($script:ClaudeResult)"
Write-Host "  Codex:       $($script:CodexResult)"

exit $overall
