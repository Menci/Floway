# Use the maintained upstream installer so release discovery follows upstream.
# https://omp.sh/install.ps1

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

function Test-SetupOmpVersion {
  param([string]$Exe)
  $timeoutSeconds = Get-SetupTimeoutSeconds 30
  $version = Invoke-SetupProcess -Exe $Exe -Arguments @('--version') -TimeoutSeconds $timeoutSeconds -TimeoutMessage '`omp --version` timed out.'
  if ($version.ExitCode -ne 0) { Stop-Setup "``omp --version`` failed." }
  Write-SetupInfo "oh-my-pi version: $($version.Output.Trim())"
  $versionText = $version.Output.Trim() -replace '^omp/', ''
  if ($versionText -notmatch '^(\d+\.\d+\.\d+)([-+][0-9A-Za-z.-]+)?$') {
    Stop-Setup 'oh-my-pi returned an invalid version.'
  }
  $core = [Version]$Matches[1]
  return $core -gt [Version]'18.8.4' -or ($core -eq [Version]'18.8.4' -and $Matches[2] -notlike '-*')
}

function Get-SetupOmpAgentDir {
  param([string]$Exe)
  $proc = Invoke-SetupProcess -Exe $Exe -Arguments @('config', 'path') -TimeoutSeconds (Get-SetupTimeoutSeconds 10)
  if ($proc.ExitCode -ne 0) { Stop-Setup ('`omp config path` failed. ' + $proc.Output) }
  $path = $proc.Output.Trim()
  if ([string]::IsNullOrEmpty($path)) { Stop-Setup '`omp config path` returned an empty path.' }
  return $path
}

