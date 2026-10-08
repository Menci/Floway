# Use the maintained upstream installer so release discovery follows upstream.
# https://pi.dev/install.sh

# https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/coding-agent/package.json#L107-L109
function Test-SetupPiNode {
  $nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $nodeCmd) {
    Stop-Setup 'Node.js (>= 22.19) is required to run Pi but was not found on PATH. Install Node.js (>= 22.19) and re-run.'
  }
  $result = Invoke-SetupProcess -Exe $nodeCmd.Source -Arguments @('-v') -TimeoutSeconds (Get-SetupTimeoutSeconds 30)
  if ($result.ExitCode -ne 0) { Stop-Setup ('`node -v` failed. ' + $result.Output) }
  $version = $result.Output.Trim()
  if ($version -notmatch '^v(\d+)\.(\d+)\.(\d+)$') { Stop-Setup 'Node.js returned an invalid version.' }
  if ([Version]$version.Substring(1) -lt [Version]'22.19.0') {
    Write-SetupWarn "Node.js version is $version; Pi requires Node.js >= 22.19."
  }
}

function Get-SetupPiCli {
  $candidates = @(
    (Join-Path $HOME '.local/bin/pi'),
    (Join-Path $HOME '.local/bin/pi.exe'),
    (Join-Path $HOME '.bun/bin/pi'),
    (Join-Path $HOME '.bun/bin/pi.exe'),
    '/opt/homebrew/bin/pi',
    '/usr/local/bin/pi'
  )
  if ($env:LOCALAPPDATA) {
    $candidates += (Join-Path $env:LOCALAPPDATA 'Programs/pi/bin/pi.exe')
  }
  if ($env:APPDATA) {
    $candidates += (Join-Path $env:APPDATA 'npm/pi.cmd')
    $candidates += (Join-Path $env:APPDATA 'npm/pi')
  }
  if ($env:USERPROFILE) {
    $candidates += (Join-Path $env:USERPROFILE '.local/bin/pi.exe')
    $candidates += (Join-Path $env:USERPROFILE '.bun/bin/pi.exe')
  }
  Get-SetupCliExe -Name 'pi' -Label 'Pi' -Candidates $candidates
}

function Ensure-PiInstalled {
  $global:PiBin = Get-SetupPiCli
  if ($global:PiBin) {
    Write-SetupInfo 'Pi is already installed.'
    return
  }

  Install-SetupPi
}

function Install-SetupPi {
  if ($env:AGENT_SETUP_TEST_INSTALL_PI_SCRIPT) {
    Write-SetupInfo 'Installing Pi with the test installer'
    $timeoutSeconds = Get-SetupTimeoutSeconds 120
    $installer = Invoke-SetupProcess -Exe $env:AGENT_SETUP_TEST_INSTALL_PI_SCRIPT -Arguments @() -TimeoutSeconds $timeoutSeconds
    if ($installer.ExitCode -ne 0) { Stop-Setup 'the test installer hook failed.' }
  } elseif ($env:AGENT_SETUP_TEST_PI_URL) {
    Write-SetupInfo 'Installing Pi with the test installer download'
    Invoke-SetupRemoteInstaller -Uri $env:AGENT_SETUP_TEST_PI_URL -BypassExecutionPolicy
  } else {
    $platform = Get-SetupPlatform
    $npm = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($npm) {
      Write-SetupInfo 'Installing Pi with npm'
      $legacyPrefix = $null
      if ($global:PiBin) {
        Write-SetupPiInstallationChecker
        $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $ownership = Invoke-SetupProcess -Exe $node.Source -Arguments @((Join-Path $script:PiTmpDir 'pi-installation.mjs'), $global:PiBin) -TimeoutSeconds (Get-SetupTimeoutSeconds 30)
        if ($ownership.ExitCode -ne 0) { Stop-Setup ('Pi installation ownership check failed. ' + $ownership.Output) }
        $legacyPrefix = ConvertFrom-Json -InputObject $ownership.Output
      }
      if ($null -ne $legacyPrefix) {
        Invoke-SetupLiveProcess -Exe $npm.Source -Arguments @('install', '--global', '--prefix', $legacyPrefix, '--force', '@earendil-works/pi-coding-agent') -TimeoutSeconds (Get-SetupTimeoutSeconds 600)
      } else {
        Install-SetupNpmPackage -Package '@earendil-works/pi-coding-agent'
      }
    } elseif ($platform -eq 'windows') {
      Write-SetupInfo 'Installing Pi from pi.dev'
      Invoke-SetupRemoteInstaller -Uri 'https://pi.dev/install.ps1' -BypassExecutionPolicy
    } else {
      Write-SetupInfo 'Installing Pi from pi.dev'
      Invoke-SetupRemoteInstaller -Uri 'https://pi.dev/install.sh' -Shell
    }
  }

  $global:PiBin = Get-SetupPiCli
  if (-not $global:PiBin) {
    Stop-Setup 'Pi CLI is unavailable and could not be installed.'
  }
}

