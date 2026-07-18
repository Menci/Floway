# Claude Code Agent Setup fragment.

# Install the official Claude Code package. The
# AGENT_SETUP_TEST_INSTALL_CLAUDE_SCRIPT hook — read from the ambient
# environment, never emitted by the gateway — substitutes a fake installer
# under test.
function Install-SetupClaude {
  if ($env:AGENT_SETUP_TEST_INSTALL_CLAUDE_SCRIPT) {
    Write-SetupInfo 'Claude Code CLI not found; running the test installer'
    $timeoutSeconds = Get-SetupTimeoutSeconds 120
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
  # Refs: https://docs.claude.com/en/docs/claude-code/env-vars
  #       https://docs.claude.com/en/docs/claude-code/model-config#environment-variables
  #       https://docs.claude.com/en/docs/claude-code/settings
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
    if (($check.env.ANTHROPIC_BASE_URL -cne $SetupEndpoint) -or ($check.env.ANTHROPIC_AUTH_TOKEN -cne $SetupApiKey)) {
      Stop-Setup "staged Claude settings failed validation."
    }
    $runningOnWindows = Test-SetupIsWindows
    if ($script:ClaudeSettingsExisted -and $runningOnWindows) {
      # File.Replace preserves the destination ACL, so tighten it first rather
      # than letting a permissive historical DACL survive the atomic replace.
      Protect-SetupFile $script:ClaudeSettingsPath
      # PowerShell binds ordinary $null to String.Empty for a .NET string
      # parameter; NullString passes an actual null backup path.
      # https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.language.nullstring
      [System.IO.File]::Replace($stage, $script:ClaudeSettingsPath, [System.Management.Automation.Language.NullString]::Value)
    } else {
      # Move-Item is an atomic same-filesystem rename on Unix and creates a new
      # target on Windows. Windows replacing an existing target uses File.Replace.
      Move-Item -LiteralPath $stage -Destination $script:ClaudeSettingsPath -Force
    }
    Remove-SetupOlderBackups -Path $script:ClaudeSettingsPath -Keep $script:ClaudeSettingsBackup
  } catch {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force }
    Restore-SetupManagedFile -Existed $script:ClaudeSettingsExisted -Backup $script:ClaudeSettingsBackup -Path $script:ClaudeSettingsPath -OriginalLabel 'file' -CreatedLabel 'Claude settings'
    throw
  }
}

function Write-SetupClaudeVersion {
  param([string]$Exe)
  $timeoutSeconds = Get-SetupTimeoutSeconds 30
  $version = Invoke-SetupProcess -Exe $Exe -Arguments @('--version') -TimeoutSeconds $timeoutSeconds -TimeoutMessage '``claude --version`` timed out.'
  if ($version.ExitCode -ne 0) { Stop-Setup "``claude --version`` failed." }
  Write-SetupInfo "Claude Code version: $($version.Output.Trim())"
}

# Install, then configure Claude Code as one transactional settings write. A
# freshly installed CLI is never uninstalled when configuration fails.
function Set-SetupAgent {
  Write-SetupAgentNotice 'Installing' 'Claude Code'
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

  Write-SetupAgentNotice 'Configuring' 'Claude Code'
  Write-SetupClaudeSettings
  Write-SetupInfo ('Written to `' + $script:ClaudeSettingsPath + '`.')
  Write-SetupAgentNotice 'Completed Agent Setup' 'Claude Code'
}


$global:LASTEXITCODE = Main 'Claude Code'
