# VS Code Agent Setup fragment.

# VS Code is configured, not installed: the editor ships outside any package
# manager this script drives, so an absent user directory is a hard stop.
#
# The managed document is `chatLanguageModels.json`, which the bundled Copilot
# extension's `customendpoint` vendor reads. It sits beside `settings.json` in
# the profile directory and holds a top-level array of provider groups; VS Code
# rewrites the whole file whenever the Manage Models UI changes anything, so
# comments in it are already volatile and a whole-document rewrite costs
# nothing. Groups are keyed by `${vendor}:${name}`, so ours replaces only its own.
# Refs: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/platform/userDataProfile/common/userDataProfile.ts#L204
#       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/workbench/contrib/chat/browser/languageModelsConfigurationService.ts#L390-L417
#       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/workbench/contrib/chat/browser/languageModelsConfigurationService.ts#L73-L76
#       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/workbench/contrib/chat/browser/languageModelsConfigurationService.ts#L215-L238

# `customendpoint` appends the API path itself, so the group takes the bare
# origin plus a version segment: a URL already ending in `/vN` gets the path
# appended to it, while a bare host would have `/v1` inserted. A URL already
# carrying `/responses`, `/chat/completions`, or `/messages` anywhere in it is
# treated as fully resolved, which is why nothing here appends one.
# Ref: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/extension/byok/vscode-node/customEndpointProvider.ts#L22-L59
function Get-SetupVSCodeApiUrl { "$SetupEndpoint/v1" }

# The stable, Insiders, and VSCodium builds keep separate user directories, and
# an operator may run more than one. Every one that exists is configured, so a
# single run serves whichever build the operator actually opens. An override is
# held to the same existence check, so a wrong path reports rather than failing
# later against a directory nothing can be written to.
function Get-SetupVSCodeUserDirs {
  if ($env:AGENT_SETUP_TEST_VSCODE_USER_DIR) {
    # Newline-separated, matching the Bash half: the real enumeration yields
    # several directories, so an override that could only name one could not
    # stand in for an operator running more than one build.
    return @($env:AGENT_SETUP_TEST_VSCODE_USER_DIR -split "`n" | Where-Object { $_ } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Container })
  }
  $base = if (Test-SetupIsWindows) { $env:APPDATA }
    elseif ($IsMacOS) { Join-Path $HOME 'Library/Application Support' }
    elseif ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME }
    else { Join-Path $HOME '.config' }
  @('Code', 'Code - Insiders', 'VSCodium') |
    ForEach-Object { Join-Path (Join-Path $base $_) 'User' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Container }
}

# A named profile keeps its own copy of the file under an opaque directory, so
# every profile of every build is configured rather than only the default one.
# The id is a hash rather than the display name, so the directories are
# enumerated instead of derived.
function Get-SetupVSCodeProfileDirs {
  param([string]$UserDir)
  $dirs = @($UserDir)
  $profiles = Join-Path $UserDir 'profiles'
  if (Test-Path -LiteralPath $profiles -PathType Container) {
    try {
      $dirs += Get-ChildItem -LiteralPath $profiles -Directory -ErrorAction Stop | ForEach-Object { $_.FullName }
    } catch {
      # The named profiles are lost, not the build: the default profile sits
      # beside this directory and is configured either way, which is what the
      # Bash glob does when it cannot read `profiles/`.
      Write-SetupWarn "could not list profiles under ${profiles}: $(Protect-SetupSecret ([string]$_.Exception.Message))"
    }
  }
  $dirs
}