function Write-PiVersion {
  $timeoutSeconds = Get-SetupTimeoutSeconds 30
  foreach ($attempt in @('initial', 'upgraded')) {
    $result = Invoke-SetupProcess -Exe $global:PiBin -Arguments @('--version') -TimeoutSeconds $timeoutSeconds -TimeoutMessage '`pi --version` timed out.'
    if ($result.ExitCode -ne 0) { Stop-Setup ('`pi --version` failed. ' + $result.Output) }
    $version = ($result.Output -join "`n").Trim()
    Write-SetupInfo "Pi version: $version"
    if ($version -notmatch '^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$') { Stop-Setup 'Pi returned an invalid version.' }
    if ([int]$Matches[1] -gt 1 -or ([int]$Matches[1] -eq 1 -and ([int]$Matches[2] -gt 1 -or ([int]$Matches[2] -eq 1 -and ([int]$Matches[3] -gt 0 -or -not $Matches[4]))))) { return }
    if ($attempt -eq 'upgraded') { Stop-Setup 'Pi upgrade did not provide the required version >= 1.1.0.' }
    Write-SetupInfo 'Updating Pi for the Floway provider extension'
    # Self-update preserves the owning package manager or managed installation.
    # https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/coding-agent/src/package-manager-cli.ts#L1048-L1106
    $help = Invoke-SetupProcess -Exe $global:PiBin -Arguments @('update', '--help') -TimeoutSeconds $timeoutSeconds -TimeoutMessage '`pi update --help` timed out.'
    if ($help.ExitCode -ne 0) { Stop-Setup ('`pi update --help` failed. ' + $help.Output) }
    if ($help.Output.Contains('--self')) {
      Invoke-SetupLiveProcess -Exe $global:PiBin -Arguments @('update', '--self') -TimeoutSeconds (Get-SetupTimeoutSeconds 120)
      $global:PiBin = Get-SetupPiCli
    } else {
      Install-SetupPi
    }
    if (-not $global:PiBin) { Stop-Setup 'Pi CLI is unavailable after upgrading.' }
  }
}

function Backup-SetupPiFiles {
  $script:PiExtensionExisted = Test-Path -LiteralPath $script:PiExtensionPath
  $script:PiSettingsExisted = Test-Path -LiteralPath $script:PiSettingsPath
  $script:PiExtensionBackup = $null
  $script:PiSettingsBackup = $null
  $stamp = (Get-Date -Format 'yyyyMMddHHmmss') + '.' + [System.Diagnostics.Process]::GetCurrentProcess().Id

  if ($script:PiExtensionExisted) {
    $script:PiExtensionBackup = "$($script:PiExtensionPath).floway-backup.$stamp"
    Copy-Item -LiteralPath $script:PiExtensionPath -Destination $script:PiExtensionBackup -Force
    Protect-SetupFile $script:PiExtensionBackup
  }

  if ($script:PiSettingsExisted) {
    $script:PiSettingsBackup = "$($script:PiSettingsPath).floway-backup.$stamp"
    Copy-Item -LiteralPath $script:PiSettingsPath -Destination $script:PiSettingsBackup -Force
    Protect-SetupFile $script:PiSettingsBackup
  }
}

function Restore-SetupPiFiles {
  if ($script:PiExtensionStage -and (Test-Path -LiteralPath $script:PiExtensionStage)) {
    Remove-Item -LiteralPath $script:PiExtensionStage -Force -ErrorAction SilentlyContinue
    $script:PiExtensionStage = $null
  }
  if ($script:PiSettingsStage -and (Test-Path -LiteralPath $script:PiSettingsStage)) {
    Remove-Item -LiteralPath $script:PiSettingsStage -Force -ErrorAction SilentlyContinue
    $script:PiSettingsStage = $null
  }
  Restore-SetupManagedFile -Existed $script:PiExtensionExisted -Backup $script:PiExtensionBackup -Path $script:PiExtensionPath -OriginalLabel 'extension file' -CreatedLabel 'Pi extension file'
  if ($script:PiSettingsExisted -or (Test-Path -LiteralPath $script:PiSettingsPath)) {
    Restore-SetupManagedFile -Existed $script:PiSettingsExisted -Backup $script:PiSettingsBackup -Path $script:PiSettingsPath -OriginalLabel 'settings file' -CreatedLabel 'Pi settings file'
  }
}

