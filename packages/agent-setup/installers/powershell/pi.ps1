# Pi Agent Setup fragment.

# Track upstream's maintained installer so release-metadata fixes arrive without
# waiting for a Floway update. Reviewed sources:
# https://pi.dev
# https://github.com/earendil-works/pi-mono
# https://pi.dev/install.sh

function Test-SetupPiNode {
  $nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $nodeCmd) {
    Stop-Setup 'Node.js (>= 22.19) is required to run Pi but was not found on PATH. Install Node.js (>= 22.19) and re-run.'
  }
  $rawVer = & $nodeCmd.Source -v 2>$null
  if ($rawVer) {
    $verStr = ([string]$rawVer).Trim().TrimStart('v')
    $parts = $verStr.Split('.')
    if ($parts.Length -ge 2) {
      $major = 0
      $minor = 0
      if ([int]::TryParse($parts[0], [ref]$major) -and [int]::TryParse($parts[1], [ref]$minor)) {
        if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 19)) {
          Write-SetupWarn "Node.js version is v$verStr; Pi requires Node.js >= 22.19."
        }
      }
    }
  }
}

function Ensure-PiInstalled {
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
  $global:PiBin = Get-SetupCliExe -Name 'pi' -Label 'Pi' -Candidates $candidates
  if ($global:PiBin) {
    Write-SetupInfo 'Pi is already installed.'
    return
  }

  if ($env:AGENT_SETUP_TEST_INSTALL_PI_SCRIPT) {
    Write-SetupInfo 'Pi CLI not found; running the test installer'
    $timeoutSeconds = Get-SetupTimeoutSeconds 120
    $installer = Invoke-SetupProcess -Exe $env:AGENT_SETUP_TEST_INSTALL_PI_SCRIPT -Arguments @() -TimeoutSeconds $timeoutSeconds
    if ($installer.ExitCode -ne 0) { Stop-Setup 'the test installer hook failed.' }
  } elseif ($env:AGENT_SETUP_TEST_PI_URL) {
    Write-SetupInfo 'Pi CLI not found; running the test installer download'
    Invoke-SetupRemoteInstaller -Uri $env:AGENT_SETUP_TEST_PI_URL -BypassExecutionPolicy
  } else {
    $platform = Get-SetupPlatform
    $npm = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($npm) {
      Write-SetupInfo 'Pi CLI not found; installing with npm'
      Install-SetupNpmPackage -Package '@earendil-works/pi-coding-agent'
    } elseif ($platform -eq 'windows') {
      Write-SetupInfo 'Pi CLI not found; installing from pi.dev'
      Invoke-SetupRemoteInstaller -Uri 'https://pi.dev/install.ps1' -BypassExecutionPolicy
    } else {
      Write-SetupInfo 'Pi CLI not found; installing from pi.dev'
      Invoke-SetupRemoteInstaller -Uri 'https://pi.dev/install.sh' -Shell
    }
  }

  $global:PiBin = Get-SetupCliExe -Name 'pi' -Label 'Pi' -Candidates $candidates
  if (-not $global:PiBin) {
    Stop-Setup 'Pi CLI is unavailable and could not be installed.'
  }
}

function Write-PiVersion {
  $timeoutSeconds = Get-SetupTimeoutSeconds 30
  $result = Invoke-SetupProcess -Exe $global:PiBin -Arguments @('--version') -TimeoutSeconds $timeoutSeconds -TimeoutMessage '`pi --version` timed out.'
  if ($result.ExitCode -ne 0) { Stop-Setup '`pi --version` failed.' }
  $version = ($result.Output -join "`n").Trim()
  Write-SetupInfo "Pi version: $version"
}

function Backup-SetupPiFiles {
  $script:PiModelsExisted = Test-Path -LiteralPath $script:PiModelsPath
  $script:PiSettingsExisted = Test-Path -LiteralPath $script:PiSettingsPath
  $script:PiModelsBackup = $null
  $script:PiSettingsBackup = $null
  $stamp = (Get-Date -Format 'yyyyMMddHHmmss') + '.' + [System.Diagnostics.Process]::GetCurrentProcess().Id

  if ($script:PiModelsExisted) {
    $script:PiModelsBackup = "$($script:PiModelsPath).floway-backup.$stamp"
    try {
      Copy-Item -LiteralPath $script:PiModelsPath -Destination $script:PiModelsBackup -Force
      Protect-SetupFile $script:PiModelsBackup
    } catch {
      Stop-Setup "could not back up $($script:PiModelsPath)"
    }
  }

  if ($script:PiSettingsExisted) {
    $script:PiSettingsBackup = "$($script:PiSettingsPath).floway-backup.$stamp"
    try {
      Copy-Item -LiteralPath $script:PiSettingsPath -Destination $script:PiSettingsBackup -Force
      Protect-SetupFile $script:PiSettingsBackup
    } catch {
      Stop-Setup "could not back up $($script:PiSettingsPath)"
    }
  }
}