# `customendpoint` reads only `id` off a `/models` response and drops every
# model it cannot type — no known-models table, no capability resolver — and a
# group-level `url` short-circuits into that discovery branch while suppressing
# the explicit `models` list, leaving the provider empty. So the gateway
# projects the catalog and embeds it here instead. Decoding it and attaching
# the endpoint and credential is the only shaping left: one projection on the
# gateway cannot disagree with the Bash half the way two hand-written ones did.
#
# The key rides in `requestHeaders` rather than the group's `apiKey`: that
# property is declared `secret`, so VS Code runs its `${input:...}` decoder over
# whatever it finds there and a literal decodes to a secret-storage miss.
# `requestHeaders` survives the header sanitizer because `customendpoint`
# un-reserves `authorization` for endpoints behind gateways, and supplying it
# suppresses the default inferred auth header.
# Refs: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/extension/byok/vscode-node/abstractLanguageModelChatProvider.ts#L145-L163
#       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/package.json#L2010-L2016
#       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/extension/byok/vscode-node/customEndpointProvider.ts#L185-L212
function Get-SetupVSCodeModels {
  try { $models = @(ConvertFrom-SetupJsonArray $SetupVSCodeModels) } catch { Stop-Setup 'the embedded VS Code model list is not readable.' }
  if ($models.Count -eq 0) { Stop-Setup 'the gateway advertises no chat models; nothing to configure.' }
  $apiUrl = Get-SetupVSCodeApiUrl
  foreach ($model in $models) {
    $model | Add-Member -NotePropertyName 'url' -NotePropertyValue $apiUrl -Force
    $model | Add-Member -NotePropertyName 'requestHeaders' -NotePropertyValue ([ordered]@{ authorization = "Bearer $SetupApiKey" }) -Force
  }
  $script:VSCodeModels = $models
}

# Is this entry the group this run owns? jq compares strings by code point and
# answers false for anything that is not a string, and this has to answer the
# same — a group the two halves disagree about is one half deleting a gateway
# the other keeps. Stated once because it is asked twice: when filtering the
# operator's list, and when validating what was staged.
#
# `[string]::Equals` with Ordinal rather than `-ceq`, which is case-sensitive
# but still culture-aware: it reports "Floway" and a "Floway" carrying a soft
# hyphen, a zero-width space, or an NFD accent as equal, because ICU gives
# those no collation weight. jq sees different strings, and the disagreement
# costs a foreign gateway its group.
#
# The type is still asked separately: overload resolution converts a
# single-element array to its element's string form before comparing, so
# `["customendpoint"]` would match without it — the same case `-ceq` failed
# by being a filter whose non-empty result is truthy.
function Test-SetupVSCodeOwnGroup {
  param($Group)
  return ($Group.vendor -is [string]) -and ($Group.name -is [string]) -and
         [string]::Equals($Group.vendor, 'customendpoint', [System.StringComparison]::Ordinal) -and
         [string]::Equals($Group.name, $SetupVSCodeProviderName, [System.StringComparison]::Ordinal)
}

function Restore-SetupVSCodeSettings {
  Restore-SetupManagedFile $script:VSCodeSettingsExisted $script:VSCodeSettingsBackup $script:VSCodeSettingsPath 'file' 'VS Code language models'
}