function Remove-SetupPiBackups {
  Remove-SetupOlderBackups -Path $script:PiExtensionPath -Keep $script:PiExtensionBackup
  if ($script:PiExtensionBackup) {
    Remove-Item -LiteralPath $script:PiExtensionBackup -Force -ErrorAction Stop
  }
  $script:PiExtensionBackup = $null

  Remove-SetupOlderBackups -Path $script:PiSettingsPath -Keep $script:PiSettingsBackup
  if ($script:PiSettingsBackup) {
    Remove-Item -LiteralPath $script:PiSettingsBackup -Force -ErrorAction Stop
  }
  $script:PiSettingsBackup = $null
}

function Fetch-SetupPiExtension {
  $extensionUrl = if ($env:AGENT_SETUP_TEST_PI_EXTENSION_URL) {
    $env:AGENT_SETUP_TEST_PI_EXTENSION_URL
  } else {
    ($SetupEndpoint.TrimEnd('/')) + $SetupExtensionPath
  }
  $extensionUrl += '?endpoint=' + [System.Uri]::EscapeDataString($SetupEndpoint) + '&provider=' + [System.Uri]::EscapeDataString($SetupPiProvider)
  $script:PiExtensionStage = "$($script:PiExtensionPath).floway-stage.$([System.Diagnostics.Process]::GetCurrentProcess().Id)"
  [System.IO.File]::WriteAllText($script:PiExtensionStage, '')
  Protect-SetupFile $script:PiExtensionStage
  $resp = Invoke-WebRequest -Uri $extensionUrl -UseBasicParsing -TimeoutSec 60
  $body = [string]$resp.Content
  if (-not $body.StartsWith("// Managed by Floway Agent Setup.`n")) { Stop-Setup 'the Pi extension download has an invalid ownership marker' }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($script:PiExtensionStage, $body, $utf8NoBom)
  Protect-SetupFile $script:PiExtensionStage
  Merge-SetupProviderExtension -ExistingPath $script:PiExtensionPath -StagePath $script:PiExtensionStage
}

function Invoke-SetupNodeJsonc {
  param(
    [string]$InputText,
    [string]$OutputPath,
    [Parameter(Mandatory=$true)][hashtable]$EnvVars
  )
  $nodeCmd = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1

  $editorPath = Join-Path $script:PiTmpDir 'jsonc-edit.mjs'
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $nodeCmd.Source
  $startInfo.Arguments = '"' + $editorPath.Replace('"', '\"') + '"'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  foreach ($k in $EnvVars.Keys) {
    $startInfo.EnvironmentVariables[$k] = [string]$EnvVars[$k]
  }

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { Stop-Setup 'failed to start Node.js editor process.' }

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $writer = New-Object System.IO.StreamWriter($process.StandardInput.BaseStream, $utf8NoBom)
  $writer.Write($InputText)
  $writer.Flush()
  $writer.Close()

  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  [void]$process.WaitForExit(30000)

  if ($process.ExitCode -ne 0) {
    $err = $stderr.Trim()
    if ([string]::IsNullOrEmpty($err)) { $err = "Node.js editor exited with code $($process.ExitCode)" }
    Stop-Setup $err
  }

  [System.IO.File]::WriteAllText($OutputPath, $stdout, $utf8NoBom)
  Protect-SetupFile $OutputPath
}

function Stage-SetupPiSettings {
  if ([string]::IsNullOrEmpty($SetupPiModel) -and [string]::IsNullOrEmpty($SetupPiThinkingLevel) -and [string]::IsNullOrEmpty($SetupPiRetryEnabled) -and [string]::IsNullOrEmpty($SetupPiMaxRetries) -and (-not (Test-Path -LiteralPath $script:PiSettingsPath))) {
    $script:PiSettingsStage = $null
    return
  }
  $stamp = [System.Diagnostics.Process]::GetCurrentProcess().Id
  $script:PiSettingsStage = "$($script:PiSettingsPath).floway-stage.$stamp"
  $src = if (Test-Path -LiteralPath $script:PiSettingsPath) {
    [System.IO.File]::ReadAllText($script:PiSettingsPath)
  } else {
    ''
  }
  $envVars = @{
    FLOWAY_DEFAULT_PROVIDER = $SetupPiProvider
    FLOWAY_PI_THINKING_LEVEL = $SetupPiThinkingLevel
    FLOWAY_PI_RETRY_ENABLED = if ($null -eq $SetupPiRetryEnabled) { '' } else { $SetupPiRetryEnabled.ToString().ToLowerInvariant() }
    FLOWAY_PI_MAX_RETRIES = $SetupPiMaxRetries
  }
  $envVars['FLOWAY_DEFAULT_MODEL'] = $SetupPiModel
  Write-SetupJsoncEditor
  Invoke-SetupNodeJsonc -InputText $src -OutputPath $script:PiSettingsStage -EnvVars $envVars
}

