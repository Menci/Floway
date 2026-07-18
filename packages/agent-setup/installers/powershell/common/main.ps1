# --- run --------------------------------------------------------------------

function Main {
  param([string]$AgentName)
  $ErrorActionPreference = 'Stop'
  # Keep native command failures from auto-throwing on PowerShell 7.3+ so the
  # explicit exit-code checks remain authoritative across versions.
  $PSNativeCommandUseErrorActionPreference = $false

  Remove-Item Env:SETUP_API_KEY -ErrorAction SilentlyContinue

  try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
  $script:SetupNoColor = [bool]$env:NO_COLOR
  $script:SetupForceColor = [bool]$env:AGENT_SETUP_TEST_FORCE_COLOR
  $script:SetupErrColor = (-not [Console]::IsErrorRedirected) -and (-not $script:SetupNoColor)
  $script:SetupEsc = [char]27
  $supportsVt = try { [bool]$Host.UI.SupportsVirtualTerminal } catch { $false }
  $script:SetupOutAnsi = $supportsVt -and (-not [Console]::IsOutputRedirected) -and (-not $script:SetupNoColor)

  Write-SetupAgentNotice 'Agent Setup' $AgentName
  if ([string]::IsNullOrWhiteSpace($SetupEndpoint)) {
    Write-SetupError "`$SetupEndpoint must be set to this gateway origin (e.g. https://gateway.example)."
    return 1
  }
  if ($SetupEndpoint -notmatch '^https?://.+') {
    Write-SetupError "`$SetupEndpoint must be an http(s) origin, got $SetupEndpoint"
    return 1
  }
  Write-SetupMetadata 'Endpoint' $SetupEndpoint
  Write-SetupMetadata 'API Key' $SetupApiKeyName

  # Detection sites rethrow reported failures as the `setup-handled` sentinel;
  # only unexpected exceptions are reported again here after redaction.
  try {
    Set-SetupAgent
  } catch {
    if ($_.Exception.Message -ne 'setup-handled') { Write-SetupError (Protect-SetupSecret ([string]$_.Exception.Message)) }
    return 1
  }
  return 0
}
