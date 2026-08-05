Add-Type -AssemblyName System.Net.Http

function Install-SetupHomebrewCask {
  param([string]$Cask)
  $brew = Get-Command brew -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $brew) { Stop-Setup 'Homebrew is required to install agent CLIs on macOS.' }
  $timeoutSeconds = Get-SetupTimeoutSeconds 600
  Invoke-SetupLiveProcess -Exe $brew.Source -Arguments @('install', '--cask', $Cask) -TimeoutSeconds $timeoutSeconds
}

# npm on Windows is commonly a .cmd launcher, which ProcessStartInfo cannot
# execute directly with UseShellExecute disabled. A fresh copy of the current
# PowerShell host resolves that launcher while preserving inherited terminal
# output and the same process-tree timeout.
function Install-SetupNpmPackage {
  param([string]$Package)
  $npm = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $npm) { Stop-Setup 'npm was selected for installation but is no longer available.' }
  $hostCommand = Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $hostExe = if ($hostCommand) { $hostCommand.Source } else { [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName }
  $npmLiteral = "'" + $npm.Source.Replace("'", "''") + "'"
  $packageLiteral = "'" + $Package.Replace("'", "''") + "'"
  $command = "& $npmLiteral install --global $packageLiteral; exit `$LASTEXITCODE"
  $timeoutSeconds = Get-SetupTimeoutSeconds 600
  Invoke-SetupLiveProcess -Exe $hostExe -Arguments @('-NoProfile', '-NonInteractive', '-Command', $command) -TimeoutSeconds $timeoutSeconds
}

# Execute a downloaded installer in a fresh interpreter. The script travels
# through stdin, while the API key exists only as a variable in this parent
# process and its identically named environment variables were removed. The
# official installer therefore cannot read the credential.
function Invoke-SetupInterpreterBody {
  param([string]$Body, [int]$TimeoutSeconds, [string]$Exe, [string]$Arguments)
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Exe
  $startInfo.Arguments = $Arguments
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $false
  $startInfo.RedirectStandardInput = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { Stop-Setup "failed to start the installer interpreter." }
  $deadline = [System.Diagnostics.Stopwatch]::StartNew()
  $timeoutMilliseconds = [Math]::Min([long][int]::MaxValue, [Math]::Max([long]0, [long]$TimeoutSeconds * 1000))
  $timedOut = $false
  try {
    $write = $process.StandardInput.WriteLineAsync($Body)
    $remaining = [Math]::Max([long]0, $timeoutMilliseconds - [long]$deadline.ElapsedMilliseconds)
    if (-not $write.Wait([int]$remaining)) {
      $timedOut = $true
    } else {
      $process.StandardInput.Close()
      $remaining = [Math]::Max([long]0, $timeoutMilliseconds - [long]$deadline.ElapsedMilliseconds)
      if (-not $process.WaitForExit([int]$remaining)) { $timedOut = $true }
    }
  } catch {
    Stop-SetupProcessTree $process
    $process.WaitForExit()
    throw
  }
  if ($timedOut) {
    Stop-SetupProcessTree $process
    $process.WaitForExit()
    try { $process.StandardInput.Close() } catch { }
    Stop-Setup "the installer timed out after $TimeoutSeconds seconds."
  }
  if ($process.ExitCode -ne 0) { Stop-Setup "the installer exited with status $($process.ExitCode)." }
}

function Invoke-SetupPowerShellBody {
  param([string]$Body, [int]$TimeoutSeconds, [switch]$BypassExecutionPolicy)
  $pwsh = Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $exe = if ($pwsh) { $pwsh.Source } else { [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName }
  $executionPolicy = if ($BypassExecutionPolicy) { '-ExecutionPolicy Bypass ' } else { '' }
  Invoke-SetupInterpreterBody -Body $Body -TimeoutSeconds $TimeoutSeconds -Exe $exe -Arguments "-NoProfile -NonInteractive ${executionPolicy}-Command -"
}

function Invoke-SetupShellBody {
  param([string]$Body, [int]$TimeoutSeconds)
  $bash = Get-Command bash -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $bash) { Stop-Setup 'bash is required to run the official installer on macOS and Linux.' }
  Invoke-SetupInterpreterBody -Body $Body -TimeoutSeconds $TimeoutSeconds -Exe $bash.Source -Arguments '-s'
}

