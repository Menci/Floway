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
# `XDG_CONFIG_HOME` even when one is exported. The branch ahead of all of these
# is `--user-data-dir`, which relocates the configuration wholesale; a Zed
# started that way is out of scope here, and the override below is how an
# operator running one points this installer at it.
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
  try { $models = [object[]](ConvertFrom-SetupJsonArray $SetupZedModels) } catch { Stop-Setup 'the embedded Zed model list is not readable.' }
  if ($models.Count -eq 0) { Stop-Setup 'no chat model this gateway serves can be configured for Zed.' }
  $script:ZedModels = $models
}

function Restore-SetupZedSettings {
  Restore-SetupManagedFile $script:ZedSettingsExisted $script:ZedSettingsBackup $script:ZedSettingsPath 'file' 'Zed global settings'
}

# Folds A-Z and nothing else, which is what jq's ascii_downcase does. `-ieq`
# folds Unicode case as well and would call FLOWÄY and flowäy the same name
# where jq calls them different ones — one half then leaves two entries in the
# picker and the other leaves one, from the same rename.
function Test-SetupAsciiCaseEquals {
  param([string]$Left, [string]$Right)
  $fold = {
    param([string]$Value)
    -join ($Value.ToCharArray() | ForEach-Object {
      if ($_ -ge [char]'A' -and $_ -le [char]'Z') { [char]([int]$_ + 32) } else { $_ }
    })
  }
  return [string]::Equals((& $fold $Left), (& $fold $Right), [System.StringComparison]::Ordinal)
}

