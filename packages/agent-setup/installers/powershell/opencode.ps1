# opencode Agent Setup fragment.

# Merge the converted opencode settings into the existing config. The converter
# emits `{$schema, provider: {Floway: {...}}}`; the provider subtree is merged
# into the existing document so unrelated settings survive, then the whole
# document is written back transactionally.
function Write-SetupOpencodeSettings {
  $configDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $HOME '.config\opencode' }
  $script:OpencodeConfigPath = Join-Path $configDir 'opencode.json'
  $script:OpencodeConfigBackup = $null
  $script:OpencodeConfigExisted = $false
  if (-not (Test-Path -LiteralPath $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
  }

  if (Test-Path -LiteralPath $script:OpencodeConfigPath) {
    $script:OpencodeConfigExisted = $true
    $raw = Get-Content -Raw -LiteralPath $script:OpencodeConfigPath
    try { $document = $raw | ConvertFrom-Json } catch { Stop-Setup "$($script:OpencodeConfigPath) is not valid JSON; leaving it untouched." }
    if ($document -isnot [System.Management.Automation.PSCustomObject]) { Stop-Setup "existing opencode config root is not a JSON object." }
    $stamp = [long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds
    $script:OpencodeConfigBackup = "$($script:OpencodeConfigPath).floway-backup.$stamp.$PID"
    try {
      Copy-Item -LiteralPath $script:OpencodeConfigPath -Destination $script:OpencodeConfigBackup
      Protect-SetupFile $script:OpencodeConfigBackup
    } catch {
      if (Test-Path -LiteralPath $script:OpencodeConfigBackup) { Remove-Item -LiteralPath $script:OpencodeConfigBackup -Force }
      $script:OpencodeConfigBackup = $null
      throw
    }
  } else {
    $document = [PSCustomObject]@{}
  }

  $converter = Get-SetupHarnessConverter -Name 'opencode'
  $models = Get-SetupHarnessModels
  $converted = Invoke-SetupHarnessConverter -Name 'opencode' -Converter $converter -Models $models
  $convertedDoc = $converted | ConvertFrom-Json
  if ($null -eq $convertedDoc.provider) { Stop-Setup 'the opencode converter produced no provider settings.' }
  # The converter cannot know the API key, so inject the real one into the
  # provider options. opencode sends a literal options.apiKey as the bearer.
  Set-SetupProp $convertedDoc.provider.Floway.options 'apiKey' $SetupApiKey

  if ($document.PSObject.Properties.Name -notcontains 'provider') {
    $document | Add-Member -NotePropertyName provider -NotePropertyValue ([PSCustomObject]@{})
  }
  Set-SetupProp $document.provider 'Floway' $convertedDoc.provider.Floway

  $stage = "$($script:OpencodeConfigPath).floway-stage.$PID"
  try {
    [System.IO.File]::Create($stage).Dispose()
    Protect-SetupFile $stage
    $json = $document | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText($stage, $json, (New-Object System.Text.UTF8Encoding($false)))
    $check = Get-Content -Raw -LiteralPath $stage | ConvertFrom-Json
    if ($null -eq $check.provider.Floway) { Stop-Setup 'staged opencode settings failed validation.' }
    $runningOnWindows = Test-SetupIsWindows
    if ($script:OpencodeConfigExisted -and $runningOnWindows) {
      Protect-SetupFile $script:OpencodeConfigPath
      [System.IO.File]::Replace($stage, $script:OpencodeConfigPath, [System.Management.Automation.Language.NullString]::Value)
    } else {
      Move-Item -LiteralPath $stage -Destination $script:OpencodeConfigPath -Force
    }
    Remove-SetupOlderBackups -Path $script:OpencodeConfigPath -Keep $script:OpencodeConfigBackup
  } catch {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force }
    Restore-SetupManagedFile -Existed $script:OpencodeConfigExisted -Backup $script:OpencodeConfigBackup -Path $script:OpencodeConfigPath -OriginalLabel 'file' -CreatedLabel 'opencode settings'
    throw
  }
}

# Fetch the model list, convert it, and merge the opencode config file.
function Set-SetupAgent {
  Write-SetupAgentNotice 'Configuring' 'opencode'
  try {
    Write-SetupOpencodeSettings
    Write-SetupInfo ('Written to `' + $script:OpencodeConfigPath + '`.')
    Write-SetupAgentNotice 'Completed Agent Setup' 'opencode'
  } finally {
    Remove-SetupHarnessTmpDir
  }
}


$global:LASTEXITCODE = Main 'opencode'
