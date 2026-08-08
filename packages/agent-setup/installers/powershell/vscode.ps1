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
    return @($env:AGENT_SETUP_TEST_VSCODE_USER_DIR | Where-Object { Test-Path -LiteralPath $_ })
  }
  $base = if (Test-SetupIsWindows) { $env:APPDATA }
    elseif ($IsMacOS) { Join-Path $HOME 'Library/Application Support' }
    elseif ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME }
    else { Join-Path $HOME '.config' }
  @('Code', 'Code - Insiders', 'VSCodium') |
    ForEach-Object { Join-Path (Join-Path $base $_) 'User' } |
    Where-Object { Test-Path -LiteralPath $_ }
}

# A named profile keeps its own copy of the file under an opaque directory, so
# every profile of every build is configured rather than only the default one.
# The id is a hash rather than the display name, so the directories are
# enumerated instead of derived.
function Get-SetupVSCodeProfileDirs {
  param([string]$UserDir)
  $dirs = @($UserDir)
  $profiles = Join-Path $UserDir 'profiles'
  if (Test-Path -LiteralPath $profiles) {
    $dirs += Get-ChildItem -LiteralPath $profiles -Directory | ForEach-Object { $_.FullName }
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
  try { $models = @($SetupVSCodeModels | ConvertFrom-Json) } catch { Stop-Setup 'the embedded VS Code model list is not readable.' }
  if ($models.Count -eq 0) { Stop-Setup 'the gateway advertises no chat models; nothing to configure.' }
  $apiUrl = Get-SetupVSCodeApiUrl
  foreach ($model in $models) {
    $model | Add-Member -NotePropertyName 'url' -NotePropertyValue $apiUrl -Force
    $model | Add-Member -NotePropertyName 'requestHeaders' -NotePropertyValue ([ordered]@{ authorization = "Bearer $SetupApiKey" }) -Force
  }
  $script:VSCodeModels = $models
}

function Restore-SetupVSCodeSettings {
  Restore-SetupManagedFile $script:VSCodeSettingsExisted $script:VSCodeSettingsBackup $script:VSCodeSettingsPath 'file' 'VS Code language models'
}

# Replace this gateway's group in one profile's provider list, leaving every
# other group — including other `customendpoint` gateways — untouched.
function Write-SetupVSCodeSettings {
  param([string]$ProfileDir)
  $script:VSCodeSettingsPath = Join-Path $ProfileDir 'chatLanguageModels.json'
  $script:VSCodeSettingsBackup = $null
  $script:VSCodeSettingsExisted = $false

  $groups = @()
  if (Test-Path -LiteralPath $script:VSCodeSettingsPath) {
    $script:VSCodeSettingsExisted = $true
    $raw = Get-Content -Raw -LiteralPath $script:VSCodeSettingsPath
    # The root shape is decided from the text, not from what ConvertFrom-Json
    # returned: it unwraps a one-element array into a bare object and decodes
    # `[]` to $null, so the decoded value cannot tell an array from an object.
    # jq, which the Bash installer asks the same question, reads the text.
    # Get-Content -Raw yields $null for an empty file, which is not a list
    # either — and dereferencing it would report a PowerShell internal instead.
    if ($null -eq $raw -or -not $raw.TrimStart().StartsWith('[')) {
      Stop-Setup "$($script:VSCodeSettingsPath) is not a provider list; leaving it untouched."
    }
    # An empty list is recognized from the text rather than from the decode.
    # ConvertFrom-Json yields nothing for `[]` and a literal $null for `[null]`
    # on PowerShell 7, and the two are not reliably distinguishable on the 5.1
    # baseline — where telling them apart matters, because `[]` is a list VS
    # Code itself writes and `[null]` is not a provider list at all.
    if ($raw -match '^\s*\[\s*\]\s*$') {
      $parsed = @()
    } else {
      try { $parsed = @($raw | ConvertFrom-Json) } catch { Stop-Setup "$($script:VSCodeSettingsPath) is not valid JSON; leaving it untouched." }
    }
    # Every element must be an object, matching the Bash gate: jq's merge
    # indexes `.vendor` on each one and aborts on a scalar, so without this the
    # same document would be rewritten here and refused there.
    if (@($parsed | Where-Object { $_ -isnot [System.Management.Automation.PSCustomObject] }).Count -gt 0) {
      Stop-Setup "$($script:VSCodeSettingsPath) is not a provider list; leaving it untouched."
    }
    $groups = @($parsed | Where-Object { -not (($_.vendor -ceq 'customendpoint') -and ($_.name -ceq $SetupVSCodeProviderName)) })

    $stamp = [long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds
    $script:VSCodeSettingsBackup = "$($script:VSCodeSettingsPath).floway-backup.$stamp.$PID"
    try {
      Copy-Item -LiteralPath $script:VSCodeSettingsPath -Destination $script:VSCodeSettingsBackup
      Protect-SetupFile $script:VSCodeSettingsBackup
    } catch {
      if (Test-Path -LiteralPath $script:VSCodeSettingsBackup) { Remove-Item -LiteralPath $script:VSCodeSettingsBackup -Force }
      $script:VSCodeSettingsBackup = $null
      throw
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
    # A one-element array must still serialize as an array, and `-AsArray` does
    # not exist on the Windows PowerShell 5.1 baseline, so the brackets are
    # restored by hand when ConvertTo-Json unwraps a lone object.
    $json = ConvertTo-Json -InputObject @($groups) -Depth 100
    if (-not $json.TrimStart().StartsWith('[')) { $json = "[$json]" }
    [System.IO.File]::WriteAllText($stage, $json, (New-Object System.Text.UTF8Encoding($false)))

    $check = @(Get-Content -Raw -LiteralPath $stage | ConvertFrom-Json)
    $ours = @($check | Where-Object { ($_.vendor -ceq 'customendpoint') -and ($_.name -ceq $SetupVSCodeProviderName) })
    if ($ours.Count -ne 1) { Stop-Setup 'the staged VS Code provider list failed validation.' }
    if (@($ours[0].models).Count -eq 0) { Stop-Setup 'the staged VS Code provider list carries no models.' }

    $runningOnWindows = Test-SetupIsWindows
    if ($script:VSCodeSettingsExisted -and $runningOnWindows) {
      Protect-SetupFile $script:VSCodeSettingsPath
      # NullString, not $null: binding $null to a .NET string parameter passes
      # String.Empty, and File.Replace rejects an empty backup path outright.
      [System.IO.File]::Replace($stage, $script:VSCodeSettingsPath, [System.Management.Automation.Language.NullString]::Value)
    } else {
      Move-Item -LiteralPath $stage -Destination $script:VSCodeSettingsPath -Force
      Protect-SetupFile $script:VSCodeSettingsPath
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
      # Stop-Setup throws 'setup-handled' once the profile has reported itself
      # and rolled back; anything else is a fault this fragment cannot describe.
      try { Write-SetupVSCodeSettings $profileDir }
      catch {
        if ($_.Exception.Message -cne 'setup-handled') { throw }
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