# Merge the managed provider entry into Zed's global settings: validate the
# existing document, back it up, build and validate the replacement beside it,
# then rename it into place. Only the one provider key is touched; every other
# setting in the file survives.
function Write-SetupZedSettings {
  $script:ZedSettingsPath = Resolve-SetupManagedPath (Join-Path $script:ZedConfigDir 'global_settings.json')
  $script:ZedSettingsBackup = $null
  $script:ZedSettingsExisted = $false

  if (Test-Path -LiteralPath $script:ZedSettingsPath) {
    $script:ZedSettingsExisted = $true
    # The same sentence the Bash half gives, rather than the framework's: a
    # denied read is not something the operator can fix in the document.
    try { $raw = Get-SetupFileText $script:ZedSettingsPath }
    catch { Stop-Setup "$($script:ZedSettingsPath) could not be read; leaving it untouched." }
    # PowerShell 7 accepts JSONC comments and drops them on the way out, while
    # 5.1 errors and jq refuses — three behaviors for one document. A trailing
    # comma splits the halves the same way: ConvertFrom-Json takes it and jq
    # does not. Zed reads this file with serde_json_lenient, so both are the
    # operator's content and silently deleting either is data loss. Refuse, as
    # the Bash half does.
    # Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/settings_content/src/fallible_options.rs#L11-L19
    $verdict = Get-SetupJsonVerdict $raw
    if ($verdict -eq 'jsonc') {
      Stop-Setup "$($script:ZedSettingsPath) carries JSONC syntax this installer cannot preserve; leaving it untouched."
    }
    # Both decoders take a single-quoted string and an unquoted key — measured
    # on 5.1.26100.8875 and pwsh 7.7 — and would write the document back in
    # canonical form where jq refuses it outright. So the verdict decides, not
    # the decoder, and the sentence matches the Bash half's.
    if ($verdict -eq 'invalid') {
      Stop-Setup "$($script:ZedSettingsPath) is not a valid Zed settings document; leaving it untouched."
    }
    # The root is judged from the text before anything is decoded: an empty file
    # reads as $null, and ConvertFrom-Json unwraps a top-level one-element array
    # into a bare object, so neither is distinguishable afterwards.
    if (-not (Test-SetupJsonRoot $raw '{')) { Stop-Setup "$($script:ZedSettingsPath) is not a valid Zed settings document; leaving it untouched." }
    # One message for every way the parse can fail, matching the Bash half: its
    # jq gate cannot say which conjunct refused either, and to the operator a
    # JSON stream and a truncated object are the same instruction — fix the file.
    try { $document = $raw | ConvertFrom-Json } catch { Stop-Setup "$($script:ZedSettingsPath) is not a valid Zed settings document; leaving it untouched." }
    # No root-type check here: the brace root is already established above and
    # every brace-rooted document decodes to PSCustomObject. The Bash half needs
    # its `type == "object"` conjunct because it has no text-level root check.
    #
    # Every shape check completes before the backup exists, so a refusal on
    # the operator's existing document cannot leave an orphan beside it. The
    # mutation that follows the backup runs inside the staging transaction,
    # which removes the backup on any failure.
    # `-contains` and dotted member access are both case-insensitive, while jq's
    # `has` is not — so a differently-cased `Language_Models` would have this
    # half write the provider into the operator's key, which Zed's deserializer
    # never reads, and report success. Refused instead: a configured provider
    # that does not exist is the one outcome worth stopping for.
    $casedKey = $document.PSObject.Properties |
      Where-Object { $_.Name -ieq 'language_models' -and -not [string]::Equals($_.Name, 'language_models', [System.StringComparison]::Ordinal) } |
      Select-Object -First 1
    if ($null -ne $casedKey) {
      Stop-Setup "$($script:ZedSettingsPath) holds a `"$($casedKey.Name)`" key that Zed does not read; rename it to language_models and run this again."
    }
    # The same question one level down: `anthropic_compatible` is reached by the
    # same case-insensitive member access, so a `Anthropic_Compatible` would
    # take the provider into a key Zed never reads while the run reports
    # success — the staged check cannot see it either, because it reads back
    # through the same access.
    if ($document.PSObject.Properties.Name -contains 'language_models' -and
        $document.language_models -is [System.Management.Automation.PSCustomObject]) {
      $casedInner = $document.language_models.PSObject.Properties |
        Where-Object { $_.Name -ieq 'anthropic_compatible' -and -not [string]::Equals($_.Name, 'anthropic_compatible', [System.StringComparison]::Ordinal) } |
        Select-Object -First 1
      if ($null -ne $casedInner) {
        Stop-Setup "$($script:ZedSettingsPath) holds a `"$($casedInner.Name)`" key that Zed does not read; rename it to anthropic_compatible and run this again."
      }
    }
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
      Backup-SetupManagedFile $script:ZedSettingsPath $script:ZedSettingsBackup
    } catch {
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
      if (Test-SetupAsciiCaseEquals $existing $SetupZedProviderName) { $bag.PSObject.Properties.Remove($existing) }
    }
    # What survives the fold above and still collides is a name differing only
    # outside ASCII. A property bag is Unicode case-insensitive and cannot hold
    # both, so this document is one PowerShell cannot express — jq writes it
    # without complaint. Refuse rather than remove someone else's provider to
    # make room, and say which name is in the way.
    $collision = @($bag.PSObject.Properties.Name) | Where-Object { $_ -ieq $SetupZedProviderName } | Select-Object -First 1
    if ($null -ne $collision) {
      Stop-Setup "$($script:ZedSettingsPath) already holds a provider named `"$collision`", which PowerShell cannot keep beside `"$SetupZedProviderName`"; rename one of them and run this again."
    }
    # A property bag refuses two families of name outright: members the object
    # already has (PSObject, PSBase, PSTypeNames, ToString, Equals, GetType,
    # GetHashCode), and the name or decimal value of a member type Add-Member
    # can create — AliasProperty, CodeProperty, NoteProperty, ScriptProperty,
    # PropertySet, CodeMethod, ScriptMethod, MemberSet, and 1, 2, 8, 16, 32,
    # 128, 256, 1024. Everything else goes through: "3", "4", "64", "2024",
    # Count, Length, `a.b`, `a b`. Measured identical on 5.1.26100.8875 and
    # pwsh 7.6. The Bash half writes every one of them, so this is a PowerShell
    # limit rather than a rule of ours, and the raw Add-Member message names
    # none of what the operator can do about it.
    try {
      $bag | Add-Member -NotePropertyName $SetupZedProviderName -NotePropertyValue ([PSCustomObject]@{
        api_url = Get-SetupZedApiUrl
        available_models = $script:ZedModels
      })
    } catch {
      Stop-Setup "PowerShell cannot use `"$SetupZedProviderName`" as a provider name; it is either a member this object already has or the name or number of a PowerShell member type. Choose another name and run this again."
    }

    # A subtree deeper than the serializer goes is emitted as the literal string
    # "@{k=}" with only a warning, which the staged check cannot see because it
    # inspects the provider entry alone. Promote it: losing an unrelated setting
    # is not something to do quietly.
    #
    # The promotion is a pwsh 7 guarantee only. Windows PowerShell 5.1 emits no
    # warning at all for the same input — measured: a 120-deep object at
    # -Depth 100 writes the truncated literal silently — so what stands between
    # such a document and a rewrite there is ConvertFrom-Json's own recursion
    # limit, measured to accept 101 levels and refuse 102. A document nested
    # exactly 101 deep therefore parses and is then truncated silently; no
    # settings file reaches that, but the bound is one level wider than the
    # serializer's.
    $json = $document | ConvertTo-Json -Depth 100 -WarningAction Stop
    [System.IO.File]::WriteAllText($stage, $json, (New-Object System.Text.UTF8Encoding($false)))
    # Owner-only before the mode carry-over below, because that step leaves the
    # mode alone when neither stat dialect answers — and "alone" here means the
    # inherited umask, which is wider than the Bash half's stage. Widening the
    # file is what the carry-over exists to prevent.
    if (-not (Test-SetupIsWindows)) { & chmod 600 $stage }
    $check = Get-SetupFileText $stage | ConvertFrom-Json
    # Read through the property bag rather than with `.$name`, which is dotted
    # member access over an operator-chosen string.
    $staged = $check.language_models.anthropic_compatible.PSObject.Properties[$SetupZedProviderName].Value
    # The exact count, not merely a non-empty list: a model array that reached
    # the document nested one level deep — which is what an unenumerated
    # ConvertFrom-Json produces on Windows PowerShell 5.1 — has a count of 1 and
    # would pass an emptiness check while Zed reads an object where its schema
    # requires a list and drops the provider entirely.
    if (($staged.api_url -cne (Get-SetupZedApiUrl)) -or (@($staged.available_models).Count -ne $script:ZedModels.Count)) {
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
        # GNU stat takes -c, BSD takes -f. Neither answering leaves the mode
        # alone rather than guessing one, as _stat_mode does.
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
    #
    # Measured on Windows PowerShell 5.1.26100.8875: the destination's ACL comes
    # through the replace byte-identical (same SDDL), which is why nothing
    # re-applies it afterwards, and passing `$null` for the backup path really
    # does fail with "The path is not of a legal form" where NullString does
    # not. This branch never runs under the Unix harness.
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
# it — which rules out `cmdkey`, whose blob is UTF-16LE. The C# that does the
# write is in common/zed-credential.ps1, shared with the dashboard's snippet.
# Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/gpui_windows/src/util.rs#L89-L91

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

# macOS keeps it as an internet password, where Zed's `url` is the server and
# its username the account — exactly what `-s` and `-a` set.
# Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/gpui_macos/src/platform.rs#L1151-L1170
#
# `-T` grants a bundle access without the authorization prompt a later read
# would raise, and a path that does not exist fails the whole call — so only
# bundles found on this host are named, across every channel and both install
# locations. The key is unavoidably an argv element for the duration of the
# call: security takes the password only via -w/-X, and bare -w prompts on the
# tty rather than reading stdin, which a piped installer cannot answer.
function Set-SetupZedCredentialMacOS {
  if (-not (Get-Command security -ErrorAction SilentlyContinue)) {
    Stop-Setup 'the `security` command is unavailable; cannot store the API key.'
  }
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
