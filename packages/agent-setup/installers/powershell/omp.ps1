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

function Get-SetupOmpNativePaths {
  param([string]$Exe)
  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('floway-omp-' + [System.Guid]::NewGuid().ToString('N'))
  [void][System.IO.Directory]::CreateDirectory($tempDir)

  $pathsFile = Join-Path $tempDir 'paths.json'
  $probePath = Join-Path $tempDir 'paths.mjs'
  # Plugins can live outside the agent directory under profiles or XDG.
  # https://github.com/can1357/oh-my-pi/blob/cde91bb38674d365e8c3916d05d2292273bb8554/packages/utils/src/dirs.ts#L660-L688
  $probe = @'
import { getAgentDir, getPluginsDir } from '@oh-my-pi/pi-utils';
import { writeFileSync } from 'node:fs';
export default pi => {
  writeFileSync(process.env.FLOWAY_SETUP_PATHS_FILE, JSON.stringify({ agentDir: getAgentDir(), pluginsDir: getPluginsDir() }));
  pi.on('session_start', (_event, ctx) => ctx.shutdown());
};
'@
  $previousPathsFile = [Environment]::GetEnvironmentVariable('FLOWAY_SETUP_PATHS_FILE')
  try {
    if (-not (Test-SetupIsWindows)) {
      & chmod 700 $tempDir
      if ($LASTEXITCODE -ne 0) { Stop-Setup "could not protect $tempDir." }
    }
    [System.IO.File]::WriteAllText($probePath, $probe, (New-Object System.Text.UTF8Encoding($false)))
    $env:FLOWAY_SETUP_PATHS_FILE = $pathsFile
    $probeResult = Invoke-SetupProcess -Exe $Exe -Arguments @('--mode', 'rpc', '--no-ui', '--no-session', '--no-tools', '--no-lsp', '--no-skills', '--no-rules', '--no-extensions', '-e', $probePath) -TimeoutSeconds (Get-SetupTimeoutSeconds 30)
    if ($probeResult.ExitCode -ne 0) { Stop-Setup ('`omp` path probe failed. ' + $probeResult.Output) }
    if (-not (Test-Path -LiteralPath $pathsFile -PathType Leaf)) { Stop-Setup ('`omp` path probe did not write its result. ' + $probeResult.Output) }
    $paths = [System.IO.File]::ReadAllText($pathsFile) | ConvertFrom-Json -ErrorAction Stop
    if ($paths.agentDir -isnot [string] -or [string]::IsNullOrEmpty($paths.agentDir) -or $paths.pluginsDir -isnot [string] -or [string]::IsNullOrEmpty($paths.pluginsDir)) {
      Stop-Setup 'the oh-my-pi path probe returned invalid native directories.'
    }
    return $paths
  } finally {
    if ($null -eq $previousPathsFile) {
      Remove-Item Env:FLOWAY_SETUP_PATHS_FILE -ErrorAction SilentlyContinue
    } else {
      $env:FLOWAY_SETUP_PATHS_FILE = $previousPathsFile
    }
    if (Test-Path -LiteralPath $tempDir) {
      Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Get-SetupOmpJsonProperty {
  param($Target, [string]$Name)
  return ($Target.PSObject.Properties | Where-Object { $_.Name -ceq $Name } | Select-Object -First 1)
}

function Get-SetupOmpJsonObject {
  param($Parent, [string]$Name)
  $property = Get-SetupOmpJsonProperty -Target $Parent -Name $Name
  if ($null -eq $property) {
    $value = [PSCustomObject]@{}
    Set-SetupProp $Parent $Name $value
    return $value
  }
  $value = $property.Value
  if ($null -eq $value -or $value -is [array] -or $value -isnot [System.Management.Automation.PSCustomObject]) {
    Stop-Setup "$Name must be a JSON object in omp-plugins.lock.json."
  }
  return $value
}

function Get-SetupOmpPluginLinkItem {
  try {
    return Get-Item -LiteralPath $script:OmpPluginLinkPath -Force -ErrorAction Stop
  } catch [System.Management.Automation.ItemNotFoundException] {
    return $null
  }
}

function Test-SetupOmpPluginLink {
  $item = Get-SetupOmpPluginLinkItem
  if ($null -eq $item) {
    $script:OmpPluginLinkExisted = $false
    return
  }
  if ($item.Target -cne $script:OmpPluginDir) {
    Stop-Setup 'an unmanaged @floway-dev/omp plugin is already installed.'
  }
  $script:OmpPluginLinkExisted = $true
}

function Remove-SetupOmpPluginLink {
  $item = Get-SetupOmpPluginLinkItem
  if ($item -and $item.Target -ceq $script:OmpPluginDir) {
    Remove-Item -LiteralPath $script:OmpPluginLinkPath -Force -ErrorAction Stop
  }
}

function Backup-SetupOmpFiles {
  $script:OmpPluginSettingsExisted = $false
  $script:OmpManifestExisted = $false
  $script:OmpExtensionExisted = $false
  $script:OmpConfigExisted = $false
  $script:OmpPluginSettingsBackup = $null
  $script:OmpManifestBackup = $null
  $script:OmpExtensionBackup = $null
  $script:OmpConfigBackup = $null
  $stamp = [long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds
  if (Test-Path -LiteralPath $script:OmpPluginSettingsPath) {
    $script:OmpPluginSettingsExisted = $true
    $script:OmpPluginSettingsBackup = "$($script:OmpPluginSettingsPath).floway-backup.$stamp.$PID"
    [System.IO.File]::WriteAllText($script:OmpPluginSettingsBackup, '')
    Protect-SetupFile $script:OmpPluginSettingsBackup
    [System.IO.File]::WriteAllBytes($script:OmpPluginSettingsBackup, [System.IO.File]::ReadAllBytes($script:OmpPluginSettingsPath))
  }
  if (Test-Path -LiteralPath $script:OmpExtensionPath) {
    $script:OmpExtensionExisted = $true
    $script:OmpExtensionBackup = "$($script:OmpExtensionPath).floway-backup.$stamp.$PID"
    Copy-Item -LiteralPath $script:OmpExtensionPath -Destination $script:OmpExtensionBackup -ErrorAction Stop
    Protect-SetupFile $script:OmpExtensionBackup
  }
  if (Test-Path -LiteralPath $script:OmpManifestPath) {
    $script:OmpManifestExisted = $true
    $script:OmpManifestBackup = "$($script:OmpManifestPath).floway-backup.$stamp.$PID"
    Copy-Item -LiteralPath $script:OmpManifestPath -Destination $script:OmpManifestBackup -ErrorAction Stop
  }
  if (Test-Path -LiteralPath $script:OmpConfigPath) {
    $script:OmpConfigExisted = $true
    $script:OmpConfigBackup = "$($script:OmpConfigPath).floway-backup.$stamp.$PID"
    Copy-Item -LiteralPath $script:OmpConfigPath -Destination $script:OmpConfigBackup -ErrorAction Stop
  }
}

function Restore-SetupOmpFiles {
  if ($script:OmpPluginSettingsStage -and (Test-Path -LiteralPath $script:OmpPluginSettingsStage)) {
    Remove-Item -LiteralPath $script:OmpPluginSettingsStage -Force -ErrorAction SilentlyContinue
  }
  if ($script:OmpExtensionStage -and (Test-Path -LiteralPath $script:OmpExtensionStage)) {
    Remove-Item -LiteralPath $script:OmpExtensionStage -Force -ErrorAction SilentlyContinue
  }
  if ($script:OmpManifestStage -and (Test-Path -LiteralPath $script:OmpManifestStage)) {
    Remove-Item -LiteralPath $script:OmpManifestStage -Force -ErrorAction SilentlyContinue
  }
  if ($script:OmpConfigStage -and (Test-Path -LiteralPath $script:OmpConfigStage)) {
    Remove-Item -LiteralPath $script:OmpConfigStage -Force -ErrorAction SilentlyContinue
  }
  if (-not $script:OmpPluginLinkExisted -and $script:OmpPluginLinkAttempted) {
    try { Remove-SetupOmpPluginLink } catch {
      Write-SetupWarn "could not remove the new @floway-dev/omp plugin link at $script:OmpPluginLinkPath — remove it by hand."
    }
  }
  Restore-SetupManagedFile -Existed $script:OmpExtensionExisted -Backup $script:OmpExtensionBackup -Path $script:OmpExtensionPath -OriginalLabel 'plugin extension file' -CreatedLabel 'oh-my-pi plugin extension file'
  Restore-SetupManagedFile -Existed $script:OmpManifestExisted -Backup $script:OmpManifestBackup -Path $script:OmpManifestPath -OriginalLabel 'plugin manifest' -CreatedLabel 'oh-my-pi plugin manifest'
  Restore-SetupManagedFile -Existed $script:OmpConfigExisted -Backup $script:OmpConfigBackup -Path $script:OmpConfigPath -OriginalLabel 'config file' -CreatedLabel 'oh-my-pi config file'

  if ($script:OmpPluginLinkExisted -and $script:OmpPluginLinkAttempted -and (-not (Get-SetupOmpPluginLinkItem))) {
    try {
      $linkType = if (Test-SetupIsWindows) { 'Junction' } else { 'SymbolicLink' }
      [void](New-Item -ItemType $linkType -Path $script:OmpPluginLinkPath -Target $script:OmpPluginDir)
    } catch {
      Write-SetupWarn "could not recreate the existing @floway-dev/omp plugin link at $script:OmpPluginLinkPath — re-run Agent Setup after restoring the original files."
    }
  }
  Restore-SetupManagedFile -Existed $script:OmpPluginSettingsExisted -Backup $script:OmpPluginSettingsBackup -Path $script:OmpPluginSettingsPath -OriginalLabel 'plugin settings file' -CreatedLabel 'oh-my-pi plugin settings file'
}

function Remove-SetupOmpBackups {
  Remove-SetupOlderBackups -Path $script:OmpManifestPath -Keep $script:OmpManifestBackup
  if ($script:OmpManifestBackup) { Remove-Item -LiteralPath $script:OmpManifestBackup -Force -ErrorAction Stop }
  $script:OmpManifestBackup = $null
  Remove-SetupOlderBackups -Path $script:OmpExtensionPath -Keep $script:OmpExtensionBackup
  if ($script:OmpExtensionBackup) { Remove-Item -LiteralPath $script:OmpExtensionBackup -Force -ErrorAction Stop }
  $script:OmpExtensionBackup = $null
  Remove-SetupOlderBackups -Path $script:OmpPluginSettingsPath -Keep $script:OmpPluginSettingsBackup
  if ($script:OmpPluginSettingsBackup) { Remove-Item -LiteralPath $script:OmpPluginSettingsBackup -Force -ErrorAction Stop }
  $script:OmpPluginSettingsBackup = $null
  Remove-SetupOlderBackups -Path $script:OmpConfigPath -Keep $script:OmpConfigBackup
  if ($script:OmpConfigBackup) { Remove-Item -LiteralPath $script:OmpConfigBackup -Force -ErrorAction Stop }
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

function Stage-SetupOmpPluginSettings {
  try {
    $configuration = if (Test-Path -LiteralPath $script:OmpPluginSettingsPath) {
      $source = [System.IO.File]::ReadAllText($script:OmpPluginSettingsPath)
      if (-not $source.TrimStart().StartsWith('{')) { throw 'the oh-my-pi plugin settings root must be a JSON object.' }
      $source | ConvertFrom-Json -ErrorAction Stop
    } else { [PSCustomObject]@{} }
  } catch {
    throw [System.Exception]::new('could not read oh-my-pi plugin settings', $_.Exception)
  }
  [void](Get-SetupOmpJsonObject -Parent $configuration -Name 'plugins')
  $settings = Get-SetupOmpJsonObject -Parent $configuration -Name 'settings'
  $namespace = Get-SetupOmpJsonObject -Parent $settings -Name '@floway-dev/omp'
  $connectionsProperty = Get-SetupOmpJsonProperty -Target $namespace -Name 'connections'
  if ($null -eq $connectionsProperty) {
    $connections = @()
  } elseif ($connectionsProperty.Value -is [array]) {
    $connections = @($connectionsProperty.Value)
  } else {
    Stop-Setup 'settings["@floway-dev/omp"].connections must be a JSON array in omp-plugins.lock.json.'
  }
  $connection = [PSCustomObject]@{
    provider = $SetupOmpProvider
    endpoint = $SetupEndpoint.TrimEnd('/')
    apiKey = $SetupApiKey
  }
  Set-SetupProp $namespace 'connections' (@($connections | Where-Object { $_.provider -cne $SetupOmpProvider }) + $connection)

  $script:OmpPluginSettingsStage = "$($script:OmpPluginSettingsPath).floway-stage.$PID"
  [System.IO.File]::Create($script:OmpPluginSettingsStage).Dispose()
  Protect-SetupFile $script:OmpPluginSettingsStage
  [System.IO.File]::WriteAllText($script:OmpPluginSettingsStage, (ConvertTo-Json -InputObject $configuration -Depth 100) + "`n", (New-Object System.Text.UTF8Encoding($false)))
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
  Stage-SetupOmpPluginSettings

  $script:OmpManifestStage = "$($script:OmpManifestPath).floway-stage.$PID"
  [System.IO.File]::Create($script:OmpManifestStage).Dispose()
  Protect-SetupFile $script:OmpManifestStage
  $manifest = '{"name":"@floway-dev/omp","version":"1.0.0","type":"module","omp":{"extensions":["index.js"]}}' + "`n"
  [System.IO.File]::WriteAllText($script:OmpManifestStage, $manifest, (New-Object System.Text.UTF8Encoding($false)))
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

function Apply-SetupOmpFile {
  param([string]$StagePath, [string]$Path, [bool]$Existed)
  if ($Existed -and (Test-SetupIsWindows)) {
    Protect-SetupFile $Path
    [System.IO.File]::Replace($StagePath, $Path, [System.Management.Automation.Language.NullString]::Value)
  } else {
    Move-Item -LiteralPath $StagePath -Destination $Path -Force
  }
}

function Apply-SetupOmpStaged {
  $runningOnWindows = Test-SetupIsWindows
  Apply-SetupOmpFile -StagePath $script:OmpPluginSettingsStage -Path $script:OmpPluginSettingsPath -Existed $script:OmpPluginSettingsExisted
  $script:OmpPluginSettingsStage = $null
  Apply-SetupOmpFile -StagePath $script:OmpExtensionStage -Path $script:OmpExtensionPath -Existed $script:OmpExtensionExisted
  $script:OmpExtensionStage = $null
  Apply-SetupOmpFile -StagePath $script:OmpManifestStage -Path $script:OmpManifestPath -Existed $script:OmpManifestExisted
  $script:OmpManifestStage = $null

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

  $script:OmpPluginLinkAttempted = $true
  Invoke-SetupLiveProcess -Exe $script:OmpExe -Arguments @('plugin', 'link', $script:OmpPluginDir) -TimeoutSeconds (Get-SetupTimeoutSeconds 120)
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
  $script:OmpExe = $exe
  $paths = Get-SetupOmpNativePaths -Exe $exe
  $script:OmpAgentDir = $paths.agentDir
  $script:OmpPluginsDir = $paths.pluginsDir
  [void][System.IO.Directory]::CreateDirectory($script:OmpAgentDir)
  [void][System.IO.Directory]::CreateDirectory($script:OmpPluginsDir)

  $script:OmpPluginDir = Join-Path $script:OmpPluginsDir 'floway'
  $script:OmpPluginSettingsPath = Join-Path $script:OmpPluginsDir 'omp-plugins.lock.json'
  $script:OmpExtensionPath = Join-Path $script:OmpPluginDir 'index.js'
  $script:OmpManifestPath = Join-Path $script:OmpPluginDir 'package.json'
  $script:OmpPluginLinkPath = Join-Path (Join-Path (Join-Path $script:OmpPluginsDir 'node_modules') '@floway-dev') 'omp'
  $script:OmpPluginLinkAttempted = $false
  Test-SetupOmpPluginLink
  [void][System.IO.Directory]::CreateDirectory($script:OmpPluginDir)

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
  Write-SetupInfo ('Written to `' + $script:OmpPluginSettingsPath + '`.')
  if (Test-Path -LiteralPath $script:OmpConfigPath) {
    Write-SetupInfo ('Written to `' + $script:OmpConfigPath + '`.')
  }
  Write-SetupAgentNotice 'Completed Agent Setup' 'oh-my-pi'
}

$global:LASTEXITCODE = Main 'oh-my-pi'
