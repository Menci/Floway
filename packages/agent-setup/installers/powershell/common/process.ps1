# Terminate a process and its descendants. PowerShell 7's runtime exposes the
# tree-aware Kill(bool) overload; Windows PowerShell 5.1 uses taskkill /T.
function Stop-SetupProcessTree {
  param([System.Diagnostics.Process]$Process)
  $runningOnWindows = Test-SetupIsWindows
  if ($runningOnWindows) {
    & taskkill.exe /PID $Process.Id /T /F *> $null
    if ($LASTEXITCODE -ne 0 -and (-not $Process.HasExited)) {
      Stop-Setup "taskkill could not terminate process tree $($Process.Id)."
    }
    return
  }
  try {
    $Process.Kill($true)
  } catch {
    if (-not $Process.HasExited) { Stop-Setup "could not terminate process tree $($Process.Id)." }
  }
}

# Windows batch launchers require an interpreter with UseShellExecute disabled.
# Encode literal paths/arguments in a fresh host; both output modes use this boundary.
# https://learn.microsoft.com/en-us/dotnet/fundamentals/runtime-libraries/system-diagnostics-processstartinfo-useshellexecute
function New-SetupProcessStartInfo {
  param([string]$Exe, [string[]]$Arguments)
  if ((Test-SetupIsWindows) -and $Exe -match '\.(cmd|bat)$') {
    $tokens = @($Exe) + $Arguments
    $command = '& ' + (($tokens | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ' ') + '; exit $LASTEXITCODE'
    $Exe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $Arguments = @('-NoProfile', '-NonInteractive', '-EncodedCommand', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command)))
  }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Exe
  # ArgumentList is unavailable in Windows PowerShell 5.1; escape quoted argv
  # including trailing backslashes before constructing Arguments.
  $startInfo.Arguments = ($Arguments | ForEach-Object { '"' + ([Regex]::Replace($_, '\\+(?="|$)', '$0$0')).Replace('"', '\"') + '"' }) -join ' '
  $startInfo.UseShellExecute = $false
  return $startInfo
}

# Inherit stdout/stderr so native updater progress keeps terminal rendering.
function Invoke-SetupLiveProcess {
  param([string]$Exe, [string[]]$Arguments, [int]$TimeoutSeconds, [hashtable]$Environment = @{})
  $startInfo = New-SetupProcessStartInfo -Exe $Exe -Arguments $Arguments
  foreach ($name in $Environment.Keys) { $startInfo.EnvironmentVariables[$name] = $Environment[$name] }
  $startInfo.CreateNoWindow = $false
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { Stop-Setup "failed to start $Exe." }
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-SetupProcessTree $process
    $process.WaitForExit()
    Stop-Setup "$Exe timed out after $TimeoutSeconds seconds."
  }
  if ($process.ExitCode -ne 0) { Stop-Setup "$Exe exited with status $($process.ExitCode)." }
}

# Captured commands are noninteractive and receive EOF. A timeout terminates
# the whole process tree before throwing.
function Invoke-SetupProcess {
  param([string]$Exe, [string[]]$Arguments, [int]$TimeoutSeconds, [string]$TimeoutMessage)
  $startInfo = New-SetupProcessStartInfo -Exe $Exe -Arguments $Arguments
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.RedirectStandardInput = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { Stop-Setup "failed to start $Exe." }
  $process.StandardInput.Close()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-SetupProcessTree $process
    $process.WaitForExit()
    Stop-Setup $(if ($TimeoutMessage) { $TimeoutMessage } else { "$Exe timed out after $TimeoutSeconds seconds." })
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  [PSCustomObject]@{ ExitCode = $process.ExitCode; Output = ($stdout + $stderr) }
}
