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
# the Bash installer.
function Restore-SetupManagedFile {
  param([bool]$Existed, [string]$Backup, [string]$Path, [string]$OriginalLabel, [string]$CreatedLabel)
  if ($Existed) {
    if (-not $Backup -or (-not (Test-Path -LiteralPath $Backup))) {
      Write-SetupWarn "rollback failed for $Path because its expected $OriginalLabel backup is missing."
      return $false
    }
    try {
      # Secret-bearing backups were already owner-only before any mutation.
      # Moving one back preserves that protection without a second operation
      # that could fail after the backup path has been consumed.
      Move-Item -LiteralPath $Backup -Destination $Path -Force
      return $true
    } catch {
      Write-SetupWarn "could not restore $Path from its backup; your original $OriginalLabel is preserved at $Backup — restore it by hand."
      return $false
    }
  } elseif (Test-Path -LiteralPath $Path) {
    try {
      Remove-Item -LiteralPath $Path -Force
      return $true
    } catch {
      Write-SetupWarn "could not remove the $CreatedLabel this run created at $Path — remove it by hand."
      return $false
    }
  }
  return $true
}

function Remove-SetupOlderBackups {
  param([string]$Path, [string]$Keep)
  $directory = Split-Path -Parent $Path
  $prefix = [System.IO.Path]::GetFileName($Path) + '.floway-backup.'
  Get-ChildItem -LiteralPath $directory -File -ErrorAction Stop |
    Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::Ordinal) -and $_.FullName -ne $Keep } |
    Remove-Item -Force -ErrorAction Stop
}
