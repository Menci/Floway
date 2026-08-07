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
function Get-SetupZedConfigDir {
  if ($env:ZED_CONFIG_DIR_OVERRIDE) { return $env:ZED_CONFIG_DIR_OVERRIDE }
  if (Test-SetupIsWindows) { return (Join-Path $env:APPDATA 'Zed') }
  if ($env:XDG_CONFIG_HOME) { return (Join-Path $env:XDG_CONFIG_HOME 'zed') }
  Join-Path $HOME '.config/zed'
}

function Assert-SetupZedConfigDir {
  $script:ZedConfigDir = Get-SetupZedConfigDir
  if (-not (Test-Path -LiteralPath $script:ZedConfigDir)) {
    Stop-Setup "no Zed configuration directory at $($script:ZedConfigDir); install and launch Zed once, then re-run this command."
  }
  Write-SetupInfo "Zed configuration directory: $($script:ZedConfigDir)"
}

# Zed's `anthropic_compatible` provider has no model-discovery path — its
# `available_models` is a required array — so the catalog is snapshotted here
# and the operator re-runs this command after changing it upstream.
function Get-SetupZedModels {
  $uri = "$SetupEndpoint/v1/models"
  try {
    $response = Invoke-RestMethod -Uri $uri -Method Get -Headers @{ Authorization = "Bearer $SetupApiKey" } -TimeoutSec 60
  } catch {
    Stop-Setup "could not fetch the model catalog from $uri"
  }

  # Chat models only, keyed on `kind` rather than on `endpoints`: the endpoint
  # map describes the upstream wire surface, and translation lets any chat model
  # serve a Messages request regardless of which key it advertises.
  $models = @()
  foreach ($model in $response.data) {
    if ($model.kind -cne 'chat') { continue }

    $contextWindow = $model.limits.max_context_window_tokens
    if (-not $contextWindow) { $contextWindow = $model.limits.max_prompt_tokens }
    if (-not $contextWindow) { $contextWindow = 200000 }

    $inputModalities = @($model.chat.modalities.input)
    # `tools` is always true — a model that cannot call tools is not one anyone
    # would route here. `prompt_caching` is on because Zed defaults it off,
    # which suppresses cache_control breakpoints entirely; enabled, it sends
    # explicit per-message breakpoints marking where the stable prefix ends.
    $entry = [ordered]@{
      name = $model.id
      display_name = $model.display_name
      max_tokens = $contextWindow
      capabilities = [ordered]@{
        tools = $true
        images = ($inputModalities -ccontains 'image')
        prompt_caching = $true
      }
    }
    if ($model.limits.max_output_tokens) { $entry.max_output_tokens = $model.limits.max_output_tokens }

    $reasoning = $model.chat.reasoning
    if ($reasoning) {
      if ($reasoning.adaptive) {
        $entry.mode = [ordered]@{ type = 'adaptive' }
      } elseif ($reasoning.budget_tokens.max) {
        $entry.mode = [ordered]@{ type = 'thinking'; budget_tokens = $reasoning.budget_tokens.max }
      } else {
        $entry.mode = [ordered]@{ type = 'thinking' }
      }
    }
    $models += [PSCustomObject]$entry
  }

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
    try { $document = $raw | ConvertFrom-Json } catch { Stop-Setup "$($script:ZedSettingsPath) is not valid JSON; leaving it untouched." }
    if ($document -isnot [System.Management.Automation.PSCustomObject]) { Stop-Setup 'existing Zed global settings root is not a JSON object.' }
    if (($document.PSObject.Properties.Name -contains 'language_models') -and ($document.language_models -isnot [System.Management.Automation.PSCustomObject])) {
      Stop-Setup 'existing Zed language_models is not a JSON object.'
    }
    $stamp = [long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds
    $script:ZedSettingsBackup = "$($script:ZedSettingsPath).floway-backup.$stamp.$PID"
    Copy-Item -LiteralPath $script:ZedSettingsPath -Destination $script:ZedSettingsBackup
  } else {
    $document = [PSCustomObject]@{}
  }

  if ($document.PSObject.Properties.Name -notcontains 'language_models') {
    $document | Add-Member -NotePropertyName language_models -NotePropertyValue ([PSCustomObject]@{})
  }
  if ($document.language_models.PSObject.Properties.Name -notcontains 'anthropic_compatible') {
    $document.language_models | Add-Member -NotePropertyName anthropic_compatible -NotePropertyValue ([PSCustomObject]@{})
  } elseif ($document.language_models.anthropic_compatible -isnot [System.Management.Automation.PSCustomObject]) {
    Stop-Setup 'existing Zed anthropic_compatible is not a JSON object.'
  }
  Set-SetupProp $document.language_models.anthropic_compatible $SetupZedProviderName ([PSCustomObject]@{
    api_url = Get-SetupZedApiUrl
    available_models = $script:ZedModels
  })

  $stage = "$($script:ZedSettingsPath).floway-stage.$PID"
  try {
    $json = $document | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText($stage, $json, (New-Object System.Text.UTF8Encoding($false)))
    $check = Get-Content -Raw -LiteralPath $stage | ConvertFrom-Json
    if ($check.language_models.anthropic_compatible.$SetupZedProviderName.api_url -cne (Get-SetupZedApiUrl)) {
      Stop-Setup 'staged Zed global settings failed validation.'
    }
    Move-Item -LiteralPath $stage -Destination $script:ZedSettingsPath -Force
  } catch {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force }
    Restore-SetupZedSettings
    throw
  }
  Remove-SetupOlderBackups $script:ZedSettingsPath $script:ZedSettingsBackup
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
      Marshal.FreeHGlobal(blob);
    }
  }
}
'@

function Set-SetupZedCredentialWindows {
  Add-Type -TypeDefinition $SetupZedCredWriteSource -ErrorAction Stop
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($SetupApiKey)
  [FlowayZedCredential]::Write("zed:url=$(Get-SetupZedApiUrl)", 'Bearer', $bytes)
}

# The Secret Service label is matched exactly on read, so it is a fixed literal
# rather than anything derived from the provider name.
# Ref: https://github.com/zed-industries/zed/issues/43671
function Set-SetupZedCredentialSecretService {
  if (-not (Get-Command secret-tool -ErrorAction SilentlyContinue)) {
    Stop-Setup 'secret-tool is unavailable; install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch) and re-run.'
  }
  $apiUrl = Get-SetupZedApiUrl
  # A prior entry is cleared first: secret-tool appends rather than replaces,
  # and Zed filters on `url` before comparing labels, so duplicates accumulate.
  & secret-tool clear url $apiUrl username Bearer 2>$null
  $SetupApiKey | & secret-tool store --label='zed-github-account' url $apiUrl username Bearer
  if ($LASTEXITCODE -ne 0) { Stop-Setup 'secret-tool could not store the API key.' }
}

function Set-SetupZedCredentialMacOS {
  & security add-internet-password -s (Get-SetupZedApiUrl) -a Bearer -w $SetupApiKey -U -T /Applications/Zed.app 2>$null
  if ($LASTEXITCODE -ne 0) { Stop-Setup 'the security command could not store the API key.' }
}

function Set-SetupZedCredential {
  # The harness records the call instead of writing a real credential store,
  # which no test host can be asked to mutate.
  if ($env:AGENT_SETUP_TEST_CREDENTIAL_RECORD) {
    [System.IO.File]::WriteAllText($env:AGENT_SETUP_TEST_CREDENTIAL_RECORD, "$(Get-SetupZedApiUrl)`t$SetupApiKey`n")
    return
  }
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
