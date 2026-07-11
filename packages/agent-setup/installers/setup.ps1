# Floway agent setup installer (PowerShell). The gateway prepends the
# language-native assignment prefix before this fixed body.
#
# Each selected agent runs as an independent transaction so one failure does not
# skip or roll back the other.

$ErrorActionPreference = 'Stop'
# Keep native (non-cmdlet) command failures from auto-throwing on PowerShell
# 7.3+, so explicit $LASTEXITCODE checks stay authoritative across versions.
$PSNativeCommandUseErrorActionPreference = $false

# The server prefix uses ordinary variables, but defensively remove identically
# named ambient environment variables so installers and CLI subprocesses cannot
# inherit the API key.
Remove-Item Env:FLOWAY_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:FlowayApiKey -ErrorAction SilentlyContinue

# The wrapping command supplies $FlowayBaseUrl as an in-process variable.
# Validate it before mutation; installer and CLI subprocesses never inherit it.
if ([string]::IsNullOrWhiteSpace($FlowayBaseUrl)) {
  Write-Host "Floway: `$FlowayBaseUrl must be set to this gateway origin (e.g. https://gateway.example)."
  exit 1
}
if ($FlowayBaseUrl -notmatch '^https?://.+') {
  Write-Host "Floway: `$FlowayBaseUrl must be an http(s) origin, got $FlowayBaseUrl"
  exit 1
}

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

function Get-FlowayCliExe {
  param([string]$Name, [string]$Label, [string[]]$Candidates)
  $found = New-Object System.Collections.Generic.List[string]
  $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { $found.Add($command.Source) }
  foreach ($candidate in $Candidates) {
    if ((Test-Path -LiteralPath $candidate) -and (-not $found.Contains($candidate))) { $found.Add($candidate) }
  }
  if ($found.Count -eq 0) { return $null }
  if ($found.Count -gt 1) { Write-Host "Floway: multiple $Label installations detected; using $($found[0])." }
  return $found[0]
}

function Restore-FlowayManagedFile {
  param([bool]$Existed, [string]$Backup, [string]$Path, [switch]$Protect)
  if ($Existed) {
    if ($Backup -and (Test-Path -LiteralPath $Backup)) {
      Move-Item -LiteralPath $Backup -Destination $Path -Force
      if ($Protect) { Protect-FlowayFile $Path }
    }
  } elseif (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Force
  }
}

# --- Claude Code ------------------------------------------------------------

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

