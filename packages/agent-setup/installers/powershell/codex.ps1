# Codex Agent Setup fragment.

# Install the official Codex package. CODEX_NON_INTERACTIVE keeps the direct
# installer from prompting. We track upstream's maintained scripts so release-
# metadata fixes arrive without waiting for a Floway update. Reviewed sources:
# https://github.com/openai/codex/blob/d3fc1950a920f98e7fa9f11056667cdf911c38df/README.md#L18-L37
# https://github.com/openai/codex/blob/d3fc1950a920f98e7fa9f11056667cdf911c38df/scripts/install/install.sh
# https://github.com/openai/codex/blob/d3fc1950a920f98e7fa9f11056667cdf911c38df/scripts/install/install.ps1
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
      $timeoutSeconds = Get-SetupTimeoutSeconds 120
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
    $brew = if ($platform -eq 'macos') { Get-Command brew -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 } else { $null }
    if ($brew) {
      Write-SetupInfo 'Codex CLI not found; installing with Homebrew'
      Install-SetupHomebrewCask -Cask 'codex'
    } elseif ($npm) {
      Write-SetupInfo 'Codex CLI not found; installing with npm'
      Install-SetupNpmPackage -Package '@openai/codex'
    } elseif ($platform -eq 'windows') {
      Write-SetupInfo 'Codex CLI not found; installing from GitHub'
      Invoke-SetupRemoteInstaller -Uri 'https://raw.githubusercontent.com/openai/codex/refs/heads/main/scripts/install/install.ps1'
    } else {
      Write-SetupInfo 'Codex CLI not found; installing from GitHub'
      Invoke-SetupRemoteInstaller -Uri 'https://raw.githubusercontent.com/openai/codex/refs/heads/main/scripts/install/install.sh' -Shell
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

function Complete-SetupCodexFiles {
  Remove-SetupOlderBackups -Path $script:CodexConfigPath -Keep $script:CodexConfigBackup
  Remove-SetupOlderBackups -Path $script:CodexTokenPath -Keep $script:CodexTokenBackup
  if ($script:CodexTokenBackup -and (Test-Path -LiteralPath $script:CodexTokenBackup)) {
    Remove-Item -LiteralPath $script:CodexTokenBackup -Force -ErrorAction Stop
  }
  $script:CodexTokenBackup = $null
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
  $runningOnWindows = Test-SetupIsWindows
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
  # standalone_web_search is under development, so its explicit opt-in is
  # paired with the top-level warning suppression instead of warning every run.
  # https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L901-L905
  # https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L1393-L1439
  $edits = @(
    @{ keyPath = 'model_provider'; mergeStrategy = 'replace'; value = 'floway' },
    @{ keyPath = 'suppress_unstable_features_warning'; mergeStrategy = 'replace'; value = $true },
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
  $timeoutSeconds = Get-SetupTimeoutSeconds 60
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
    $runningOnWindows = Test-SetupIsWindows
    if ($script:CodexTokenExisted -and $runningOnWindows) {
      # File.Replace preserves the destination ACL, so tighten it first.
      Protect-SetupFile $script:CodexTokenPath
      # PowerShell binds ordinary $null to String.Empty for a .NET string
      # parameter; NullString passes an actual null backup path.
      # https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.language.nullstring
      [System.IO.File]::Replace($stage, $script:CodexTokenPath, [System.Management.Automation.Language.NullString]::Value)
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
  $timeoutSeconds = Get-SetupTimeoutSeconds 30
  $version = Invoke-SetupProcess -Exe $Exe -Arguments @('--version') -TimeoutSeconds $timeoutSeconds -TimeoutMessage '``codex --version`` timed out.'
  if ($version.ExitCode -ne 0) { Stop-Setup "``codex --version`` failed." }
  Write-SetupInfo "Codex version: $($version.Output.Trim())"
}

# Install, then configure Codex as one transactional config/token write. A
# freshly installed CLI is never uninstalled when configuration fails.
function Set-SetupAgent {
  Write-SetupAgentNotice 'Installing' 'Codex'
  # Upstream installs into these user-local candidates by default:
  # https://github.com/openai/codex/blob/d3fc1950a920f98e7fa9f11056667cdf911c38df/scripts/install/install.sh
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

  Write-SetupAgentNotice 'Configuring' 'Codex'
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
  try {
    Complete-SetupCodexFiles
  } catch {
    Write-SetupWarn "Codex backup cleanup failed; rolling back configuration and token."
    Restore-SetupCodexFiles
    throw
  }
  Write-SetupInfo ('Written to `' + $writtenConfigPath + '`.')
  Write-SetupInfo ('Written to `' + $script:CodexTokenPath + '`.')
  Write-SetupAgentNotice 'Completed Agent Setup' 'Codex'
}


$global:LASTEXITCODE = Main 'Codex'
