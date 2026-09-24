# oh-my-pi Agent Setup fragment.

# The oh-my-pi converter emits YAML, which requires the PyYAML module. Check
# for it before any file is touched so a missing module fails cleanly.
function Test-SetupOmpYaml {
  $python = Get-SetupHarnessPython
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $python
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.Arguments = '-c "import yaml"'
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { Stop-Setup 'failed to start Python.' }
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(30000)) { Stop-SetupProcessTree $process; $process.WaitForExit(); Stop-Setup 'the PyYAML check timed out.' }
  $null = $stderrTask.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) {
    Stop-Setup 'the oh-my-pi converter requires the PyYAML module; install it with `python3 -m pip install pyyaml`.'
  }
}

# Write the converted oh-my-pi settings and the API key transactionally: back
# up the existing files (if any), stage the new content in the same directory,
# validate it, and rename it into place with owner-only access. The converter
# references the key by the FLOWAY_API_KEY env name, which oh-my-pi resolves
# from its eager .env loading; the key is staged into the same agent directory
# as models.yml so omp authenticates with the real token instead of the literal
# env-var name.
# Ref: https://github.com/can1357/oh-my-pi/blob/main/docs/models.md (apiKey env-name-or-literal semantics)
# Ref: https://github.com/can1357/oh-my-pi/blob/main/packages/utils/src/env.ts (eager agent-dir .env loading)
function Write-SetupOmpSettings {
  $configDir = if ($env:OMP_CONFIG_DIR) { $env:OMP_CONFIG_DIR } else { Join-Path $HOME '.omp' }
  $targetDir = Join-Path $configDir 'agent'
  $script:OmpModelsPath = Join-Path $targetDir 'models.yml'
  $script:OmpEnvPath = Join-Path $targetDir '.env'
  $script:OmpModelsBackup = $null
  $script:OmpEnvBackup = $null
  $script:OmpModelsExisted = $false
  $script:OmpEnvExisted = $false
  if (-not (Test-Path -LiteralPath $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
  }

  if ($SetupApiKey -match "['\\`r`n]") {
    Stop-Setup 'the oh-my-pi API key contains characters that cannot be stored in the oh-my-pi .env file.'
  }

  if (Test-Path -LiteralPath $script:OmpModelsPath) {
    $script:OmpModelsExisted = $true
    $stamp = [long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds
    $script:OmpModelsBackup = "$($script:OmpModelsPath).floway-backup.$stamp.$PID"
    try {
      Copy-Item -LiteralPath $script:OmpModelsPath -Destination $script:OmpModelsBackup
      Protect-SetupFile $script:OmpModelsBackup
    } catch {
      if (Test-Path -LiteralPath $script:OmpModelsBackup) { Remove-Item -LiteralPath $script:OmpModelsBackup -Force }
      $script:OmpModelsBackup = $null
      throw
    }
  }
  if (Test-Path -LiteralPath $script:OmpEnvPath) {
    $script:OmpEnvExisted = $true
    $stamp = [long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds
    $script:OmpEnvBackup = "$($script:OmpEnvPath).floway-backup.$stamp.$PID"
    try {
      Copy-Item -LiteralPath $script:OmpEnvPath -Destination $script:OmpEnvBackup
      Protect-SetupFile $script:OmpEnvBackup
    } catch {
      if (Test-Path -LiteralPath $script:OmpEnvBackup) { Remove-Item -LiteralPath $script:OmpEnvBackup -Force }
      $script:OmpEnvBackup = $null
      throw
    }
  }

  $converter = Get-SetupHarnessConverter -Name 'omp'
  $models = Get-SetupHarnessModels
  $converted = Invoke-SetupHarnessConverter -Name 'omp' -Converter $converter -Models $models
  if ($converted -notmatch '(?ms)^providers:') {
    Stop-Setup 'the oh-my-pi converter produced no provider settings.'
  }

  $stage = "$($script:OmpModelsPath).floway-stage.$PID"
  try {
    [System.IO.File]::Create($stage).Dispose()
    Protect-SetupFile $stage
    [System.IO.File]::WriteAllText($stage, $converted, (New-Object System.Text.UTF8Encoding($false)))
    $check = Get-Content -Raw -LiteralPath $stage
    if ($check -notmatch '(?ms)^providers:') { Stop-Setup 'staged oh-my-pi settings failed validation.' }
    $runningOnWindows = Test-SetupIsWindows
    if ($script:OmpModelsExisted -and $runningOnWindows) {
      Protect-SetupFile $script:OmpModelsPath
      [System.IO.File]::Replace($stage, $script:OmpModelsPath, [System.Management.Automation.Language.NullString]::Value)
    } else {
      Move-Item -LiteralPath $stage -Destination $script:OmpModelsPath -Force
    }
    Remove-SetupOlderBackups -Path $script:OmpModelsPath -Keep $script:OmpModelsBackup
  } catch {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force }
    Restore-SetupManagedFile -Existed $script:OmpModelsExisted -Backup $script:OmpModelsBackup -Path $script:OmpModelsPath -OriginalLabel 'file' -CreatedLabel 'oh-my-pi settings'
    throw
  }

  # Stage the key into the agent .env, preserving unrelated lines and replacing
  # any prior FLOWAY_API_KEY entry.
  $envStage = "$($script:OmpEnvPath).floway-stage.$PID"
  try {
    $envLines = @()
    if (Test-Path -LiteralPath $script:OmpEnvPath) {
      $envLines = Get-Content -LiteralPath $script:OmpEnvPath | Where-Object { $_ -notmatch '^(export\s+)?FLOWAY_API_KEY=' }
    }
    $envLines += "FLOWAY_API_KEY='$SetupApiKey'"
    [System.IO.File]::Create($envStage).Dispose()
    Protect-SetupFile $envStage
    [System.IO.File]::WriteAllLines($envStage, $envLines, (New-Object System.Text.UTF8Encoding($false)))
    $check = Get-Content -Raw -LiteralPath $envStage
    if ($check -notmatch '(?m)^FLOWAY_API_KEY=') { Stop-Setup 'staged oh-my-pi API key failed validation.' }
    $runningOnWindows = Test-SetupIsWindows
    if ($script:OmpEnvExisted -and $runningOnWindows) {
      Protect-SetupFile $script:OmpEnvPath
      [System.IO.File]::Replace($envStage, $script:OmpEnvPath, [System.Management.Automation.Language.NullString]::Value)
    } else {
      Move-Item -LiteralPath $envStage -Destination $script:OmpEnvPath -Force
    }
    Remove-SetupOlderBackups -Path $script:OmpEnvPath -Keep $script:OmpEnvBackup
  } catch {
    if (Test-Path -LiteralPath $envStage) { Remove-Item -LiteralPath $envStage -Force }
    Restore-SetupManagedFile -Existed $script:OmpEnvExisted -Backup $script:OmpEnvBackup -Path $script:OmpEnvPath -OriginalLabel 'file' -CreatedLabel 'oh-my-pi API key'
    throw
  }
}

# Fetch the model list, convert it, and install the oh-my-pi settings file.
function Set-SetupAgent {
  Write-SetupAgentNotice 'Configuring' 'oh-my-pi'
  try {
    Test-SetupOmpYaml
    Write-SetupOmpSettings
    Write-SetupInfo ('Written to `' + $script:OmpModelsPath + '`.')
    Write-SetupAgentNotice 'Completed Agent Setup' 'oh-my-pi'
  } finally {
    Remove-SetupHarnessTmpDir
  }
}


$global:LASTEXITCODE = Main 'oh-my-pi'
