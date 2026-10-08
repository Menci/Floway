# Restrict a file to the current user: chmod 0600 on Unix, an inheritance-free
# owner-only ACL on Windows.
function Protect-SetupFile {
  param([string]$Path)
  if (-not (Test-SetupIsWindows)) {
    & chmod 600 $Path
    if ($LASTEXITCODE -ne 0) { Stop-Setup "could not restrict $Path to owner-only access." }
    return
  }
  # Set-Acl routes through the PowerShell filesystem provider and may persist
  # the untouched SACL, demanding SeSecurityPrivilege from a normal user. The
  # direct .NET APIs write only this descriptor's modified DACL.
  # https://github.com/PowerShell/PowerShell/blob/0c226762e2580cd7853c058dd03fc32638a73971/src/System.Management.Automation/namespaces/FileSystemSecurity.cs#L130-L200
  # https://github.com/dotnet/runtime/blob/f94898a9b55df07348434e86915c7405962427b6/src/libraries/System.IO.FileSystem.AccessControl/src/System/Security/AccessControl/FileSystemSecurity.cs#L103-L125
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule($rule)
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    [System.IO.File]::SetAccessControl($Path, $acl)
  } else {
    [System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.FileInfo]::new($Path), $acl)
  }
}

# Rollback retains a backup when restoration fails so manual recovery remains
# possible, warning with the preserved path and the action to take — matching
# the Bash installer. The AGENT_SETUP_TEST_FAIL_RESTORE hook, read from the
# ambient environment and never emitted by the gateway, forces the restore
# rename to fail so the harness can assert that guidance.
function Restore-SetupManagedFile {
  param([bool]$Existed, [string]$Backup, [string]$Path, [string]$OriginalLabel, [string]$CreatedLabel)
  if ($Existed) {
    if ($Backup -and (Test-Path -LiteralPath $Backup)) {
      try {
        if ($env:AGENT_SETUP_TEST_FAIL_RESTORE) { throw 'test-injected restore failure' }
        # Secret-bearing backups were already owner-only before any mutation.
        # Moving one back preserves that protection without a second operation
        # that could fail after the backup path has been consumed.
        Move-Item -LiteralPath $Backup -Destination $Path -Force
      } catch {
        Write-SetupWarn "could not restore $Path from its backup; your original $OriginalLabel is preserved at $Backup — restore it by hand."
      }
    }
  } elseif (Test-Path -LiteralPath $Path) {
    try {
      Remove-Item -LiteralPath $Path -Force
    } catch {
      Write-SetupWarn "could not remove the $CreatedLabel this run created at $Path — remove it by hand."
    }
  }
}

function Remove-SetupOlderBackups {
  param([string]$Path, [string]$Keep)
  $directory = Split-Path -Parent $Path
  $prefix = [System.IO.Path]::GetFileName($Path) + '.floway-backup.'
  Get-ChildItem -LiteralPath $directory -File -ErrorAction Stop |
    Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::Ordinal) -and $_.FullName -ne $Keep } |
    Remove-Item -Force -ErrorAction Stop
}

function Merge-SetupProviderExtension {
  param([string]$ExistingPath, [string]$StagePath)
  $stageLines = [System.IO.File]::ReadAllLines($StagePath)
  $connections = @()
  $paths = @($StagePath)
  if (Test-Path -LiteralPath $ExistingPath) { $paths = @($ExistingPath, $StagePath) }
  foreach ($path in $paths) {
    $lines = [System.IO.File]::ReadAllLines($path)
    if ($lines.Length -lt 3 -or $lines[1] -notmatch '^const connections = (.*);$') {
      Stop-Setup "invalid provider configuration in $path"
    }
    $json = $Matches[1]
    if (-not $json.StartsWith('[')) { Stop-Setup "invalid provider configuration in $path" }
    $incoming = @($json | ConvertFrom-Json -ErrorAction Stop)
    if ($incoming.Count -eq 0) { Stop-Setup "empty provider configuration in $path" }
    $ids = @()
    foreach ($connection in $incoming) {
      if ($connection.provider -isnot [string] -or $connection.provider -cnotmatch '^[a-z0-9][a-z0-9._-]{0,63}$' -or
        $connection.endpoint -isnot [string] -or $connection.apiKey -isnot [string] -or $ids -ccontains $connection.provider) {
        Stop-Setup "invalid provider configuration in $path"
      }
      $ids += $connection.provider
      $connections = @($connections | Where-Object { $_.provider -cne $connection.provider }) + $connection
    }
  }
  $header = 'const connections = ' + (ConvertTo-Json -InputObject @($connections) -Depth 10 -Compress) + ';'
  $content = @($stageLines[0], $header) + $stageLines[2..($stageLines.Length - 1)]
  [System.IO.File]::WriteAllText($StagePath, ($content -join "`n") + "`n", (New-Object Text.UTF8Encoding($false)))
  Protect-SetupFile $StagePath
}
