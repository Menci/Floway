# oh-my-pi (omp) Agent Setup fragment.

# Track upstream's maintained installer so release-metadata fixes arrive without
# waiting for a Floway update. Reviewed sources:
# https://github.com/can1357/oh-my-pi
# https://omp.sh/install.ps1
# https://omp.sh/install
function Install-SetupOmp {
  if ($env:AGENT_SETUP_TEST_INSTALL_OMP_SCRIPT) {
    Write-SetupInfo 'oh-my-pi CLI not found; running the test installer'
    $timeoutSeconds = Get-SetupTimeoutSeconds 120
    $installer = Invoke-SetupProcess -Exe $env:AGENT_SETUP_TEST_INSTALL_OMP_SCRIPT -Arguments @() -TimeoutSeconds $timeoutSeconds
    if ($installer.ExitCode -ne 0) { Stop-Setup "the test installer hook failed." }
    return
  }
  if ($env:AGENT_SETUP_TEST_OMP_URL) {
    Write-SetupInfo 'oh-my-pi CLI not found; running the test installer download'
    Invoke-SetupRemoteInstaller -Uri $env:AGENT_SETUP_TEST_OMP_URL -BypassExecutionPolicy
    return
  }
  $platform = Get-SetupPlatform
  $npm = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($npm) {
    Write-SetupInfo 'oh-my-pi CLI not found; installing with npm'
    Install-SetupNpmPackage -Package '@oh-my-pi/pi-coding-agent'
  } elseif ($platform -eq 'windows') {
    Write-SetupInfo 'oh-my-pi CLI not found; installing from omp.sh'
    Invoke-SetupRemoteInstaller -Uri 'https://omp.sh/install.ps1' -BypassExecutionPolicy
  } else {
    Write-SetupInfo 'oh-my-pi CLI not found; installing from omp.sh'
    Invoke-SetupRemoteInstaller -Uri 'https://omp.sh/install' -Shell
  }
}

function Write-SetupOmpVersion {
  param([string]$Exe)
  $timeoutSeconds = Get-SetupTimeoutSeconds 30
  $version = Invoke-SetupProcess -Exe $Exe -Arguments @('--version') -TimeoutSeconds $timeoutSeconds -TimeoutMessage '`omp --version` timed out.'
  if ($version.ExitCode -ne 0) { Stop-Setup "``omp --version`` failed." }
  Write-SetupInfo "oh-my-pi version: $($version.Output.Trim())"
}

function Get-SetupOmpAgentDir {
  param([string]$Exe)
  if ($Exe) {
    try {
      $timeoutSeconds = Get-SetupTimeoutSeconds 10
      $proc = Invoke-SetupProcess -Exe $Exe -Arguments @('config', 'path') -TimeoutSeconds $timeoutSeconds
      if ($proc.ExitCode -eq 0 -and (-not [string]::IsNullOrWhiteSpace($proc.Output))) {
        $reader = New-Object System.IO.StringReader($proc.Output)
        $firstLine = $reader.ReadLine()
        if (-not [string]::IsNullOrWhiteSpace($firstLine)) {
          return $firstLine.Trim()
        }
      }
    } catch { }
  }
  $root = if ($env:PI_CONFIG_DIR) { $env:PI_CONFIG_DIR } else { '.omp' }
  if ($env:OMP_PROFILE) {
    return (Join-Path (Join-Path (Join-Path (Join-Path $HOME $root) 'profiles') $env:OMP_PROFILE) 'agent')
  }
  if ($env:PI_CODING_AGENT_DIR) {
    return $env:PI_CODING_AGENT_DIR
  }
  return (Join-Path (Join-Path $HOME $root) 'agent')
}