function Restore-FlowayClaudeSettings {
  Restore-FlowayManagedFile -Existed $script:ClaudeSettingsExisted -Backup $script:ClaudeSettingsBackup -Path $script:ClaudeSettingsPath -Protect
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

# Run a child process with its stdout and stderr redirected into in-process
# pipes, bounded by a deadline. On timeout the whole process tree is terminated
# and the call throws; otherwise the exit code and combined stdout+stderr are
# returned. Arguments are fixed internal tokens, never external input.
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

  $headers = @{
    'Authorization'     = "Bearer $FlowayApiKey"
    'x-api-key'         = $FlowayApiKey
    'anthropic-version' = '2023-06-01'
  }
  $modelUri = ($FlowayBaseUrl.TrimEnd('/')) + '/v1/models'
  try {
    Invoke-WebRequest -Uri $modelUri -Headers $headers -Method Get -UseBasicParsing -TimeoutSec 30 | Out-Null
  } catch {
    throw "could not reach the authenticated model directory at $modelUri"
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
  # Ref: https://docs.claude.com/en/docs/claude-code/troubleshoot-install
  $candidates = @(
    (Join-Path $HOME '.local/bin/claude'),
    (Join-Path $HOME '.local/bin/claude.exe'),
    (Join-Path $HOME '.claude/local/claude')
  )
  if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.local\bin\claude.exe') }
  $exe = Get-FlowayCliExe -Name claude -Label 'Claude Code' -Candidates $candidates
  if (-not $exe) {
    Write-Host "Floway: Claude Code CLI not found; installing the official user-local build..."
    Install-FlowayClaude
    $exe = Get-FlowayCliExe -Name claude -Label 'Claude Code' -Candidates $candidates
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

# The refresh_token slot is a fixed non-secret placeholder: the gateway
# authenticates the data plane with the API key carried as access_token and
# never rotates a ChatGPT refresh token. Codex only reads it back.
$FlowayCodexRefreshNoop = 'floway-managed-no-refresh'

# Codex only decodes this alg=none placeholder for login status; access_token
# authenticates the gateway. Literal JSON keeps byte layout and key order stable
# across PowerShell versions and matches the Bash installer.
# Ref: packages/provider-codex/src/auth/jwt.ts (the decode-only claim reader).
function Get-FlowayCodexIdToken {
  $authority = ([Uri]$FlowayBaseUrl).Authority
  $encode = {
    param([string]$Json)
    [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Json)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  }
  $headerJson = '{"alg":"none","typ":"JWT"}'
  $payloadJson = '{"email":"floway@' + $authority + '","https://api.openai.com/auth":{"chatgpt_plan_type":"pro_plus","chatgpt_user_id":"user-floway","chatgpt_account_id":"acct-floway"}}'
  return ((& $encode $headerJson) + '.' + (& $encode $payloadJson) + '.c2ln')
}

# Install the official user-local Codex build. CODEX_NON_INTERACTIVE keeps the
# installer from prompting. The FLOWAY_INSTALLER_TEST_INSTALL_CODEX_SCRIPT hook —
# read from the ambient environment, never emitted by the gateway — substitutes
# a fake installer under test.
function Install-FlowayCodex {
  $hadNonInteractive = Test-Path Env:CODEX_NON_INTERACTIVE
  $previousNonInteractive = $env:CODEX_NON_INTERACTIVE
  try {
    $env:CODEX_NON_INTERACTIVE = 'true'
    if ($env:FLOWAY_INSTALLER_TEST_INSTALL_CODEX_SCRIPT) {
      $timeoutSeconds = if ($env:FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS) { [int]$env:FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS } else { 120 }
      $installer = Invoke-FlowayProcess -Exe $env:FLOWAY_INSTALLER_TEST_INSTALL_CODEX_SCRIPT -Arguments @() -TimeoutSeconds $timeoutSeconds
      if ($installer.ExitCode -ne 0) { throw "the test codex installer hook failed." }
      return
    }
    # Ref: https://github.com/openai/codex README ("irm https://chatgpt.com/codex/install.ps1 | iex").
    $installerUri = if ($env:FLOWAY_INSTALLER_TEST_CODEX_URL) { $env:FLOWAY_INSTALLER_TEST_CODEX_URL } else { 'https://chatgpt.com/codex/install.ps1' }
    Invoke-FlowayRemoteInstaller -Uri $installerUri
  } finally {
    if ($hadNonInteractive) { $env:CODEX_NON_INTERACTIVE = $previousNonInteractive }
    else { Remove-Item Env:CODEX_NON_INTERACTIVE -ErrorAction SilentlyContinue }
  }
}

# Back up both managed files before any mutation, recording the absence of each
# so rollback can distinguish "restore" from "remove".
function Backup-FlowayCodexFiles {
  $script:CodexConfigExisted = $false
  $script:CodexAuthExisted = $false
  $script:CodexConfigBackup = $null
  $script:CodexAuthBackup = $null
  # DateTimeOffset.ToUnixTimeMilliseconds is unavailable on the .NET Framework
  # version bundled with the Windows PowerShell 5.1 baseline.
  $stamp = [long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds
  if (Test-Path -LiteralPath $script:CodexConfigPath) {
    $script:CodexConfigExisted = $true
    $script:CodexConfigBackup = "$($script:CodexConfigPath).floway-backup.$stamp.$PID"
    Copy-Item -LiteralPath $script:CodexConfigPath -Destination $script:CodexConfigBackup
  }
  if (Test-Path -LiteralPath $script:CodexAuthPath) {
    $script:CodexAuthExisted = $true
    $script:CodexAuthBackup = "$($script:CodexAuthPath).floway-backup.$stamp.$PID"
    # The auth backup holds the original ChatGPT login. If hardening its ACL
    # fails after the copy, the copy is an unprotected secret on disk — remove it
    # before rethrowing rather than leaving a readable backup behind. The
    # original is still untouched (backup runs before any mutation), and leaving
    # CodexAuthExisted true keeps a later restore from deleting it: with a null
    # backup, restore simply leaves the original in place.
    try {
      Copy-Item -LiteralPath $script:CodexAuthPath -Destination $script:CodexAuthBackup
      Protect-FlowayFile $script:CodexAuthBackup
    } catch {
      if (Test-Path -LiteralPath $script:CodexAuthBackup) {
        Remove-Item -LiteralPath $script:CodexAuthBackup -Force
      }
      $script:CodexAuthBackup = $null
      throw
    }
  }
}

function Restore-FlowayCodexFiles {
  Restore-FlowayManagedFile -Existed $script:CodexConfigExisted -Backup $script:CodexConfigBackup -Path $script:CodexConfigPath
  Restore-FlowayManagedFile -Existed $script:CodexAuthExisted -Backup $script:CodexAuthBackup -Path $script:CodexAuthPath -Protect
}

# Drive `codex app-server` over redirected stdin/stdout/stderr: initialize ->
# initialized -> config/batchWrite. stderr is drained asynchronously so a chatty
# server cannot fill the pipe buffer and deadlock. Each response read is bounded
# by the remaining deadline; a timeout terminates the process tree. Unrelated
# notifications are demultiplexed by id. Returns the batchWrite result object.
function Invoke-FlowayCodexAppServerBatchWrite {
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
  if (-not $process.Start()) { throw "failed to start the Codex app-server." }
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $budgetMs = $TimeoutSeconds * 1000
  $result = $null
  try {
    $readMatching = {
      param([int]$WantId)
      while ($true) {
        $remaining = $budgetMs - $watch.ElapsedMilliseconds
        if ($remaining -le 0) { throw "the Codex app-server timed out before responding." }
        $task = $process.StandardOutput.ReadLineAsync()
        if (-not $task.Wait([int]$remaining)) { throw "the Codex app-server timed out before responding." }
        $line = $task.GetAwaiter().GetResult()
        if ($null -eq $line) { throw "the Codex app-server exited before responding." }
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $msg = $line | ConvertFrom-Json } catch { throw "the Codex app-server returned a malformed response." }
        if ($msg.id -ne $WantId) { continue }
        if ($null -ne $msg.error) { throw "the Codex app-server reported an error writing the configuration." }
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
      Stop-FlowayProcessTree $process
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
function Write-FlowayCodexConfig {
  param([string]$Exe)
  $codexBase = ($FlowayBaseUrl.TrimEnd('/')) + '/azure-api.codex'
  $edits = @(
    @{ keyPath = 'model_provider'; mergeStrategy = 'replace'; value = 'floway' },
    @{ keyPath = 'model_providers.floway.name'; mergeStrategy = 'replace'; value = 'Floway' },
    @{ keyPath = 'model_providers.floway.base_url'; mergeStrategy = 'replace'; value = $codexBase },
    @{ keyPath = 'model_providers.floway.wire_api'; mergeStrategy = 'replace'; value = 'responses' },
    @{ keyPath = 'model_providers.floway.supports_websockets'; mergeStrategy = 'replace'; value = $true },
    @{ keyPath = 'chatgpt_base_url'; mergeStrategy = 'replace'; value = $codexBase },
    @{ keyPath = 'features.apps'; mergeStrategy = 'replace'; value = $false },
    @{ keyPath = 'cli_auth_credentials_store'; mergeStrategy = 'replace'; value = 'file' },
    @{ keyPath = 'model'; mergeStrategy = 'replace'; value = $FlowayCodexModel },
    @{ keyPath = 'model_reasoning_effort'; mergeStrategy = 'replace'; value = $FlowayCodexReasoningEffort }
  )
  $timeoutSeconds = if ($env:FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS) { [int]$env:FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS } else { 60 }
  $result = Invoke-FlowayCodexAppServerBatchWrite -Exe $Exe -Edits $edits -TimeoutSeconds $timeoutSeconds
  $status = [string]$result.status
  if ($status -eq 'ok') {
    Write-Host "Floway: Codex base configuration written."
  } elseif ($status -eq 'okOverridden') {
    $message = if ($result.overriddenMetadata -and $result.overriddenMetadata.message) { [string]$result.overriddenMetadata.message } else { 'an override layer applies' }
    $layer = 'unknown'
    if ($result.overriddenMetadata -and $result.overriddenMetadata.overridingLayer -and $result.overriddenMetadata.overridingLayer.name) {
      $layer = [string]$result.overriddenMetadata.overridingLayer.name.type
    }
    Write-Host "Floway: Codex base configuration written, but a higher-precedence layer overrides it ($message; layer: $layer)."
  } else {
    throw "the Codex app-server did not confirm the configuration (status: $status)."
  }
}

# Stage a minimal ChatGPT-mode auth.json: the locally assembled identity token, the
# in-memory API key as access_token, a noop refresh placeholder, and a fresh
# RFC3339 timestamp. The stage is created and owner-only protected before any
# secret is written, validated, then atomically moved into place.
function Write-FlowayCodexAuth {
  $now = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH':'mm':'ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
  $auth = [ordered]@{
    OPENAI_API_KEY = $null
    tokens         = [ordered]@{
      id_token      = $FlowayCodexIdToken
      access_token  = $FlowayApiKey
      refresh_token = $FlowayCodexRefreshNoop
    }
    last_refresh   = $now
  }
  $json = $auth | ConvertTo-Json -Depth 10
  $stage = "$($script:CodexAuthPath).floway-stage.$PID"
  try {
    # The stage exists and is owner-only before any secret JSON is written.
    [System.IO.File]::Create($stage).Dispose()
    Protect-FlowayFile $stage
    [System.IO.File]::WriteAllText($stage, $json, (New-Object System.Text.UTF8Encoding($false)))
    $check = Get-Content -Raw -LiteralPath $stage | ConvertFrom-Json
    if (($check.tokens.id_token -ne $FlowayCodexIdToken) -or ($check.tokens.access_token -ne $FlowayApiKey)) {
      throw "staged Codex auth failed validation."
    }
    $runningOnWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
    if ($script:CodexAuthExisted -and $runningOnWindows) {
      # File.Replace preserves the destination ACL, so tighten it first.
      Protect-FlowayFile $script:CodexAuthPath
      [System.IO.File]::Replace($stage, $script:CodexAuthPath, $null)
    } else {
      Move-Item -LiteralPath $stage -Destination $script:CodexAuthPath -Force
    }
  } catch {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force }
    throw
  }
}

# Read the gateway's authenticated Codex model directory. No inference request
# is issued. Transport/auth and JSON-shape failures remain distinct from a valid
# catalog that simply lacks the selected model; none of the errors carries the
# in-process Authorization header.
function Read-FlowayCodexModelCatalog {
  $headers = @{ 'Authorization' = "Bearer $FlowayApiKey" }
  $uri = ($FlowayBaseUrl.TrimEnd('/')) + '/azure-api.codex/models'
  try {
    $response = Invoke-WebRequest -Uri $uri -Headers $headers -Method Get -UseBasicParsing -TimeoutSec 30
  } catch {
    throw "could not reach the authenticated Codex model directory at $uri"
  }
  try {
    $body = [string]$response.Content | ConvertFrom-Json
  } catch {
    throw "the authenticated Codex model directory did not return valid JSON."
  }
  if (($body -isnot [System.Management.Automation.PSCustomObject]) -or ($body.PSObject.Properties.Name -notcontains 'models') -or ($body.models -isnot [System.Array])) {
    throw "the authenticated Codex model directory returned an invalid catalog shape."
  }
  $slugs = @()
  foreach ($model in $body.models) {
    if (($model -isnot [System.Management.Automation.PSCustomObject]) -or ($model.PSObject.Properties.Name -notcontains 'slug') -or ($model.slug -isnot [string])) {
      throw "the authenticated Codex model directory returned an invalid catalog shape."
    }
    $slugs += [string]$model.slug
  }
  return $slugs
}

# Verify Codex without inference: reparse the staged auth and assert the identity
# token and key (never printing them), print the raw CLI version, and reach the
# authenticated model directory (confirming the selected model when one is set).
function Invoke-FlowayCodexVerify {
  param([string]$Exe)
  $auth = Get-Content -Raw -LiteralPath $script:CodexAuthPath | ConvertFrom-Json
  if (($auth.tokens.id_token -ne $FlowayCodexIdToken) -or ($auth.tokens.access_token -ne $FlowayApiKey)) {
    throw "the written Codex auth did not reparse as expected."
  }
  $timeoutSeconds = if ($env:FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS) { [int]$env:FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS } else { 30 }
  $version = Invoke-FlowayProcess -Exe $Exe -Arguments @('--version') -TimeoutSeconds $timeoutSeconds
  if ($version.ExitCode -ne 0) { throw "``codex --version`` failed." }
  Write-Host "Floway: Codex version: $($version.Output.Trim())"
  $modelSlugs = @(Read-FlowayCodexModelCatalog)
  if ($FlowayCodexModel -and ($modelSlugs -notcontains $FlowayCodexModel)) {
    throw "the selected Codex model $FlowayCodexModel is not in the gateway catalog."
  }
  Write-Host "Floway: reached the authenticated Codex model directory (no inference issued)."
}

# Configure Codex as one transactional unit. Both managed files are backed up
# first; a failure in the config write, auth staging, or verification restores
# both (or removes newly created files). A freshly installed CLI is never
# uninstalled.
function Set-FlowayCodex {
  Write-Host "Floway: configuring Codex..."
  # Ref: https://github.com/openai/codex/blob/main/scripts/install/install.sh
  $candidates = @(
    (Join-Path $HOME '.local/bin/codex'),
    (Join-Path $HOME '.local/bin/codex.exe')
  )
  if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.local\bin\codex.exe') }
  $exe = Get-FlowayCliExe -Name codex -Label Codex -Candidates $candidates
  if (-not $exe) {
    Write-Host "Floway: Codex CLI not found; installing the official user-local build..."
    Install-FlowayCodex
    $exe = Get-FlowayCliExe -Name codex -Label Codex -Candidates $candidates
    if (-not $exe) { throw "Codex CLI is unavailable and could not be installed." }
  }
  $script:CodexHomeDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
  $script:CodexConfigPath = Join-Path $script:CodexHomeDir 'config.toml'
  $script:CodexAuthPath = Join-Path $script:CodexHomeDir 'auth.json'
  $script:FlowayCodexIdToken = Get-FlowayCodexIdToken
  if (-not (Test-Path -LiteralPath $script:CodexHomeDir)) {
    New-Item -ItemType Directory -Path $script:CodexHomeDir -Force | Out-Null
  }
  Backup-FlowayCodexFiles
  try {
    Write-FlowayCodexConfig -Exe $exe
    Write-FlowayCodexAuth
    Invoke-FlowayCodexVerify -Exe $exe
  } catch {
    Write-Host "Floway: Codex configuration failed; rolling back configuration and auth."
    Restore-FlowayCodexFiles
    throw
  }
  Write-Host "Floway: Codex configured."
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
