# The lock directory lives beside the files it protects, so Bash and PowerShell
# serialize the same target even when HOME differs or a config-root override is
# used. Directory creation is the shared exclusive-create primitive on the Bash
# 3.2 and PowerShell 5.1 baselines. A bounded wait fails safely on an abandoned
# lock; automatically breaking it cannot be made atomic across both runtimes.
$script:SetupLockPath = $null
$script:SetupLockOwner = $null
$script:SetupLockAcquired = $false

function Enter-SetupLock {
  param([string]$TargetRoot)
  if (-not (Test-Path -LiteralPath $TargetRoot)) {
    New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
  }
  $lockPath = Join-Path $TargetRoot '.floway-agent-setup.lock'
  $wait = [System.Diagnostics.Stopwatch]::StartNew()

  while ($true) {
    try {
      New-Item -ItemType Directory -Path $lockPath -ErrorAction Stop | Out-Null
      break
    } catch {
      if ($_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ResourceExists) { throw }
      # The owner can release the directory between our exclusive-create
      # failure and this observation. That is a completed handoff, so retry the
      # create; other New-Item failures retain their original error above.
      if (-not (Test-Path -LiteralPath $lockPath)) { continue }
      if ($wait.Elapsed.TotalSeconds -ge 600) {
        Stop-Setup "another Agent Setup invocation is using $TargetRoot; if no setup process is running, remove the stale lock at $lockPath and re-run."
      }
      Start-Sleep -Milliseconds 100
    }
  }

  $owner = "${PID}:$([guid]::NewGuid().ToString('N'))"
  $ownerPath = Join-Path $lockPath 'owner'
  try {
    [System.IO.File]::WriteAllText($ownerPath, $owner, [System.Text.UTF8Encoding]::new($false))
  } catch {
    if (Test-Path -LiteralPath $ownerPath) { Remove-Item -LiteralPath $ownerPath -Force }
    if (Test-Path -LiteralPath $lockPath) { Remove-Item -LiteralPath $lockPath -Force }
    throw
  }

  $script:SetupLockPath = $lockPath
  $script:SetupLockOwner = $owner
  $script:SetupLockAcquired = $true
}

function Exit-SetupLock {
  if (-not $script:SetupLockAcquired) { return }
  try {
    $ownerPath = Join-Path $script:SetupLockPath 'owner'
    $owner = if (Test-Path -LiteralPath $ownerPath) { [System.IO.File]::ReadAllText($ownerPath) } else { $null }
    if ($owner -cne $script:SetupLockOwner) {
      Write-SetupWarn "could not release the Agent Setup lock at $($script:SetupLockPath) because its owner changed."
      return
    }
    Remove-Item -LiteralPath $ownerPath -Force -ErrorAction Stop
    Remove-Item -LiteralPath $script:SetupLockPath -Force -ErrorAction Stop
  } catch {
    Write-SetupWarn "could not release the Agent Setup lock at $($script:SetupLockPath); remove it after confirming no setup process is running."
  } finally {
    $script:SetupLockPath = $null
    $script:SetupLockOwner = $null
    $script:SetupLockAcquired = $false
  }
}