function Get-SetupRemoteInstaller {
  param([string]$Uri)
  $maxBytes = if ($env:AGENT_SETUP_TEST_DOWNLOAD_MAX_BYTES) { [int]$env:AGENT_SETUP_TEST_DOWNLOAD_MAX_BYTES } else { 8388608 }
  $handler = New-Object System.Net.Http.HttpClientHandler
  $client = New-Object System.Net.Http.HttpClient($handler)
  $cancellation = New-Object System.Threading.CancellationTokenSource
  $cancellation.CancelAfter([TimeSpan]::FromSeconds(60))
  $response = $null
  $stream = $null
  $content = New-Object System.IO.MemoryStream
  try {
    # ResponseHeadersRead plus the same cancellation token on every stream read
    # bounds memory and wall time before an installer body can execute.
    # https://learn.microsoft.com/dotnet/api/system.net.http.httpcompletionoption
    $response = $client.GetAsync(
      $Uri,
      [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead,
      $cancellation.Token
    ).GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode()
    $declaredLength = $response.Content.Headers.ContentLength
    if (($null -ne $declaredLength) -and ($declaredLength -gt $maxBytes)) {
      Stop-Setup 'the installer download exceeded the 8 MiB size limit.'
    }
    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $buffer = New-Object byte[] 81920
    while ($true) {
      $read = $stream.ReadAsync($buffer, 0, $buffer.Length, $cancellation.Token).GetAwaiter().GetResult()
      if ($read -eq 0) { break }
      if (($content.Length + $read) -gt $maxBytes) {
        Stop-Setup 'the installer download exceeded the 8 MiB size limit.'
      }
      $content.Write($buffer, 0, $read)
    }
    $encoding = New-Object System.Text.UTF8Encoding($false, $true)
    $charset = $response.Content.Headers.ContentType.CharSet
    if ($charset) {
      try { $encoding = [System.Text.Encoding]::GetEncoding($charset.Trim('"')) } catch { }
    }
    $body = $encoding.GetString($content.ToArray())
    if (($body.Length -gt 0) -and ([int]$body[0] -eq 0xfeff)) { $body = $body.Substring(1) }
    [PSCustomObject]@{
      Body = $body
      ContentType = [string]$response.Content.Headers.ContentType
    }
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
    $content.Dispose()
    $cancellation.Dispose()
    $client.Dispose()
    $handler.Dispose()
  }
}

# Download an installer, refuse anything that is not a script (region blocks and
# captive portals serve HTML in place of the installer), then run it.
function Invoke-SetupRemoteInstaller {
  param([string]$Uri, [switch]$BypassExecutionPolicy, [switch]$Shell)
  $response = Get-SetupRemoteInstaller $Uri
  $body = $response.Body
  $contentType = $response.ContentType
  $looksLikeHtml = $contentType -match '(?i)^text/html(?:;|$)' -or $body -match '(?is)^\s*(?:<!doctype\s+html|<html(?:\s|>))'
  if ([string]::IsNullOrWhiteSpace($body) -or $looksLikeHtml) {
    Stop-Setup "the installer download was HTML or empty, not an executable script (a login or region-block page?)."
  }
  $timeoutSeconds = Get-SetupTimeoutSeconds 120
  if ($Shell) { Invoke-SetupShellBody -Body $body -TimeoutSeconds $timeoutSeconds }
  else { Invoke-SetupPowerShellBody -Body $body -TimeoutSeconds $timeoutSeconds -BypassExecutionPolicy:$BypassExecutionPolicy }
}

function Test-SetupApplicationFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  if (Test-SetupIsWindows) {
    $extension = [System.IO.Path]::GetExtension($Path)
    return ($extension -ieq '.exe') -or ($extension -ieq '.com')
  }
  $testExe = if ([System.IO.File]::Exists('/usr/bin/test')) { '/usr/bin/test' }
    elseif ([System.IO.File]::Exists('/bin/test')) { '/bin/test' }
    else { Stop-Setup 'the platform has no executable-file test utility.' }
  & $testExe -x $Path
  return $LASTEXITCODE -eq 0
}

function Get-SetupCliExe {
  param([string]$Name, [string]$Label, [string[]]$Candidates)
  $found = New-Object System.Collections.Generic.List[string]
  $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { $found.Add($command.Source) }
  foreach ($candidate in $Candidates) {
    if ((Test-SetupApplicationFile $candidate) -and (-not $found.Contains($candidate))) { $found.Add($candidate) }
  }
  if ($found.Count -eq 0) { return $null }
  if ($found.Count -gt 1) { Write-SetupWarn "multiple $Label installations detected; using $($found[0])" }
  return $found[0]
}
