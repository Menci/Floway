# The file a managed path ultimately names. chezmoi and stow both place a
# symlink where an editor expects its document, and replacing that path with a
# staged file replaces the link itself: the operator's dotfile silently stops
# being what the editor reads, and their next change there has no effect.
# Resolving up front keeps the write, the backup, the mode, and the backup prune
# all acting on the real document. Mirrors _resolve_managed_path.
#
# `Get-Item -Force` rather than ResolveLinkTarget, which arrived in .NET 6 and
# is therefore missing on pwsh 7.0-7.1; the hop loop this needs anyway also
# bounds a link cycle, which the framework call would raise on.
function Resolve-SetupManagedPath {
  param([string]$Path)
  for ($hops = 0; $hops -lt 40; $hops++) {
    # LinkType, not merely a non-empty Target: on the Windows PowerShell 5.1
    # build Target also enumerates a file's hard-link names, so a document with
    # a second hard link would resolve to itself until the hop bound tripped and
    # the run stopped with nothing configured. Bash asks `[ -L ]`, which is the
    # same question.
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -or $item.LinkType -ne 'SymbolicLink') { return $Path }
    $target = @($item.Target)[0]
    # Canonicalized on both branches, not just the relative one: the prune
    # compares against Get-ChildItem's own canonical FullName, so a target
    # written with a `..` segment — which is how a dotfile manager may well
    # write it — would match nothing there and take the backup meant to be
    # kept. The prune canonicalizes its keep-path too, so either alone closes
    # that; the pair is what the symlink test observes, and each stands for a
    # reason of its own — this one so every downstream use of the path, the
    # reported one included, is the canonical form.
    #
    # Refs: the `..` leg of `writes through a symlinked settings file`.
    $Path = [System.IO.Path]::GetFullPath(
      $(if ([System.IO.Path]::IsPathRooted($target)) { $target } else { Join-Path (Split-Path -Parent $Path) $target }))
  }
  Stop-Setup "$Path does not resolve to a file: too many symlink hops."
}

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
  #
  # Measured on Windows PowerShell 5.1.26100.8875: the file comes back with
  # inheritance blocked and exactly one rule, for the running user. The harness
  # runs on Unix, where this branch never executes, so that is the only
  # observation of it there is.
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

# A directory under the backup prefix is refused rather than removed or skipped.
# This installer only ever creates files there, so a directory is a state nobody
# here produced and removing it recursively could take something of the
# operator's along. `-File` would have skipped it and reported success, while
# the Bash half's `rm -f` fails on it — one run's outcome must not depend on
# which half served it.
#
# The question is link-ness, not which wrapper .NET chose: a symlink pointing at
# a directory arrives as DirectoryInfo and is unlinked rather than refused,
# which is what `rm -f` does with it on the other half.
function Remove-SetupOlderBackups {
  param([string]$Path, [string]$Keep)
  $directory = Split-Path -Parent $Path
  $prefix = [System.IO.Path]::GetFileName($Path) + '.floway-backup.'
  # Empty when this run made no backup, and GetFullPath rejects an empty path.
  $keepFull = if ([string]::IsNullOrEmpty($Keep)) { $Keep } else { [System.IO.Path]::GetFullPath($Keep) }
  Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop |
    Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::Ordinal) -and $_.FullName -ne $keepFull } |
    ForEach-Object {
      if ($_ -is [System.IO.DirectoryInfo] -and $null -eq $_.LinkType) {
        throw "could not remove obsolete backup $($_.FullName)"
      }
      if ($_ -is [System.IO.DirectoryInfo]) {
        # A symlink to a directory. `Remove-Item -Force` unlinks it on pwsh 7
        # but on Windows PowerShell 5.1 it asks for confirmation regardless —
        # measured: the call blocks, which in an `irm | iex` console is a prompt
        # nobody expects mid-install and in a non-interactive host is a hang.
        # Directory.Delete with recurse:$false unlinks on both and leaves what
        # the link pointed at alone.
        [System.IO.Directory]::Delete($_.FullName, $false)
      } else {
        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
      }
    }
}