# Replace this gateway's group in one profile's provider list, leaving every
# other group — including other `customendpoint` gateways — untouched.
function Write-SetupVSCodeSettings {
  param([string]$ProfileDir)
  $script:VSCodeSettingsPath = Resolve-SetupManagedPath (Join-Path $ProfileDir 'chatLanguageModels.json')
  $script:VSCodeSettingsBackup = $null
  $script:VSCodeSettingsExisted = $false

  $groups = @()
  if (Test-Path -LiteralPath $script:VSCodeSettingsPath) {
    $script:VSCodeSettingsExisted = $true
    $raw = Get-SetupFileText $script:VSCodeSettingsPath
    # The root shape is decided from the text, not from what ConvertFrom-Json
    # returned: it unwraps a one-element array into a bare object and decodes
    # `[]` to $null, so the decoded value cannot tell an array from an object.
    # jq, which the Bash installer asks the same question, reads the text.
    # Get-Content -Raw yields $null for an empty file, which is not a list
    # either — and dereferencing it would report a PowerShell internal instead.
    # Unlike Zed's document, a comment here is not the operator's to keep: VS
    # Code rewrites this whole file through `model.setValue(JSON.stringify(…))`
    # whenever Manage Models changes anything, so its own next edit deletes the
    # comment too. The refusal exists because jq has no JSONC mode and the Bash
    # half therefore cannot accept such a file — and the two halves have to give
    # one answer, rather than pwsh silently dropping what jq refuses.
    # A trailing comma splits the halves the same way and for the same reason:
    # VS Code parses this document with `allowTrailingComma`, ConvertFrom-Json
    # takes one, and jq does not.
    # Refs: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/workbench/contrib/chat/browser/languageModelsConfigurationService.ts#L232
    #       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/base/common/json.ts#L144-L148
    $verdict = Get-SetupJsonVerdict $raw
    if ($verdict -eq 'jsonc') {
      Stop-Setup "$($script:VSCodeSettingsPath) carries JSONC syntax this installer cannot preserve; leaving it untouched."
    }
    # Newtonsoft would take a single-quoted string or an unquoted key and write
    # the document back in canonical form where jq refuses it outright, so the
    # verdict decides rather than the decoder.
    if ($verdict -eq 'invalid') {
      Stop-Setup "$($script:VSCodeSettingsPath) is not a provider list; leaving it untouched."
    }
    if (-not (Test-SetupJsonRoot $raw '[')) {
      Stop-Setup "$($script:VSCodeSettingsPath) is not a provider list; leaving it untouched."
    }
    try { $parsed = @(ConvertFrom-SetupJsonArray $raw) } catch { Stop-Setup "$($script:VSCodeSettingsPath) is not valid JSON; leaving it untouched." }
    # Every element must be an object, matching the Bash gate: jq's merge
    # indexes `.vendor` on each one and aborts on a scalar, so without this the
    # same document would be rewritten here and refused there.
    if (@($parsed | Where-Object { $_ -isnot [System.Management.Automation.PSCustomObject] }).Count -gt 0) {
      Stop-Setup "$($script:VSCodeSettingsPath) is not a provider list; leaving it untouched."
    }
    $groups = @($parsed | Where-Object { -not (Test-SetupVSCodeOwnGroup $_) })

    $stamp = [long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds
    $script:VSCodeSettingsBackup = "$($script:VSCodeSettingsPath).floway-backup.$stamp.$PID"
    try {
      Copy-Item -LiteralPath $script:VSCodeSettingsPath -Destination $script:VSCodeSettingsBackup
      Protect-SetupFile $script:VSCodeSettingsBackup
    } catch {
      if (Test-Path -LiteralPath $script:VSCodeSettingsBackup) { Remove-Item -LiteralPath $script:VSCodeSettingsBackup -Force }
      $script:VSCodeSettingsBackup = $null
      # Named here so the per-profile catch counts it rather than describing a
      # raw .NET message, matching the Bash half's "could not back up".
      if ([string]::Equals($_.Exception.Message, 'setup-handled', [System.StringComparison]::Ordinal)) { throw }
      Stop-Setup "could not back up $($script:VSCodeSettingsPath)"
    }
  }

  $groups += [PSCustomObject][ordered]@{
    vendor = 'customendpoint'
    name = $SetupVSCodeProviderName
    apiType = $SetupVSCodeApiType
    models = $script:VSCodeModels
  }

  $stage = "$($script:VSCodeSettingsPath).floway-stage.$PID"
  try {
    # The document carries the API key, so the stage is owner-only before any
    # secret JSON reaches it.
    [System.IO.File]::Create($stage).Dispose()
    Protect-SetupFile $stage
    # A one-element array must still serialize as an array. `-InputObject` keeps
    # the brackets on both versions — measured on 5.1.26100.8875 and pwsh 7.6 —
    # where the pipeline form unwraps a lone object on both and `-AsArray` does
    # not exist on the 5.1 baseline at all.
    #
    # A sibling gateway's group nested deeper than the serializer goes would be
    # emitted as the literal string "@{k=}" with only a warning, and the staged
    # check inspects our own group alone. Losing someone else's provider is not
    # something to do quietly, so the warning is promoted — on pwsh 7. Windows
    # PowerShell 5.1 emits none for the same input, and what refuses such a
    # document there is ConvertFrom-Json's own recursion limit, before the merge
    # runs. jq has no ceiling at all, so the Bash half keeps the group whole;
    # the halves differ in how deep a foreign group may be, not in whether one
    # survives.
    $json = ConvertTo-Json -InputObject @($groups) -Depth 100 -WarningAction Stop
    [System.IO.File]::WriteAllText($stage, $json, (New-Object System.Text.UTF8Encoding($false)))

    # Assertions on the projection above, not gates on operator input: nothing
    # reachable fails them, which is the point — they are what keeps a silently
    # wrong merge from being renamed over the operator's file. The Bash half
    # asserts the same shape; the count here is exact rather than non-zero
    # because a list nested one level deep is a PowerShell failure mode jq has
    # no equivalent of.
    $check = @(ConvertFrom-SetupJsonArray (Get-SetupFileText $stage))
    $ours = @($check | Where-Object { Test-SetupVSCodeOwnGroup $_ })
    if ($ours.Count -ne 1) { Stop-Setup 'the staged VS Code provider list failed validation.' }
    # The exact count, not merely a non-empty list: a model array nested one
    # level deep — what an unenumerated ConvertFrom-Json produces on Windows
    # PowerShell 5.1 — has a count of 1 and would pass an emptiness check while
    # VS Code reads an object where its schema requires a list.
    if (@($ours[0].models).Count -ne $script:VSCodeModels.Count) { Stop-Setup 'the staged VS Code provider list does not carry the projected catalog.' }

    $runningOnWindows = Test-SetupIsWindows
    if ($script:VSCodeSettingsExisted -and $runningOnWindows) {
      Protect-SetupFile $script:VSCodeSettingsPath
      # NullString, not $null: binding $null to a .NET string parameter passes
      # String.Empty, and File.Replace rejects an empty backup path outright.
      [System.IO.File]::Replace($stage, $script:VSCodeSettingsPath, [System.Management.Automation.Language.NullString]::Value)
    } else {
      # No Protect afterwards: the rename carries the stage's own mode, which
      # was restricted before the key was written into it. Re-restricting here
      # would only hide a stage that had not been.
      Move-Item -LiteralPath $stage -Destination $script:VSCodeSettingsPath -Force
    }
    Remove-SetupOlderBackups -Path $script:VSCodeSettingsPath -Keep $script:VSCodeSettingsBackup
  } catch {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force }
    Restore-SetupVSCodeSettings
    throw
  }
  Write-SetupInfo "Configured $($script:VSCodeModels.Count) model(s) in $($script:VSCodeSettingsPath)"
}

