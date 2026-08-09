# Zed Agent Setup fragment.

# Zed is configured, not installed: the editor ships outside any package manager
# this script could drive, so an absent configuration directory is a hard stop.
#
# The managed document is `global_settings.json`, a settings layer Zed reads
# below the user's own `settings.json`. Zed never creates it and never writes to
# it, so a third party can own the file outright — which also keeps this
# fragment on plain JSON. Editing `settings.json` would mean parsing JSONC, and
# `ConvertFrom-Json` cannot: it errors on comments under Windows PowerShell 5.1,
# and on 7.0-7.5 it silently turns a comment inside an array into a string
# element.
# Refs: https://github.com/zed-industries/zed/pull/30444
#       https://github.com/PowerShell/PowerShell/issues/14553

# Zed appends `/v1/messages` itself, so the provider takes the bare origin —
# unlike `openai_compatible`, whose api_url carries the version segment.
function Get-SetupZedApiUrl { $SetupEndpoint }

# Every release channel shares one configuration directory: `config_dir()` has
# no channel branching, so a single file serves Stable, Preview and Nightly.
# XDG is consulted on Linux and FreeBSD only — macOS falls through to an
# unconditional `~/.config`, never `~/Library/Application Support`, and never
# `XDG_CONFIG_HOME` even when one is exported.
# Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/paths/src/paths.rs#L121-L141
function Get-SetupZedConfigDir {
  if ($env:AGENT_SETUP_TEST_ZED_CONFIG_DIR) { return $env:AGENT_SETUP_TEST_ZED_CONFIG_DIR }
  if (Test-SetupIsWindows) { return (Join-Path $env:APPDATA 'Zed') }
  if ((Get-SetupPlatform) -eq 'linux') {
    if ($env:FLATPAK_XDG_CONFIG_HOME) { return (Join-Path $env:FLATPAK_XDG_CONFIG_HOME 'zed') }
    if ($env:XDG_CONFIG_HOME) { return (Join-Path $env:XDG_CONFIG_HOME 'zed') }
  }
  Join-Path $HOME '.config/zed'
}

function Assert-SetupZedConfigDir {
  $script:ZedConfigDir = Get-SetupZedConfigDir
  if (-not (Test-Path -LiteralPath $script:ZedConfigDir -PathType Container)) {
    Stop-Setup "no Zed configuration directory at $($script:ZedConfigDir); install and launch Zed once, then re-run this command."
  }
  Write-SetupInfo "Zed configuration directory: $($script:ZedConfigDir)"
}

# Zed's `anthropic_compatible` provider has no model-discovery path — its
# `available_models` is a required array — so the gateway projects the catalog
# and embeds it in this script. Decoding it is the only shaping left here: one
# projection on the gateway cannot disagree with the Bash half the way two
# hand-written ones did.
function Get-SetupZedModels {
  try { $models = @($SetupZedModels | ConvertFrom-Json) } catch { Stop-Setup 'the embedded Zed model list is not readable.' }
  if ($models.Count -eq 0) { Stop-Setup 'the gateway advertises no chat models; nothing to configure.' }
  $script:ZedModels = $models
}

function Restore-SetupZedSettings {
  Restore-SetupManagedFile $script:ZedSettingsExisted $script:ZedSettingsBackup $script:ZedSettingsPath 'file' 'Zed global settings'
}