function Backup-SetupOmpFiles {
  $script:OmpModelsExisted = $false
  $script:OmpConfigExisted = $false
  $script:OmpModelsBackup = $null
  $script:OmpConfigBackup = $null
  $stamp = [long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds
  if (Test-Path -LiteralPath $script:OmpModelsPath) {
    $script:OmpModelsExisted = $true
    $script:OmpModelsBackup = "$($script:OmpModelsPath).floway-backup.$stamp.$PID"
    try {
      Copy-Item -LiteralPath $script:OmpModelsPath -Destination $script:OmpModelsBackup
      Protect-SetupFile $script:OmpModelsBackup
    } catch {
      if (Test-Path -LiteralPath $script:OmpModelsBackup) {
        Remove-Item -LiteralPath $script:OmpModelsBackup -Force
      }
      $script:OmpModelsBackup = $null
      throw
    }
  }
  if (Test-Path -LiteralPath $script:OmpConfigPath) {
    $script:OmpConfigExisted = $true
    $script:OmpConfigBackup = "$($script:OmpConfigPath).floway-backup.$stamp.$PID"
    Copy-Item -LiteralPath $script:OmpConfigPath -Destination $script:OmpConfigBackup
  }
}

function Restore-SetupOmpFiles {
  if ($script:OmpModelsStage -and (Test-Path -LiteralPath $script:OmpModelsStage)) {
    Remove-Item -LiteralPath $script:OmpModelsStage -Force -ErrorAction SilentlyContinue
  }
  if ($script:OmpConfigStage -and (Test-Path -LiteralPath $script:OmpConfigStage)) {
    Remove-Item -LiteralPath $script:OmpConfigStage -Force -ErrorAction SilentlyContinue
  }
  Restore-SetupManagedFile -Existed $script:OmpModelsExisted -Backup $script:OmpModelsBackup -Path $script:OmpModelsPath -OriginalLabel 'models file' -CreatedLabel 'oh-my-pi models file'
  Restore-SetupManagedFile -Existed $script:OmpConfigExisted -Backup $script:OmpConfigBackup -Path $script:OmpConfigPath -OriginalLabel 'config file' -CreatedLabel 'oh-my-pi config file'
}

function Complete-SetupOmpFiles {
  Remove-SetupOlderBackups -Path $script:OmpModelsPath -Keep $script:OmpModelsBackup
  if ($script:OmpModelsBackup -and (Test-Path -LiteralPath $script:OmpModelsBackup)) {
    Remove-Item -LiteralPath $script:OmpModelsBackup -Force -ErrorAction Stop
  }
  $script:OmpModelsBackup = $null

  Remove-SetupOlderBackups -Path $script:OmpConfigPath -Keep $script:OmpConfigBackup
  if ($script:OmpConfigBackup -and (Test-Path -LiteralPath $script:OmpConfigBackup)) {
    Remove-Item -LiteralPath $script:OmpConfigBackup -Force -ErrorAction Stop
  }
  $script:OmpConfigBackup = $null
}

function Read-SetupYamlDocument {
  param([string]$Path)
  $lines = New-Object System.Collections.Generic.List[string]
  $eol = "`n"
  $hasTrailingNl = $true
  $hasBom = $false

  if (Test-Path -LiteralPath $Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
      $hasBom = $true
    }
    $rawText = [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
    if ($rawText.Contains("`r`n")) {
      $eol = "`r`n"
    }
    if ($rawText.Length -gt 0 -and (-not $rawText.EndsWith("`n"))) {
      $hasTrailingNl = $false
    }
    $reader = New-Object System.IO.StringReader($rawText)
    while ($true) {
      $line = $reader.ReadLine()
      if ($null -eq $line) { break }
      $lines.Add($line)
    }
  }

  return [PSCustomObject]@{
    Lines = $lines
    Eol = $eol
    HasTrailingNl = $hasTrailingNl
    HasBom = $hasBom
  }
}

function Stage-SetupOmpModels {
  $script:OmpModelsStage = "$($script:OmpModelsPath).floway-stage.$PID"
  try {
    [System.IO.File]::Create($script:OmpModelsStage).Dispose()
    Protect-SetupFile $script:OmpModelsStage
  } catch {
    if (Test-Path -LiteralPath $script:OmpModelsStage) {
      Remove-Item -LiteralPath $script:OmpModelsStage -Force -ErrorAction SilentlyContinue
    }
    throw
  }

  $doc = Read-SetupYamlDocument -Path $script:OmpModelsPath
  $lines = $doc.Lines
  $eol = $doc.Eol
  $hasTrailingNl = $doc.HasTrailingNl
  $hasBom = $doc.HasBom

  $beginIdx = -1
  $endIdx = -1
  $provIdx = -1

  for ($i = 0; $i -lt $lines.Count; $i++) {
    $l = $lines[$i]
    if ($l.Contains("`t")) {
      Stop-Setup "tabs found in $($script:OmpModelsPath); YAML disallows tab indentation. Convert tabs to spaces and re-run."
    }
    if ($l -match '(?:^|\s)providers:.*\{') {
      Stop-Setup "flow-style 'providers:' mapping found in $($script:OmpModelsPath); Floway Agent Setup only manages block-style YAML mappings."
    }
    if ($l -match '#\s*floway:begin') {
      if ($beginIdx -ne -1) {
        Stop-Setup "multiple '# floway:begin' markers found in $($script:OmpModelsPath); repair or remove them and re-run."
      }
      $beginIdx = $i
    }
    if ($l -match '#\s*floway:end') {
      if ($endIdx -ne -1) {
        Stop-Setup "multiple '# floway:end' markers found in $($script:OmpModelsPath); repair or remove them and re-run."
      }
      $endIdx = $i
    }
    if ($l -match '^providers:(?:\s|#|$)') {
      $provIdx = $i
    }
  }

  if (($beginIdx -ne -1 -and $endIdx -eq -1) -or ($beginIdx -eq -1 -and $endIdx -ne -1) -or ($beginIdx -gt $endIdx)) {
    Stop-Setup "mismatched or malformed Floway markers in $($script:OmpModelsPath); repair or remove them and re-run."
  }

  if ($provIdx -ne -1) {
    if ($lines[$provIdx] -match '[&*]|<<:') {
      Stop-Setup "YAML anchors, aliases, or merge keys found touching managed keys in $($script:OmpModelsPath); Floway Agent Setup cannot safely edit YAML aliases."
    }
    for ($j = $provIdx + 1; $j -lt $lines.Count; $j++) {
      $cur = $lines[$j]
      if ($cur -match '^[ \t]') {
        if ($cur -match '[&*]|<<:') {
          Stop-Setup "YAML anchors, aliases, or merge keys found touching managed keys in $($script:OmpModelsPath); Floway Agent Setup cannot safely edit YAML aliases."
        }
      } elseif ($cur -match '^#' -or [string]::IsNullOrWhiteSpace($cur)) {
      } else {
        break
      }
    }
  }

  for ($i = 0; $i -lt $lines.Count; $i++) {
    $l = $lines[$i]
    if ($l -match '^[ ]{1,2}floway:') {
      if ($beginIdx -eq -1 -or $i -lt $beginIdx -or $i -gt $endIdx) {
        Stop-Setup "existing unmanaged 'floway' provider found in $($script:OmpModelsPath) without Floway markers; remove or rename it and re-run."
      }
    }
  }

  $base = ($SetupEndpoint.TrimEnd('/')) + '/v1'
  $managed = @(
    '  # floway:begin',
    '  floway:',
    "    baseUrl: $base",
    '    api: openai-responses',
    '    auth: apiKey',
    "    apiKey: $SetupApiKey",
    '    headers: { User-Agent: floway-omp/1 }',
    '    discovery:',
    '      type: openai-models-list',
    '  # floway:end'
  )

  $newLines = New-Object System.Collections.Generic.List[string]
  if ($beginIdx -ne -1) {
    for ($j = 0; $j -lt $beginIdx; $j++) { $newLines.Add($lines[$j]) }
    foreach ($m in $managed) { $newLines.Add($m) }
    for ($j = $endIdx + 1; $j -lt $lines.Count; $j++) { $newLines.Add($lines[$j]) }
  } elseif ($provIdx -ne -1) {
    for ($j = 0; $j -le $provIdx; $j++) { $newLines.Add($lines[$j]) }
    foreach ($m in $managed) { $newLines.Add($m) }
    for ($j = $provIdx + 1; $j -lt $lines.Count; $j++) { $newLines.Add($lines[$j]) }
  } else {
    if ($lines.Count -gt 0) {
      for ($j = 0; $j -lt $lines.Count; $j++) { $newLines.Add($lines[$j]) }
    }
    $newLines.Add('providers:')
    foreach ($m in $managed) { $newLines.Add($m) }
    $hasTrailingNl = $true
  }

  $sb = New-Object System.Text.StringBuilder
  for ($j = 0; $j -lt $newLines.Count; $j++) {
    if ($j -eq ($newLines.Count - 1) -and (-not $hasTrailingNl)) {
      [void]$sb.Append($newLines[$j])
    } else {
      [void]$sb.Append($newLines[$j])
      [void]$sb.Append($eol)
    }
  }

  $encoding = New-Object System.Text.UTF8Encoding($hasBom)
  [System.IO.File]::WriteAllText($script:OmpModelsStage, $sb.ToString(), $encoding)
}

function Stage-SetupOmpConfig {
  $script:OmpConfigStage = $null
  if ([string]::IsNullOrEmpty($SetupOmpModel) -and (-not (Test-Path -LiteralPath $script:OmpConfigPath))) {
    return
  }

  $script:OmpConfigStage = "$($script:OmpConfigPath).floway-stage.$PID"
  try {
    [System.IO.File]::Create($script:OmpConfigStage).Dispose()
    Protect-SetupFile $script:OmpConfigStage
  } catch {
    if (Test-Path -LiteralPath $script:OmpConfigStage) {
      Remove-Item -LiteralPath $script:OmpConfigStage -Force -ErrorAction SilentlyContinue
    }
    throw
  }

  $doc = Read-SetupYamlDocument -Path $script:OmpConfigPath
  $lines = $doc.Lines
  $eol = $doc.Eol
  $hasTrailingNl = $doc.HasTrailingNl
  $hasBom = $doc.HasBom

  $beginIdx = -1
  $endIdx = -1
  $rolesIdx = -1

  for ($i = 0; $i -lt $lines.Count; $i++) {
    $l = $lines[$i]
    if ($l.Contains("`t")) {
      Stop-Setup "tabs found in $($script:OmpConfigPath); YAML disallows tab indentation. Convert tabs to spaces and re-run."
    }
    if ($l -match '(?:^|\s)modelRoles:.*\{') {
      Stop-Setup "flow-style 'modelRoles:' mapping found in $($script:OmpConfigPath); Floway Agent Setup only manages block-style YAML mappings."
    }
    if ($l -match '#\s*floway:begin') {
      if ($beginIdx -ne -1) {
        Stop-Setup "multiple '# floway:begin' markers found in $($script:OmpConfigPath); repair or remove them and re-run."
      }
      $beginIdx = $i
    }
    if ($l -match '#\s*floway:end') {
      if ($endIdx -ne -1) {
        Stop-Setup "multiple '# floway:end' markers found in $($script:OmpConfigPath); repair or remove them and re-run."
      }
      $endIdx = $i
    }
    if ($l -match '^modelRoles:(?:\s|#|$)') {
      $rolesIdx = $i
    }
  }

  if (($beginIdx -ne -1 -and $endIdx -eq -1) -or ($beginIdx -eq -1 -and $endIdx -ne -1) -or ($beginIdx -gt $endIdx)) {
    Stop-Setup "mismatched or malformed Floway markers in $($script:OmpConfigPath); repair or remove them and re-run."
  }

  if ($rolesIdx -ne -1) {
    if ($lines[$rolesIdx] -match '[&*]|<<:') {
      Stop-Setup "YAML anchors, aliases, or merge keys found touching managed keys in $($script:OmpConfigPath); Floway Agent Setup cannot safely edit YAML aliases."
    }
    for ($j = $rolesIdx + 1; $j -lt $lines.Count; $j++) {
      $cur = $lines[$j]
      if ($cur -match '^[ \t]') {
        if ($cur -match '[&*]|<<:') {
          Stop-Setup "YAML anchors, aliases, or merge keys found touching managed keys in $($script:OmpConfigPath); Floway Agent Setup cannot safely edit YAML aliases."
        }
      } elseif ($cur -match '^#' -or [string]::IsNullOrWhiteSpace($cur)) {
      } else {
        break
      }
    }
  }

  if ((-not [string]::IsNullOrEmpty($SetupOmpModel)) -and $rolesIdx -ne -1) {
    for ($j = $rolesIdx + 1; $j -lt $lines.Count; $j++) {
      $cur = $lines[$j]
      if ($cur -match '^[ \t]') {
        if ($cur -match '^[ ]{1,2}default:') {
          if ($beginIdx -eq -1 -or $j -lt $beginIdx -or $j -gt $endIdx) {
            Stop-Setup "existing unmanaged 'modelRoles.default' found in $($script:OmpConfigPath) without Floway markers; remove it and re-run."
          }
        }
      } elseif ($cur -match '^#' -or [string]::IsNullOrWhiteSpace($cur)) {
      } else {
        break
      }
    }
  }

  $newLines = New-Object System.Collections.Generic.List[string]

  if ([string]::IsNullOrEmpty($SetupOmpModel)) {
    if ($beginIdx -eq -1) {
      if (-not (Test-Path -LiteralPath $script:OmpConfigPath)) {
        if (Test-Path -LiteralPath $script:OmpConfigStage) {
          Remove-Item -LiteralPath $script:OmpConfigStage -Force -ErrorAction SilentlyContinue
        }
        $script:OmpConfigStage = $null
        return
      }
      for ($j = 0; $j -lt $lines.Count; $j++) { $newLines.Add($lines[$j]) }
    } else {
      for ($j = 0; $j -lt $beginIdx; $j++) { $newLines.Add($lines[$j]) }
      for ($j = $endIdx + 1; $j -lt $lines.Count; $j++) { $newLines.Add($lines[$j]) }
    }
  } else {
    $escaped = $SetupOmpModel.Replace("'", "''")
    $target = "'floway/$escaped'"
    if ($beginIdx -ne -1) {
      $wrapsRoles = $false
      if (($beginIdx + 1) -eq $rolesIdx) { $wrapsRoles = $true }
      for ($j = 0; $j -lt $beginIdx; $j++) { $newLines.Add($lines[$j]) }
      if ($wrapsRoles) {
        $newLines.Add('# floway:begin')
        $newLines.Add('modelRoles:')
        $newLines.Add("  default: $target")
        $newLines.Add('# floway:end')
      } else {
        $newLines.Add('  # floway:begin')
        $newLines.Add("  default: $target")
        $newLines.Add('  # floway:end')
      }
      for ($j = $endIdx + 1; $j -lt $lines.Count; $j++) { $newLines.Add($lines[$j]) }
    } elseif ($rolesIdx -ne -1) {
      for ($j = 0; $j -le $rolesIdx; $j++) { $newLines.Add($lines[$j]) }
      $newLines.Add('  # floway:begin')
      $newLines.Add("  default: $target")
      $newLines.Add('  # floway:end')
      for ($j = $rolesIdx + 1; $j -lt $lines.Count; $j++) { $newLines.Add($lines[$j]) }
    } else {
      if ($lines.Count -gt 0) {
        for ($j = 0; $j -lt $lines.Count; $j++) { $newLines.Add($lines[$j]) }
      }
      $newLines.Add('# floway:begin')
      $newLines.Add('modelRoles:')
      $newLines.Add("  default: $target")
      $newLines.Add('# floway:end')
      $hasTrailingNl = $true
    }
  }

  $sb = New-Object System.Text.StringBuilder
  for ($j = 0; $j -lt $newLines.Count; $j++) {
    if ($j -eq ($newLines.Count - 1) -and (-not $hasTrailingNl)) {
      [void]$sb.Append($newLines[$j])
    } else {
      [void]$sb.Append($newLines[$j])
      [void]$sb.Append($eol)
    }
  }

  $encoding = New-Object System.Text.UTF8Encoding($hasBom)
  [System.IO.File]::WriteAllText($script:OmpConfigStage, $sb.ToString(), $encoding)
}

function Apply-SetupOmpStaged {
  $runningOnWindows = Test-SetupIsWindows
  if ($script:OmpModelsExisted -and $runningOnWindows) {
    Protect-SetupFile $script:OmpModelsPath
    [System.IO.File]::Replace($script:OmpModelsStage, $script:OmpModelsPath, [System.Management.Automation.Language.NullString]::Value)
  } else {
    Move-Item -LiteralPath $script:OmpModelsStage -Destination $script:OmpModelsPath -Force
  }
  Protect-SetupFile $script:OmpModelsPath
  $script:OmpModelsStage = $null

  if ($script:OmpConfigStage) {
    $stageItem = Get-Item -LiteralPath $script:OmpConfigStage -ErrorAction SilentlyContinue
    if ($stageItem -and $stageItem.Length -gt 0) {
      if ($script:OmpConfigExisted -and $runningOnWindows) {
        Protect-SetupFile $script:OmpConfigPath
        [System.IO.File]::Replace($script:OmpConfigStage, $script:OmpConfigPath, [System.Management.Automation.Language.NullString]::Value)
      } else {
        Move-Item -LiteralPath $script:OmpConfigStage -Destination $script:OmpConfigPath -Force
      }
      Protect-SetupFile $script:OmpConfigPath
    } else {
      if (Test-Path -LiteralPath $script:OmpConfigStage) {
        Remove-Item -LiteralPath $script:OmpConfigStage -Force -ErrorAction SilentlyContinue
      }
      if (Test-Path -LiteralPath $script:OmpConfigPath) {
        Remove-Item -LiteralPath $script:OmpConfigPath -Force -ErrorAction SilentlyContinue
      }
    }
    $script:OmpConfigStage = $null
  }
}

function Set-SetupAgent {
  Write-SetupAgentNotice 'Installing' 'oh-my-pi'
  $candidates = @(
    (Join-Path $HOME '.local/bin/omp'),
    (Join-Path $HOME '.local/bin/omp.exe'),
    (Join-Path $HOME '.bun/bin/omp'),
    (Join-Path $HOME '.bun/bin/omp.exe'),
    '/opt/homebrew/bin/omp',
    '/usr/local/bin/omp'
  )
  if ($env:USERPROFILE) {
    $candidates += (Join-Path $env:USERPROFILE '.local\bin\omp.exe')
    $candidates += (Join-Path $env:USERPROFILE '.bun\bin\omp.exe')
  }
  $exe = Get-SetupCliExe -Name omp -Label 'oh-my-pi' -Candidates $candidates
  if (-not $exe) {
    Install-SetupOmp
    $exe = Get-SetupCliExe -Name omp -Label 'oh-my-pi' -Candidates $candidates
    if (-not $exe) { Stop-Setup "oh-my-pi CLI is unavailable and could not be installed." }
  } else {
    Write-SetupInfo 'oh-my-pi is already installed.'
  }
  Write-SetupOmpVersion -Exe $exe

  Write-SetupAgentNotice 'Configuring' 'oh-my-pi'
  $script:OmpAgentDir = Get-SetupOmpAgentDir -Exe $exe
  if (-not (Test-Path -LiteralPath $script:OmpAgentDir)) {
    New-Item -ItemType Directory -Path $script:OmpAgentDir -Force | Out-Null
  }

  $modelsYml = Join-Path $script:OmpAgentDir 'models.yml'
  $modelsYaml = Join-Path $script:OmpAgentDir 'models.yaml'
  $modelsJson = Join-Path $script:OmpAgentDir 'models.json'
  if (Test-Path -LiteralPath $modelsYml) {
    $script:OmpModelsPath = $modelsYml
  } elseif (Test-Path -LiteralPath $modelsYaml) {
    $script:OmpModelsPath = $modelsYaml
  } elseif (Test-Path -LiteralPath $modelsJson) {
    Stop-Setup 'found models.json without models.yml; start omp once to migrate models.json to models.yml, or migrate it by hand.'
  } else {
    $script:OmpModelsPath = $modelsYml
  }

  $configYml = Join-Path $script:OmpAgentDir 'config.yml'
  $configYaml = Join-Path $script:OmpAgentDir 'config.yaml'
  if (Test-Path -LiteralPath $configYml) {
    $script:OmpConfigPath = $configYml
  } elseif (Test-Path -LiteralPath $configYaml) {
    $script:OmpConfigPath = $configYaml
  } else {
    $script:OmpConfigPath = $configYml
  }

  Backup-SetupOmpFiles

  try {
    Stage-SetupOmpModels
  } catch {
    Write-SetupWarn 'oh-my-pi models staging failed; rolling back configuration.'
    Restore-SetupOmpFiles
    throw
  }

  if ($env:AGENT_SETUP_TEST_FAIL_CONFIG) {
    Write-SetupWarn 'oh-my-pi simulated failure; rolling back configuration.'
    Restore-SetupOmpFiles
    throw 'setup-handled'
  }

  try {
    Stage-SetupOmpConfig
  } catch {
    Write-SetupWarn 'oh-my-pi config staging failed; rolling back configuration.'
    Restore-SetupOmpFiles
    throw
  }

  try {
    Apply-SetupOmpStaged
  } catch {
    Write-SetupWarn 'oh-my-pi applying changes failed; rolling back configuration.'
    Restore-SetupOmpFiles
    throw
  }

  try {
    Complete-SetupOmpFiles
  } catch {
    Write-SetupWarn 'oh-my-pi backup cleanup failed; rolling back configuration.'
    Restore-SetupOmpFiles
    throw
  }

  Write-SetupInfo ('Written to `' + $script:OmpModelsPath + '`.')
  if (Test-Path -LiteralPath $script:OmpConfigPath) {
    Write-SetupInfo ('Written to `' + $script:OmpConfigPath + '`.')
  }
  Write-SetupAgentNotice 'Completed Agent Setup' 'oh-my-pi'
}

$global:LASTEXITCODE = Main 'oh-my-pi'