function Restore-SetupPiFiles {
  if ($script:PiModelsStage -and (Test-Path -LiteralPath $script:PiModelsStage)) {
    Remove-Item -LiteralPath $script:PiModelsStage -Force -ErrorAction SilentlyContinue
    $script:PiModelsStage = $null
  }
  if ($script:PiSettingsStage -and (Test-Path -LiteralPath $script:PiSettingsStage)) {
    Remove-Item -LiteralPath $script:PiSettingsStage -Force -ErrorAction SilentlyContinue
    $script:PiSettingsStage = $null
  }
  Restore-SetupManagedFile -Existed $script:PiModelsExisted -Backup $script:PiModelsBackup -Path $script:PiModelsPath -OriginalLabel 'models file' -CreatedLabel 'Pi models file'
  if ($script:PiSettingsExisted -or (Test-Path -LiteralPath $script:PiSettingsPath)) {
    Restore-SetupManagedFile -Existed $script:PiSettingsExisted -Backup $script:PiSettingsBackup -Path $script:PiSettingsPath -OriginalLabel 'settings file' -CreatedLabel 'Pi settings file'
  }
}

function Complete-SetupPiFiles {
  Remove-SetupOlderBackups -Path $script:PiModelsPath -Keep $script:PiModelsBackup
  if ($script:PiModelsBackup -and (Test-Path -LiteralPath $script:PiModelsBackup)) {
    Remove-Item -LiteralPath $script:PiModelsBackup -Force -ErrorAction Stop
  }
  $script:PiModelsBackup = $null

  if (Test-Path -LiteralPath $script:PiSettingsPath) {
    Remove-SetupOlderBackups -Path $script:PiSettingsPath -Keep $script:PiSettingsBackup
    if ($script:PiSettingsBackup -and (Test-Path -LiteralPath $script:PiSettingsBackup)) {
      Remove-Item -LiteralPath $script:PiSettingsBackup -Force -ErrorAction Stop
    }
    $script:PiSettingsBackup = $null
  }
}

function Ensure-SetupJsoncEditor {
  $target = Join-Path $script:PiTmpDir 'jsonc-edit.mjs'
  if (Test-Path -LiteralPath $target) { return }
  if (Get-Command Write-SetupJsoncEditor -ErrorAction SilentlyContinue) {
    Write-SetupJsoncEditor
    return
  }
  $repoPath = Join-Path $PSScriptRoot '..\node\jsonc-edit.mjs'
  if (Test-Path -LiteralPath $repoPath) {
    Copy-Item -LiteralPath $repoPath -Destination $target
    return
  }
  Stop-Setup 'JSONC editor asset missing from installer.'
}

function Fetch-SetupPiSnapshot {
  $snapshotUrl = if ($env:AGENT_SETUP_TEST_PI_MODELS_URL) {
    $env:AGENT_SETUP_TEST_PI_MODELS_URL
  } else {
    ($SetupEndpoint.TrimEnd('/')) + "/api/setup/$SetupToken/pi-models.json"
  }
  $script:PiSnapshotFile = Join-Path $script:PiTmpDir 'snapshot.json'
  try {
    $resp = Invoke-WebRequest -Uri $snapshotUrl -UseBasicParsing -TimeoutSec 60
    $body = [string]$resp.Content
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($script:PiSnapshotFile, $body, $utf8NoBom)
    Protect-SetupFile $script:PiSnapshotFile
  } catch {
    Stop-Setup "failed to fetch model snapshot from $snapshotUrl"
  }
}

function Invoke-SetupNodeJsonc {
  param(
    [string]$Mode,
    [string]$InputText,
    [string]$OutputPath,
    [hashtable]$EnvVars
  )
  $nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $nodeCmd) { Stop-Setup 'Node.js is required but was not found on PATH.' }

  $editorPath = Join-Path $script:PiTmpDir 'jsonc-edit.mjs'
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $nodeCmd.Source
  $startInfo.Arguments = '"' + $editorPath.Replace('"', '\"') + '" ' + $Mode
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  if ($EnvVars) {
    foreach ($k in $EnvVars.Keys) {
      if ($startInfo.EnvironmentVariables.ContainsKey($k)) {
        $startInfo.EnvironmentVariables[$k] = [string]$EnvVars[$k]
      } else {
        $startInfo.EnvironmentVariables.Add($k, [string]$EnvVars[$k])
      }
    }
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

  # The editor always emits a JSON object. Empty output means it did not run.
  if ([string]::IsNullOrWhiteSpace($stdout)) { Stop-Setup 'Node.js editor produced no output; refusing to write an empty configuration.' }

  [System.IO.File]::WriteAllText($OutputPath, $stdout, $utf8NoBom)
  Protect-SetupFile $OutputPath
}

