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
  if ($version.ExitCode -ne 0) { Stop-Setup ('`omp --version` failed. ' + $version.Output) }
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
  $script:OmpConnectionsExisted = $false
  $script:OmpConfigExisted = $false
  $script:OmpExtensionBackup = $null
  $script:OmpConnectionsBackup = $null
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
  if (Test-Path -LiteralPath $script:OmpConnectionsPath) {
    $script:OmpConnectionsExisted = $true
    $script:OmpConnectionsBackup = "$($script:OmpConnectionsPath).floway-backup.$stamp.$PID"
    try {
      Copy-Item -LiteralPath $script:OmpConnectionsPath -Destination $script:OmpConnectionsBackup
      Protect-SetupFile $script:OmpConnectionsBackup
    } catch {
      if (Test-Path -LiteralPath $script:OmpConnectionsBackup) {
        Remove-Item -LiteralPath $script:OmpConnectionsBackup -Force
      }
      $script:OmpConnectionsBackup = $null
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
  if ($script:OmpConnectionsStage -and (Test-Path -LiteralPath $script:OmpConnectionsStage)) {
    Remove-Item -LiteralPath $script:OmpConnectionsStage -Force -ErrorAction SilentlyContinue
  }
  if ($script:OmpConfigStage -and (Test-Path -LiteralPath $script:OmpConfigStage)) {
    Remove-Item -LiteralPath $script:OmpConfigStage -Force -ErrorAction SilentlyContinue
  }
  Restore-SetupManagedFile -Existed $script:OmpExtensionExisted -Backup $script:OmpExtensionBackup -Path $script:OmpExtensionPath -OriginalLabel 'extension file' -CreatedLabel 'oh-my-pi extension file'
  Restore-SetupManagedFile -Existed $script:OmpConnectionsExisted -Backup $script:OmpConnectionsBackup -Path $script:OmpConnectionsPath -OriginalLabel 'connection file' -CreatedLabel 'oh-my-pi connection file'
  Restore-SetupManagedFile -Existed $script:OmpConfigExisted -Backup $script:OmpConfigBackup -Path $script:OmpConfigPath -OriginalLabel 'config file' -CreatedLabel 'oh-my-pi config file'
}

function Remove-SetupOmpBackups {
  Remove-SetupOlderBackups -Path $script:OmpExtensionPath -Keep $script:OmpExtensionBackup
  if ($script:OmpExtensionBackup) {
    Remove-Item -LiteralPath $script:OmpExtensionBackup -Force -ErrorAction Stop
  }
  $script:OmpExtensionBackup = $null

  Remove-SetupOlderBackups -Path $script:OmpConnectionsPath -Keep $script:OmpConnectionsBackup
  if ($script:OmpConnectionsBackup) {
    Remove-Item -LiteralPath $script:OmpConnectionsBackup -Force -ErrorAction Stop
  }
  $script:OmpConnectionsBackup = $null

  Remove-SetupOlderBackups -Path $script:OmpConfigPath -Keep $script:OmpConfigBackup
  if ($script:OmpConfigBackup) {
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
  $uri = $SetupEndpoint.TrimEnd('/') + $SetupExtensionPath
  $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 30
  $source = [string]$response.Content
  if (-not $source.StartsWith("// Managed by Floway Agent Setup.`n")) {
    Stop-Setup 'the gateway did not return a Floway extension.'
  }
  [System.IO.File]::WriteAllText($script:OmpExtensionStage, $source, (New-Object System.Text.UTF8Encoding($false)))
  $script:OmpConnectionsStage = "$($script:OmpConnectionsPath).floway-stage.$PID"
  Stage-SetupProviderConnections -ExistingPath $script:OmpConnectionsPath -StagePath $script:OmpConnectionsStage -Provider $SetupOmpProvider -IncludeKey $true
}

function Set-SetupOmpRetryScalar {
  param([System.Collections.Generic.List[string]]$Lines, [string]$Key, [string]$Value)
  $header = -1
  $field = -1
  $indent = ''
  $quotedKeyPattern = '^ +["'']' + [Regex]::Escape($Key) + '["'']:'
  for ($i = 0; $i -lt $Lines.Count; $i++) {
    $line = $Lines[$i]
    if ($line -cmatch '^["'']retry["'']:') { Stop-Setup 'quoted retry mapping keys cannot be edited safely.' }
    if ($line.StartsWith('retry:')) {
      if ($header -ne -1 -or $line -cnotmatch '^retry: *(#.*)?$') {
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
    if ($line -cmatch '^ *(#.*)?$') { continue }
    if (-not $line.StartsWith(' ')) { $end = $i; break }
    if (-not $indent -and $line -cmatch '^( +)\S') { $indent = $Matches[1] }
    if ($line -cmatch $quotedKeyPattern) { Stop-Setup "quoted retry.$Key keys cannot be edited safely." }
    if ($line -cmatch "^( +)${Key}:") {
      if ($Matches[1] -ne $indent -or $field -ne -1 -or $line -cnotmatch "^( +)${Key}: *[A-Za-z0-9_.+-]*( +(#.*)?)?`$") {
        Stop-Setup "retry.$Key must be a single scalar with a valid value."
      }
      $field = $i
    }
  }
  if ($field -ne -1) {
    $suffix = ''
    if ($Lines[$field] -cmatch '( +(#.*)?)$') { $suffix = $Matches[1] }
    $Lines[$field] = "$indent${Key}: $Value$suffix"
  } else {
    if (-not $indent) { $indent = '  ' }
    $Lines.Insert($end, "$indent${Key}: $Value")
  }
}

function Set-SetupOmpDefaultRole {
  param([System.Collections.Generic.List[string]]$Lines)
  $header = -1
  $field = -1
  $indent = ''
  $prefix = ''
  $suffix = ''
  $scalar = ''
  $kind = ''
  for ($i = 0; $i -lt $Lines.Count; $i++) {
    $line = $Lines[$i]
    if ($line -cmatch '^["'']modelRoles["'']:') { Stop-Setup 'quoted modelRoles mapping keys cannot be edited safely.' }
    if ($line.StartsWith('modelRoles:')) {
      if ($header -ne -1 -or $line -cnotmatch '^modelRoles: *(#.*)?$') { Stop-Setup 'modelRoles must be a single block-style YAML mapping without aliases.' }
      $header = $i
    }
  }
  $target = if ([string]::IsNullOrEmpty($SetupOmpModel)) { '' } else {
    [Regex]::Replace((ConvertTo-Json -InputObject "$SetupOmpProvider/$SetupOmpModel" -Compress), '[\x7f-\uffff]', { param($match) '\u{0:x4}' -f [int][char]$match.Value[0] })
  }
  if ($header -eq -1) {
    if ($target) { $Lines.Add('modelRoles:'); $Lines.Add("  default: $target") }
    return
  }
  $end = $Lines.Count
  for ($i = $header + 1; $i -lt $Lines.Count; $i++) {
    $line = $Lines[$i]
    if ($line -cmatch '^ *(#.*)?$') { continue }
    if (-not $line.StartsWith(' ')) { $end = $i; break }
    if (-not $indent -and $line -cmatch '^( +)\S') { $indent = $Matches[1] }
    if ($line -cmatch '^ +["'']default["'']:') { Stop-Setup 'quoted modelRoles.default keys cannot be edited safely.' }
    if ($line -cmatch '^( +)default: *(.*)$') {
      if ($field -ne -1 -or $Matches[1] -ne $indent) { Stop-Setup 'modelRoles.default must be a single direct scalar.' }
      $field = $i
      $prefix = $Matches[1]
      $value = $Matches[2]
      $suffix = ''
      if ($value.StartsWith('#')) {
        $scalar = ''; $suffix = " $value"; $kind = 'plain'
      } elseif ($value.StartsWith("'")) {
        if ($value -cnotmatch '^(''([^'']|'''')*'')( *(#.*)?)$') { Stop-Setup 'modelRoles.default cannot be edited safely.' }
        $scalar = $Matches[1]; $suffix = $Matches[3]; $kind = 'single'
      } elseif ($value.StartsWith('"')) {
        if ($value -cnotmatch '^("([^"\\]|\\.)*")( *(#.*)?)$') { Stop-Setup 'modelRoles.default cannot be edited safely.' }
        $scalar = $Matches[1]; $suffix = $Matches[3]; $kind = 'double'
      } else {
        if ($value -cmatch '^[\[{&*!|>]') { Stop-Setup 'modelRoles.default cannot be edited safely.' }
        $comment = $value.IndexOf(' #')
        $raw = if ($comment -eq -1) { $value } else { $value.Substring(0, $comment) }
        $scalar = $raw.TrimEnd(' ')
        $suffix = $value.Substring($scalar.Length)
        $kind = 'plain'
      }
    } elseif ($line -cmatch '^ +<<:' -or $line.Substring($line.IndexOf(':') + 1) -cmatch '^ *[&*]') {
      Stop-Setup 'YAML anchors, aliases, or merge keys touching modelRoles cannot be edited safely.'
    }
  }
  if ($target) {
    if ($field -ne -1) { $Lines[$field] = "${prefix}default: $target$suffix" }
    else { if (-not $indent) { $indent = '  ' }; $Lines.Insert($end, "${indent}default: $target") }
  } elseif ($field -ne -1) {
    $value = switch ($kind) {
      { $_ -eq 'single' -or $_ -eq 'double' } { $scalar.Substring(1) }
      plain { $scalar }
    }
    if (-not $value.StartsWith("$SetupOmpProvider/", [StringComparison]::Ordinal)) { return }
    if ($suffix.Contains('#')) { $Lines[$field] = "$prefix$suffix" }
    else { $Lines.RemoveAt($field); $end-- }
    $other = $false
    for ($i = $header + 1; $i -lt $end; $i++) {
      if ($Lines[$i] -cnotmatch '^ *(#.*)?$') { $other = $true; break }
    }
    if (-not $other) {
      if ($Lines[$header].Contains('#')) { $Lines[$header] = $Lines[$header].Substring('modelRoles:'.Length) }
      else { $Lines.RemoveAt($header) }
    }
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

  $newLines = $lines
  foreach ($line in $newLines) {
    if ($line -match "^ *`t") { Stop-Setup "tabs found in $($script:OmpConfigPath); YAML disallows tab indentation." }
  }
  Set-SetupOmpDefaultRole -Lines $newLines

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
  if ($script:OmpConnectionsExisted -and $runningOnWindows) {
    Protect-SetupFile $script:OmpConnectionsPath
    [System.IO.File]::Replace($script:OmpConnectionsStage, $script:OmpConnectionsPath, [System.Management.Automation.Language.NullString]::Value)
  } else {
    Move-Item -LiteralPath $script:OmpConnectionsStage -Destination $script:OmpConnectionsPath -Force
  }
  $script:OmpConnectionsStage = $null

  if ($script:OmpExtensionExisted -and $runningOnWindows) {
    Protect-SetupFile $script:OmpExtensionPath
    [System.IO.File]::Replace($script:OmpExtensionStage, $script:OmpExtensionPath, [System.Management.Automation.Language.NullString]::Value)
  } else {
    Move-Item -LiteralPath $script:OmpExtensionStage -Destination $script:OmpExtensionPath -Force
  }
  $script:OmpExtensionStage = $null

  if ($script:OmpConfigStage) {
    $stageItem = Get-Item -LiteralPath $script:OmpConfigStage -ErrorAction Stop
    if ($stageItem.Length -gt 0) {
      if ($script:OmpConfigExisted -and $runningOnWindows) {
        Protect-SetupFile $script:OmpConfigPath
        [System.IO.File]::Replace($script:OmpConfigStage, $script:OmpConfigPath, [System.Management.Automation.Language.NullString]::Value)
      } else {
        Move-Item -LiteralPath $script:OmpConfigStage -Destination $script:OmpConfigPath -Force
      }
    } else {
      Remove-Item -LiteralPath $script:OmpConfigStage -Force -ErrorAction Stop
      if (Test-Path -LiteralPath $script:OmpConfigPath) {
        Remove-Item -LiteralPath $script:OmpConfigPath -Force -ErrorAction Stop
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
  $extensionsDir = Join-Path $script:OmpAgentDir 'extensions'
  [void][System.IO.Directory]::CreateDirectory($extensionsDir)
  $script:OmpConnectionsPath = Join-Path $script:OmpAgentDir 'floway.json'
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