# Every installed build and every profile within it is configured in one pass,
# because the operator's active profile is not discoverable from outside the
# editor. Each profile is its own transaction, and a failure does not stop the
# others, so a single hand-edited file cannot leave every remaining profile
# unconfigured. The run still exits non-zero and names what failed.
function Set-SetupAgent {
  Write-SetupAgentNotice 'Configuring' 'VS Code'
  $userDirs = @(Get-SetupVSCodeUserDirs)
  if ($userDirs.Count -eq 0) {
    Stop-Setup 'no VS Code user directory found; install and launch VS Code once, then re-run this command.'
  }
  Get-SetupVSCodeModels
  $failed = 0
  foreach ($userDir in $userDirs) {
    Write-SetupInfo "VS Code user directory: $userDir"
    foreach ($profileDir in Get-SetupVSCodeProfileDirs $userDir) {
      # Any failure is this profile's failure. Stop-Setup has already named the
      # cause and rolled back; anything else — a denied backup, a locked file,
      # a serializer that refused — is named here instead. Gating on
      # 'setup-handled' would let one profile's unexpected fault abort every
      # remaining profile, which is what the Bash half never does: there, every
      # write failure is a counted profile.
      try { Write-SetupVSCodeSettings $profileDir }
      catch {
        if (-not [string]::Equals($_.Exception.Message, 'setup-handled', [System.StringComparison]::Ordinal)) {
          Write-SetupError "could not configure $profileDir`: $(Protect-SetupSecret ([string]$_.Exception.Message))"
        }
        $failed++
      }
    }
  }
  if ($failed -gt 0) {
    Stop-Setup "$failed VS Code profile(s) could not be configured; see the errors above."
  }
  Write-SetupInfo 'Restart VS Code if it is running.'
  Write-SetupAgentNotice 'Completed Agent Setup' 'VS Code'
}


$global:LASTEXITCODE = Main 'VS Code'