function Apply-SetupPiStaged {
  $runningOnWindows = Test-SetupIsWindows
  if ($script:PiExtensionExisted -and $runningOnWindows) {
    Protect-SetupFile $script:PiExtensionPath
    [System.IO.File]::Replace($script:PiExtensionStage, $script:PiExtensionPath, [System.Management.Automation.Language.NullString]::Value)
  } else {
    Move-Item -LiteralPath $script:PiExtensionStage -Destination $script:PiExtensionPath -Force
  }
  Protect-SetupFile $script:PiExtensionPath
  $script:PiExtensionStage = $null

  if ($script:PiSettingsStage) {
    if ($script:PiSettingsExisted -and $runningOnWindows) {
      Protect-SetupFile $script:PiSettingsPath
      [System.IO.File]::Replace($script:PiSettingsStage, $script:PiSettingsPath, [System.Management.Automation.Language.NullString]::Value)
    } else {
      Move-Item -LiteralPath $script:PiSettingsStage -Destination $script:PiSettingsPath -Force
    }
    Protect-SetupFile $script:PiSettingsPath
    $script:PiSettingsStage = $null
  }
}

function Set-SetupAgent {
  Write-SetupAgentNotice 'Installing' 'Pi'
  Test-SetupPiNode

  $script:PiTmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ('pi-setup-' + [System.Guid]::NewGuid().ToString('N'))
  try {
    [void][System.IO.Directory]::CreateDirectory($script:PiTmpDir)
    if (-not (Test-SetupIsWindows)) {
      & chmod 700 $script:PiTmpDir
      if ($LASTEXITCODE -ne 0) { Stop-Setup 'could not protect the Pi temporary directory.' }
    }
    Ensure-PiInstalled
    Write-PiVersion

    Write-SetupAgentNotice 'Configuring' 'Pi'
    $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    $script:PiAgentDir = if ($env:PI_CODING_AGENT_DIR) {
      $env:PI_CODING_AGENT_DIR
    } else {
      Join-Path $homeDir '.pi/agent'
    }
    $script:PiExtensionPath = Join-Path $script:PiAgentDir 'extensions/floway.js'
    $script:PiSettingsPath = Join-Path $script:PiAgentDir 'settings.json'

    if (-not (Test-Path -LiteralPath (Join-Path $script:PiAgentDir 'extensions'))) {
      [void][System.IO.Directory]::CreateDirectory((Join-Path $script:PiAgentDir 'extensions'))
    }

    if (Test-Path -LiteralPath $script:PiExtensionPath) {
      $marker = [System.IO.File]::ReadLines($script:PiExtensionPath) | Select-Object -First 1
      if ($marker -ne '// Managed by Floway Agent Setup.') {
        Stop-Setup 'an unmanaged floway.js extension already exists; move it before running setup.'
      }
    }

    Backup-SetupPiFiles
    try {
      Fetch-SetupPiExtension
    } catch {
      Restore-SetupPiFiles
      throw
    }

    if ($env:AGENT_SETUP_TEST_FAIL_CONFIG) {
      Write-SetupWarn 'Pi simulated failure; rolling back configuration.'
      Restore-SetupPiFiles
      throw 'setup-handled'
    }

    try {
      Stage-SetupPiSettings
    } catch {
      Write-SetupWarn 'Pi settings staging failed; rolling back configuration.'
      Restore-SetupPiFiles
      throw
    }

    try {
      Apply-SetupPiStaged
    } catch {
      Write-SetupWarn 'Pi applying changes failed; rolling back configuration.'
      Restore-SetupPiFiles
      throw
    }

    Remove-SetupPiBackups

    Write-SetupInfo ('Written to `' + $script:PiExtensionPath + '`.')
    if (Test-Path -LiteralPath $script:PiSettingsPath) {
      Write-SetupInfo ('Written to `' + $script:PiSettingsPath + '`.')
    }
    Write-SetupInfo 'The Floway extension refreshes available models when Pi starts and when the model picker opens.'
    Write-SetupAgentNotice 'Completed Agent Setup' 'Pi'
  } finally {
    if ($script:PiTmpDir -and (Test-Path -LiteralPath $script:PiTmpDir)) {
      Remove-Item -LiteralPath $script:PiTmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

$global:LASTEXITCODE = Main 'Pi'