function Backup-SetupOmpFiles {
  $script:OmpExtensionExisted = $false
  $script:OmpConfigExisted = $false
  $script:OmpExtensionBackup = $null
  $script:OmpConfigBackup = $null
  $stamp = [long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds
  if (Test-Path -LiteralPath $script:OmpExtensionPath) {
    $script:OmpExtensionExisted = $true
    $script:OmpExtensionBackup = "$($script:OmpExtensionPath).floway-backup.$stamp.$PID"
    try {
      Copy-Item -LiteralPath $script:OmpExtensionPath -Destination $script:OmpExtensionBackup
      Protect-SetupFile $script:OmpExtensionBackup
    } catch {
      if (Test-Path -LiteralPath $script:OmpExtensionBackup) {
        Remove-Item -LiteralPath $script:OmpExtensionBackup -Force
      }
      $script:OmpExtensionBackup = $null
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
  if ($script:OmpExtensionStage -and (Test-Path -LiteralPath $script:OmpExtensionStage)) {
    Remove-Item -LiteralPath $script:OmpExtensionStage -Force -ErrorAction SilentlyContinue
  }
  if ($script:OmpConfigStage -and (Test-Path -LiteralPath $script:OmpConfigStage)) {
    Remove-Item -LiteralPath $script:OmpConfigStage -Force -ErrorAction SilentlyContinue
  }
  Restore-SetupManagedFile -Existed $script:OmpExtensionExisted -Backup $script:OmpExtensionBackup -Path $script:OmpExtensionPath -OriginalLabel 'extension file' -CreatedLabel 'oh-my-pi extension file'
  Restore-SetupManagedFile -Existed $script:OmpConfigExisted -Backup $script:OmpConfigBackup -Path $script:OmpConfigPath -OriginalLabel 'config file' -CreatedLabel 'oh-my-pi config file'
}

function Remove-SetupOmpBackups {
  Remove-SetupOlderBackups -Path $script:OmpExtensionPath -Keep $script:OmpExtensionBackup
  if ($script:OmpExtensionBackup -and (Test-Path -LiteralPath $script:OmpExtensionBackup)) {
    Remove-Item -LiteralPath $script:OmpExtensionBackup -Force -ErrorAction Stop
  }
  $script:OmpExtensionBackup = $null

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

function Stage-SetupOmpExtension {
  if (Test-Path -LiteralPath $script:OmpExtensionPath) {
    $first = [System.IO.File]::ReadLines($script:OmpExtensionPath) | Select-Object -First 1
    if ($first -ne '// Managed by Floway Agent Setup.') {
      Stop-Setup 'existing unmanaged Floway extension found; rename it before running Agent Setup.'
    }
  }
  $script:OmpExtensionStage = "$($script:OmpExtensionPath).floway-stage.$PID"
  [System.IO.File]::Create($script:OmpExtensionStage).Dispose()
  Protect-SetupFile $script:OmpExtensionStage
  $uri = $SetupEndpoint.TrimEnd('/') + $SetupExtensionPath + '?endpoint=' + [Uri]::EscapeDataString($SetupEndpoint) + '&provider=' + [Uri]::EscapeDataString($SetupOmpProvider)
  try {
    $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 30
  } catch {
    Stop-Setup 'could not download the oh-my-pi extension.'
  }
  $source = [string]$response.Content
  if (-not $source.StartsWith("// Managed by Floway Agent Setup.`n")) {
    Stop-Setup 'the gateway did not return a Floway extension.'
  }
  [System.IO.File]::WriteAllText($script:OmpExtensionStage, $source, (New-Object System.Text.UTF8Encoding($false)))
  Merge-SetupProviderExtension -ExistingPath $script:OmpExtensionPath -StagePath $script:OmpExtensionStage
}

function Set-SetupOmpRetryScalar {
  param([System.Collections.Generic.List[string]]$Lines, [string]$Key, [string]$Value)
  $header = -1
  $field = -1
  $indent = ''
  $scalar = if ($Key -eq 'enabled') { '(true|false)' } else { '[0-9]+' }
  $quotedKeyPattern = '["'']' + [Regex]::Escape($Key) + '["'']:'
  for ($i = 0; $i -lt $Lines.Count; $i++) {
    $line = $Lines[$i]
    if ($line -match '^["'']retry["'']:') { Stop-Setup 'quoted retry mapping keys cannot be edited safely.' }
    if ($line.StartsWith('retry:')) {
      if ($header -ne -1 -or $line -notmatch '^retry: *(#.*)?$') {
        Stop-Setup 'retry must be a single block-style YAML mapping without aliases.'
      }
      $header = $i
    }
  }
  if ($header -eq -1) {
    $Lines.Add('retry:')
    $Lines.Add("  ${Key}: $Value")
    return
  }
  $end = $Lines.Count
  for ($i = $header + 1; $i -lt $Lines.Count; $i++) {
    $line = $Lines[$i]
    if ($line -match '^ *(#.*)?$') { continue }
    if (-not $line.StartsWith(' ')) { $end = $i; break }
    if (-not $indent -and $line -match '^( +)\S') { $indent = $Matches[1] }
    if ($line -match $quotedKeyPattern) { Stop-Setup "quoted retry.$Key keys cannot be edited safely." }
    if ($line -match "^( +)${Key}:") {
      if ($Matches[1] -ne $indent -or $field -ne -1 -or $line -notmatch "^( +)${Key}: *$scalar( +(#.*)?)?`$") {
        Stop-Setup "retry.$Key must be a single scalar with a valid value."
      }
      $field = $i
    }
  }
  if ($field -ne -1) {
    $suffix = ''
    if ($Lines[$field] -match '( +(#.*)?)$') { $suffix = $Matches[1] }
    $Lines[$field] = "$indent${Key}: $Value$suffix"
  } else {
    if (-not $indent) { $indent = '  ' }
    $Lines.Insert($end, "$indent${Key}: $Value")
  }
}

function Stage-SetupOmpConfig {
  $retryEnabled = if ($null -eq $SetupOmpRetryEnabled) { '' } elseif ($SetupOmpRetryEnabled) { 'true' } else { 'false' }
  $script:OmpConfigStage = $null
  if ([string]::IsNullOrEmpty($SetupOmpModel) -and [string]::IsNullOrEmpty($retryEnabled) -and [string]::IsNullOrEmpty($SetupOmpMaxRetries) -and (-not (Test-Path -LiteralPath $script:OmpConfigPath))) {
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

  $managedSelected = $false
  if ($beginIdx -ne -1) {
    for ($j = $beginIdx + 1; $j -lt $endIdx; $j++) {
      if ($lines[$j].StartsWith("  default: '$SetupOmpProvider/")) { $managedSelected = $true }
    }
  }
  $newLines = New-Object System.Collections.Generic.List[string]

  if ([string]::IsNullOrEmpty($SetupOmpModel)) {
    if (-not $managedSelected) {
      for ($j = 0; $j -lt $lines.Count; $j++) { $newLines.Add($lines[$j]) }
    } else {
      for ($j = 0; $j -lt $beginIdx; $j++) { $newLines.Add($lines[$j]) }
      for ($j = $endIdx + 1; $j -lt $lines.Count; $j++) { $newLines.Add($lines[$j]) }
    }
  } else {
    $escaped = $SetupOmpModel.Replace("'", "''")
    $target = "'$SetupOmpProvider/$escaped'"
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

  if (-not [string]::IsNullOrEmpty($retryEnabled)) {
    Set-SetupOmpRetryScalar -Lines $newLines -Key enabled -Value $retryEnabled
  }
  if (-not [string]::IsNullOrEmpty($SetupOmpMaxRetries)) {
    Set-SetupOmpRetryScalar -Lines $newLines -Key maxRetries -Value $SetupOmpMaxRetries
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
  if ($script:OmpExtensionExisted -and $runningOnWindows) {
    Protect-SetupFile $script:OmpExtensionPath
    [System.IO.File]::Replace($script:OmpExtensionStage, $script:OmpExtensionPath, [System.Management.Automation.Language.NullString]::Value)
  } else {
    Move-Item -LiteralPath $script:OmpExtensionStage -Destination $script:OmpExtensionPath -Force
  }
  Protect-SetupFile $script:OmpExtensionPath
  $script:OmpExtensionStage = $null

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
  $supportedVersion = Test-SetupOmpVersion -Exe $exe
  if (-not $supportedVersion) {
    Write-SetupInfo 'Updating oh-my-pi to the latest stable version.'
    # The official updater resolves the active installation and update method.
    # https://github.com/can1357/oh-my-pi/blob/1a96f360262a7c26274646ea1e6c304d6a4ab7c8/packages/coding-agent/src/cli/update-cli.ts#L2272-L2331
    Invoke-SetupLiveProcess -Exe $exe -Arguments @('update', '--stable') -TimeoutSeconds (Get-SetupTimeoutSeconds 120)
    $exe = Get-SetupCliExe -Name omp -Label 'oh-my-pi' -Candidates $candidates
    if (-not $exe) { Stop-Setup 'oh-my-pi CLI is unavailable after updating.' }
    $supportedVersion = Test-SetupOmpVersion -Exe $exe
    if (-not $supportedVersion) {
      Stop-Setup 'Floway Agent Setup requires oh-my-pi 18.8.4 or newer; the selected CLI remains older after updating. Check for a shadowing installation.'
    }
  }

  Write-SetupAgentNotice 'Configuring' 'oh-my-pi'
  $script:OmpAgentDir = Get-SetupOmpAgentDir -Exe $exe
  if (-not (Test-Path -LiteralPath $script:OmpAgentDir)) {
    New-Item -ItemType Directory -Path $script:OmpAgentDir -Force | Out-Null
  }

  $extensionsDir = Join-Path $script:OmpAgentDir 'extensions'
  if (-not (Test-Path -LiteralPath $extensionsDir)) {
    New-Item -ItemType Directory -Path $extensionsDir -Force | Out-Null
  }
  $script:OmpExtensionPath = Join-Path $extensionsDir 'floway.js'

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
    Stage-SetupOmpExtension
  } catch {
    Write-SetupWarn 'oh-my-pi extension staging failed; rolling back configuration.'
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

  Remove-SetupOmpBackups

  Write-SetupInfo ('Written to `' + $script:OmpExtensionPath + '`.')
  if (Test-Path -LiteralPath $script:OmpConfigPath) {
    Write-SetupInfo ('Written to `' + $script:OmpConfigPath + '`.')
  }
  Write-SetupAgentNotice 'Completed Agent Setup' 'oh-my-pi'
}

$global:LASTEXITCODE = Main 'oh-my-pi'