function Stage-SetupPiModels {
  $stamp = [System.Diagnostics.Process]::GetCurrentProcess().Id
  $script:PiModelsStage = "$($script:PiModelsPath).floway-stage.$stamp"
  $src = if (Test-Path -LiteralPath $script:PiModelsPath) {
    [System.IO.File]::ReadAllText($script:PiModelsPath)
  } else {
    ''
  }
  $envVars = @{
    'FLOWAY_SNAPSHOT_FILE' = $script:PiSnapshotFile
    'FLOWAY_BASE_URL' = $SetupEndpoint.TrimEnd('/')
    'FLOWAY_API_KEY' = $SetupApiKey
  }
  Invoke-SetupNodeJsonc -Mode 'models' -InputText $src -OutputPath $script:PiModelsStage -EnvVars $envVars
}

function Stage-SetupPiSettings {
  if ([string]::IsNullOrEmpty($SetupPiModel) -and (-not (Test-Path -LiteralPath $script:PiSettingsPath))) {
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
  $envVars = @{}
  if (-not [string]::IsNullOrEmpty($SetupPiModel)) {
    $envVars['FLOWAY_DEFAULT_MODEL'] = $SetupPiModel
    $envVars['FLOWAY_REMOVE_DEFAULT_MODEL'] = '0'
  } else {
    $envVars['FLOWAY_DEFAULT_MODEL'] = ''
    $envVars['FLOWAY_REMOVE_DEFAULT_MODEL'] = '1'
  }
  Invoke-SetupNodeJsonc -Mode 'settings' -InputText $src -OutputPath $script:PiSettingsStage -EnvVars $envVars
}

function Apply-SetupPiStaged {
  $runningOnWindows = Test-SetupIsWindows
  if ($script:PiModelsExisted -and $runningOnWindows) {
    Protect-SetupFile $script:PiModelsPath
    [System.IO.File]::Replace($script:PiModelsStage, $script:PiModelsPath, [System.Management.Automation.Language.NullString]::Value)
  } else {
    Move-Item -LiteralPath $script:PiModelsStage -Destination $script:PiModelsPath -Force
  }
  Protect-SetupFile $script:PiModelsPath
  $script:PiModelsStage = $null

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
  Ensure-PiInstalled
  Write-PiVersion

  $script:PiTmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ('pi-setup-' + [System.Guid]::NewGuid().ToString('N'))
  try {
    [void][System.IO.Directory]::CreateDirectory($script:PiTmpDir)
    if (-not (Test-SetupIsWindows)) { & chmod 700 $script:PiTmpDir }

    Write-SetupAgentNotice 'Configuring' 'Pi'
    $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    $script:PiAgentDir = if ($env:PI_CODING_AGENT_DIR) {
      $env:PI_CODING_AGENT_DIR
    } else {
      Join-Path $homeDir '.pi/agent'
    }
    $script:PiModelsPath = Join-Path $script:PiAgentDir 'models.json'
    $script:PiSettingsPath = Join-Path $script:PiAgentDir 'settings.json'

    if (-not (Test-Path -LiteralPath $script:PiAgentDir)) {
      try {
        [void][System.IO.Directory]::CreateDirectory($script:PiAgentDir)
      } catch {
        Stop-Setup "could not create $($script:PiAgentDir)"
      }
    }

    Backup-SetupPiFiles
    Ensure-SetupJsoncEditor
    Fetch-SetupPiSnapshot

    try {
      Stage-SetupPiModels
    } catch {
      Write-SetupWarn 'Pi models staging failed; rolling back configuration.'
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

    try {
      Complete-SetupPiFiles
    } catch {
      Write-SetupWarn 'Pi backup cleanup failed; rolling back configuration.'
      Restore-SetupPiFiles
      throw
    }

    Write-SetupInfo ('Written to `' + $script:PiModelsPath + '`.')
    if (Test-Path -LiteralPath $script:PiSettingsPath) {
      Write-SetupInfo ('Written to `' + $script:PiSettingsPath + '`.')
    }
    Write-SetupInfo 'Models configured as a static snapshot; re-run this setup command at any time to refresh the model list.'
    Write-SetupAgentNotice 'Completed Agent Setup' 'Pi'
  } finally {
    if ($script:PiTmpDir -and (Test-Path -LiteralPath $script:PiTmpDir)) {
      Remove-Item -LiteralPath $script:PiTmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

$global:LASTEXITCODE = Main 'Pi'