# Merge the managed provider entry into Zed's global settings: validate the
# existing document, back it up, build and validate the replacement beside it,
# then rename it into place. Only the one provider key is touched; every other
# setting in the file survives.
function Write-SetupZedSettings {
  $script:ZedSettingsPath = Join-Path $script:ZedConfigDir 'global_settings.json'
  $script:ZedSettingsBackup = $null
  $script:ZedSettingsExisted = $false

  if (Test-Path -LiteralPath $script:ZedSettingsPath) {
    $script:ZedSettingsExisted = $true
    $raw = Get-Content -Raw -LiteralPath $script:ZedSettingsPath
    # PowerShell 7 accepts JSONC comments and drops them on the way out, while
    # 5.1 errors and jq refuses — three behaviors for one document. Zed reads
    # this file with serde_json_lenient, so a comment is the operator's content
    # and silently deleting it is data loss. Refuse, as the Bash half does.
    # Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/settings_content/src/fallible_options.rs#L11-L19
    if (Test-SetupJsonHasComment $raw) {
      Stop-Setup "$($script:ZedSettingsPath) carries JSONC comments this installer cannot preserve; leaving it untouched."
    }
    # The root is judged from the text before anything is decoded: an empty file
    # reads as $null, and ConvertFrom-Json unwraps a top-level one-element array
    # into a bare object, so neither is distinguishable afterwards.
    if (-not (Test-SetupJsonRoot $raw '{')) { Stop-Setup "$($script:ZedSettingsPath) is not a valid JSON object; leaving it untouched." }
    try { $document = $raw | ConvertFrom-Json } catch { Stop-Setup "$($script:ZedSettingsPath) is not valid JSON; leaving it untouched." }
    # Every shape check completes before the backup exists, so a refusal on
    # the operator's existing document cannot leave an orphan beside it. The
    # mutation that follows the backup runs inside the staging transaction,
    # which removes the backup on any failure.
    if ($document -isnot [System.Management.Automation.PSCustomObject]) { Stop-Setup 'existing Zed global settings root is not a JSON object.' }
    if ($document.PSObject.Properties.Name -contains 'language_models') {
      if ($document.language_models -isnot [System.Management.Automation.PSCustomObject]) {
        Stop-Setup 'existing Zed language_models is not a JSON object.'
      }
      if (($document.language_models.PSObject.Properties.Name -contains 'anthropic_compatible') -and
          ($document.language_models.anthropic_compatible -isnot [System.Management.Automation.PSCustomObject])) {
        Stop-Setup 'existing Zed anthropic_compatible is not a JSON object.'
      }
    }
    $stamp = [long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds
    $script:ZedSettingsBackup = "$($script:ZedSettingsPath).floway-backup.$stamp.$PID"
    try {
      Copy-Item -LiteralPath $script:ZedSettingsPath -Destination $script:ZedSettingsBackup
    } catch {
      if (Test-Path -LiteralPath $script:ZedSettingsBackup) { Remove-Item -LiteralPath $script:ZedSettingsBackup -Force }
      $script:ZedSettingsBackup = $null
      Stop-Setup "could not back up $($script:ZedSettingsPath)"
    }
  } else {
    $document = [PSCustomObject]@{}
  }

  $stage = "$($script:ZedSettingsPath).floway-stage.$PID"
  try {
    # Inside the transaction: a provider name PowerShell reserves on every
    # object — PSObject, PSBase, PSTypeNames — makes Add-Member throw, and the
    # schema accepts those names because Zed treats the key as opaque text. A
    # throw out here would otherwise leave the backup beside the operator's
    # settings forever.
    if ($document.PSObject.Properties.Name -notcontains 'language_models') {
      $document | Add-Member -NotePropertyName language_models -NotePropertyValue ([PSCustomObject]@{})
    }
    if ($document.language_models.PSObject.Properties.Name -notcontains 'anthropic_compatible') {
      $document.language_models | Add-Member -NotePropertyName anthropic_compatible -NotePropertyValue ([PSCustomObject]@{})
    }
    # Remove any key differing from the chosen name only by case before adding
    # it, rather than assigning through Set-SetupProp: that helper finds the
    # existing key case-insensitively and would write the new value under the
    # OLD name, leaving the picker showing a name the operator did not choose.
    # Removing and re-adding also puts the entry last, as the jq merge does.
    $bag = $document.language_models.anthropic_compatible
    foreach ($existing in @($bag.PSObject.Properties.Name)) {
      if ($existing -ieq $SetupZedProviderName) { $bag.PSObject.Properties.Remove($existing) }
    }
    $bag | Add-Member -NotePropertyName $SetupZedProviderName -NotePropertyValue ([PSCustomObject]@{
      api_url = Get-SetupZedApiUrl
      available_models = $script:ZedModels
    })

    # A subtree deeper than the serializer goes is emitted as the literal string
    # "@{k=}" with only a warning, which the staged check cannot see because it
    # inspects the provider entry alone. Promote it: losing an unrelated setting
    # is not something to do quietly.
    $json = $document | ConvertTo-Json -Depth 100 -WarningAction Stop
    [System.IO.File]::WriteAllText($stage, $json, (New-Object System.Text.UTF8Encoding($false)))
    $check = Get-Content -Raw -LiteralPath $stage | ConvertFrom-Json
    # Read through the property bag rather than with `.$name`, which is dotted
    # member access over an operator-chosen string.
    $staged = $check.language_models.anthropic_compatible.PSObject.Properties[$SetupZedProviderName].Value
    if (($staged.api_url -cne (Get-SetupZedApiUrl)) -or (@($staged.available_models).Count -eq 0)) {
      Stop-Setup 'staged Zed global settings failed validation.'
    }
    # This document holds no credential — Zed reads the key from the keychain —
    # so the replacement carries the mode of the file it replaces rather than
    # the process umask, matching the Bash half. Windows needs nothing here:
    # File.Replace preserves the destination ACL.
    # Through chmod rather than [File]::SetUnixFileMode, which arrived in
    # .NET 8 and is therefore missing on pwsh 7.0-7.2 — a MethodNotFound there
    # would abort the run after the credential had already been stored, leaving
    # an orphan keychain entry and no provider. Every other permission change in
    # this installer set goes through chmod for the same reason.
    if (-not (Test-SetupIsWindows)) {
      if ($script:ZedSettingsExisted) {
        # `--reference` is GNU-only; BSD chmod takes the mode itself.
        # GNU stat takes -c, BSD takes -f; neither answering leaves the mode
        # alone rather than guessing one, as the Bash helper does.
        $mode = & stat -c '%a' $script:ZedSettingsPath 2>$null
        if (-not $mode) { $mode = & stat -f '%Lp' $script:ZedSettingsPath 2>$null }
        if ($mode) { & chmod $mode $stage }
      } else {
        # A file we create is ours to set: owner-only, matching the Bash half,
        # which writes it under the installer's own `umask 077`.
        & chmod 600 $stage
      }
    }
    # Move-Item -Force is delete-then-create on Windows, which would briefly
    # unlink a settings file Zed is watching; File.Replace is atomic.
    if ($script:ZedSettingsExisted -and (Test-SetupIsWindows)) {
      [System.IO.File]::Replace($stage, $script:ZedSettingsPath, [System.Management.Automation.Language.NullString]::Value)
    } else {
      Move-Item -LiteralPath $stage -Destination $script:ZedSettingsPath -Force
    }
    Remove-SetupOlderBackups -Path $script:ZedSettingsPath -Keep $script:ZedSettingsBackup
  } catch {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force }
    Restore-SetupZedSettings
    throw
  }
  Write-SetupInfo "Configured $($script:ZedModels.Count) model(s) as provider `"$SetupZedProviderName`"."
}

# The API key is not a setting: Zed reads it from the OS credential store,
# indexed by the provider's `api_url` under the fixed username "Bearer". Zed
# offers no CLI, so the store is written directly.
#
# Windows keeps it as a generic credential whose target name Zed builds as
# "zed:url=" + api_url. The blob must be UTF-8 — Zed runs `str::from_utf8` over
# it — which rules out `cmdkey`, whose blob is UTF-16LE.
$SetupZedCredWriteSource = @'
using System;
using System.Runtime.InteropServices;

public static class FlowayZedCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);

  public static void Write(string targetName, string userName, byte[] secret) {
    IntPtr blob = Marshal.AllocHGlobal(secret.Length);
    try {
      Marshal.Copy(secret, 0, blob, secret.Length);
      CREDENTIAL credential = new CREDENTIAL();
      credential.Type = 1;              // CRED_TYPE_GENERIC
      credential.TargetName = targetName;
      credential.CredentialBlobSize = (uint)secret.Length;
      credential.CredentialBlob = blob;
      credential.Persist = 2;           // CRED_PERSIST_LOCAL_MACHINE
      credential.UserName = userName;
      if (!CredWriteW(ref credential, 0)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
    } finally {
      for (int i = 0; i < secret.Length; i++) { Marshal.WriteByte(blob, i, 0); }
      Marshal.FreeHGlobal(blob);
    }
  }
}
'@

function Set-SetupZedCredentialWindows {
  # Add-Type accepts a byte-identical re-add by returning its cached type and
  # rejects any source that differs under a name already in the AppDomain. The
  # guard makes a re-run in the same console a no-op outright rather than
  # resting on that cache.
  if (-not ('FlowayZedCredential' -as [type])) {
    Add-Type -TypeDefinition $SetupZedCredWriteSource
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($SetupApiKey)
  try {
    [FlowayZedCredential]::Write("zed:url=$(Get-SetupZedApiUrl)", 'Bearer', $bytes)
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

# Zed's lookup searches on `url` alone and then returns the first item whose
# label matches this literal, so the label is fixed rather than derived from the
# provider name.
# Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/gpui_linux/src/linux/platform.rs#L677-L681
#      https://github.com/zed-industries/zed/issues/43671
function Set-SetupZedCredentialSecretService {
  if (-not (Get-Command secret-tool -ErrorAction SilentlyContinue)) {
    Stop-Setup 'secret-tool is unavailable; install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch) and re-run.'
  }
  # Written through a redirected stdin rather than a pipeline: PowerShell
  # terminates a piped object with a newline, and secret-tool stores every byte
  # it reads, so the key would come back with a trailing \n and Zed would send a
  # malformed Authorization header.
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = 'secret-tool'
  foreach ($argument in @('store', '--label=zed-github-account', 'url', (Get-SetupZedApiUrl), 'username', 'Bearer')) {
    $startInfo.ArgumentList.Add($argument)
  }
  $startInfo.RedirectStandardInput = $true
  $startInfo.UseShellExecute = $false
  $process = [System.Diagnostics.Process]::Start($startInfo)
  try {
    $process.StandardInput.Write($SetupApiKey)
    $process.StandardInput.Close()
    $process.WaitForExit()
    $exitCode = $process.ExitCode
  } finally {
    $process.Dispose()
  }
  if ($exitCode -ne 0) { Stop-Setup 'secret-tool could not store the API key.' }
}

# `-T` grants a bundle access without the authorization prompt a later read
# would raise, and a path that does not exist fails the whole call — so only
# bundles found on this host are named, across every channel and both install
# locations. The key is unavoidably an argv element for the duration of the
# call: security takes the password only via -w/-X, and bare -w prompts on the
# tty rather than reading stdin, which a piped installer cannot answer.
function Set-SetupZedCredentialMacOS {
  $arguments = @('add-internet-password', '-s', (Get-SetupZedApiUrl), '-a', 'Bearer', '-U', '-w', $SetupApiKey)
  foreach ($bundle in @(
      '/Applications/Zed.app', (Join-Path $HOME 'Applications/Zed.app'),
      '/Applications/Zed Preview.app', (Join-Path $HOME 'Applications/Zed Preview.app'),
      '/Applications/Zed Nightly.app', (Join-Path $HOME 'Applications/Zed Nightly.app'))) {
    if (Test-Path -LiteralPath $bundle -PathType Container) { $arguments += @('-T', $bundle) }
  }
  & security @arguments
  if ($LASTEXITCODE -ne 0) { Stop-Setup 'the security command could not store the API key.' }
}

function Set-SetupZedCredential {
  switch (Get-SetupPlatform) {
    'windows' { Set-SetupZedCredentialWindows }
    'macos' { Set-SetupZedCredentialMacOS }
    default { Set-SetupZedCredentialSecretService }
  }
}

# The credential is stored before the settings document so a failure leaves an
# unreferenced credential rather than a registered provider Zed reports as
# unauthenticated — without a key `is_authenticated()` is false and every model
# vanishes from the picker with no error shown.
function Set-SetupAgent {
  Write-SetupAgentNotice 'Configuring' 'Zed'
  Assert-SetupZedConfigDir
  Get-SetupZedModels
  Set-SetupZedCredential
  Write-SetupZedSettings
  Write-SetupInfo "Written to ``$($script:ZedSettingsPath)``."
  Write-SetupInfo 'Restart Zed if it is running.'
  Write-SetupAgentNotice 'Completed Agent Setup' 'Zed'
}


$global:LASTEXITCODE = Main 'Zed'
